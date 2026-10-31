import type {
  Snapshot,
  Settings,
  WorkspaceWindow,
  Plan,
  Selection,
} from "./types";
export const LIMITS = {
  bytes: 5_000_000,
  windows: 30,
  tabs: 1500,
  groups: 500,
  title: 1000,
  url: 16000,
};
export const DEFAULT_SETTINGS: Settings = {
  syncIntervalMinutes: 10,
  contentEnabled: false,
  contentOrigins: [],
  endpoint: "",
  username: "",
  password: "",
  deviceName: "我的设备",
  enabled: false,
  blacklist: [],
  stripParams: [
    "access_token",
    "token",
    "auth",
    "code",
    "password",
    "secret",
    "session",
  ],
  historyLimit: 20,
  encryptionPassphrase: "",
};
export function safeUrl(
  input: unknown,
  settings?: Pick<Settings, "blacklist" | "stripParams">,
): string | null {
  if (typeof input !== "string" || input.length > LIMITS.url) return null;
  try {
    const u = new URL(input);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
      return null;
    if (
      settings?.blacklist.some((d) => {
        d = d.trim().toLowerCase().replace(/^\*\./, "");
        return d && (u.hostname === d || u.hostname.endsWith("." + d));
      })
    )
      return null;
    for (const p of [...u.searchParams.keys()])
      if (
        settings?.stripParams.some((x) => x.toLowerCase() === p.toLowerCase())
      )
        u.searchParams.delete(p);
    return u.href;
  } catch {
    return null;
  }
}
const obj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown, max = 256): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= max;
export function validateSnapshot(value: unknown): Snapshot {
  if (
    !obj(value) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > LIMITS.bytes
  )
    throw Error("快照格式无效或超过 5 MB 限制");
  if (
    ![1, 2].includes(Number(value.schemaVersion)) ||
    !str(value.deviceId) ||
    !str(value.snapshotId) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !str(value.capturedAt) ||
    !Number.isFinite(Date.parse(value.capturedAt))
  )
    throw Error("快照协议、身份或版本无效");
  if (!Array.isArray(value.windows) || value.windows.length > LIMITS.windows)
    throw Error("窗口数量超限");
  let count = 0,
    groups = 0;
  const keys = new Set<string>();
  const windowKeys = new Set<string>();
  const allGroupKeys = new Set<string>();
  for (const w of value.windows) {
    if (
      !obj(w) ||
      !str(w.windowKey) ||
      windowKeys.has(w.windowKey) ||
      !Number.isSafeInteger(w.order) ||
      !Array.isArray(w.tabs) ||
      !Array.isArray(w.groups)
    )
      throw Error("窗口结构无效");
    windowKeys.add(w.windowKey);
    const gk = new Set<string>();
    groups += w.groups.length;
    for (const g of w.groups) {
      if (
        !obj(g) ||
        !str(g.groupKey) ||
        gk.has(g.groupKey) ||
        allGroupKeys.has(g.groupKey) ||
        typeof g.title !== "string" ||
        g.title.length > LIMITS.title ||
        ![
          "grey",
          "blue",
          "red",
          "yellow",
          "green",
          "pink",
          "purple",
          "cyan",
          "orange",
        ].includes(String(g.color)) ||
        typeof g.collapsed !== "boolean"
      )
        throw Error("标签组结构无效");
      gk.add(g.groupKey);
      allGroupKeys.add(g.groupKey);
    }
    for (const t of w.tabs) {
      count++;
      if (
        !obj(t) ||
        !str(t.tabKey) ||
        keys.has(t.tabKey) ||
        !str(t.url, LIMITS.url) ||
        typeof t.title !== "string" ||
        t.title.length > LIMITS.title ||
        !Number.isSafeInteger(t.index) ||
        Number(t.index) < 0 ||
        typeof t.pinned !== "boolean" ||
        !obj(t.origin) ||
        !str(t.origin.deviceId) ||
        !str(t.origin.tabKey) ||
        (t.groupKey !== undefined &&
          (!str(t.groupKey) || !gk.has(t.groupKey))) ||
        (t.pinned && t.groupKey)
      )
        throw Error("标签结构或来源无效");
      keys.add(t.tabKey);
    }
    const indices = new Set<number>();
    const endedGroups = new Set<string>();
    let lastGroup: string | undefined;
    let unpinned = false;
    for (const t of [...w.tabs].sort((a: any, b: any) => a.index - b.index)) {
      if (indices.has(t.index)) throw Error("标签顺序重复");
      indices.add(t.index);
      if (t.pinned && unpinned) throw Error("置顶标签顺序无效");
      if (!t.pinned) unpinned = true;
      if (lastGroup !== t.groupKey) {
        if (lastGroup) endedGroups.add(lastGroup);
        if (t.groupKey && endedGroups.has(t.groupKey))
          throw Error("标签组成员必须连续");
        lastGroup = t.groupKey;
      }
    }
    if (
      w.activeTabKey !== undefined &&
      (!str(w.activeTabKey) ||
        !w.tabs.some((t: any) => t.tabKey === w.activeTabKey))
    )
      throw Error("活动标签引用无效");
  }
  if (count > LIMITS.tabs || groups > LIMITS.groups)
    throw Error("标签或标签组数量超限");
  const result = structuredClone(value) as unknown as Snapshot;
  for (const w of result.windows)
    for (const t of w.tabs) {
      if (t.content) {
        if (
          ![
            "available",
            "truncated",
            "disabled",
            "permission-denied",
            "unavailable",
          ].includes(t.content.status) ||
          (["available", "truncated"].includes(t.content.status) &&
            !validTextRef(t.content.ref, t.url))
        ) {
          t.content = {
            status: "unavailable",
            reason: "正文引用缺失、无效或与标签URL不符",
          };
        } else {
          const ref = t.content.ref;
          t.content = {
            status: t.content.status,
            ...(typeof t.content.reason === "string"
              ? { reason: t.content.reason.slice(0, 400) }
              : {}),
            ...(["available", "truncated"].includes(t.content.status) &&
            validTextRef(ref, t.url)
              ? {
                  ref: {
                    ownerDeviceId: ref.ownerDeviceId,
                    objectId: ref.objectId,
                    bytes: ref.bytes,
                    observedAt: ref.observedAt,
                    captureUrl: ref.captureUrl,
                  },
                }
              : {}),
          };
        }
      }
    }
  return result;
}
export function contentIdentity(t: {
  url: string;
  origin: { deviceId: string; tabKey: string };
}): string {
  return JSON.stringify([t.origin.deviceId, t.origin.tabKey, t.url]);
}
export async function hash(value: unknown): Promise<string> {
  const b = await crypto.subtle.digest(
    "SHA-256",
    // Chrome storage may reorder dictionary keys. Hash semantic JSON structure,
    // preserving array order and all values rather than serialization order.
    new TextEncoder().encode(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    ),
  );
  return [...new Uint8Array(b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function snapshotHash(snapshot: Snapshot) {
  return hash(snapshot.windows);
}
export async function makePlan(
  raw: unknown,
  current: Snapshot,
  selection: Selection = {},
  extraUrlDedup = false,
  privacy?: Pick<Settings, "blacklist" | "stripParams">,
): Promise<Plan> {
  const snapshot = validateSnapshot(raw),
    all =
      !selection.windowKeys?.length &&
      !selection.groupKeys?.length &&
      !selection.tabKeys?.length;
  const origins = new Set(
      current.windows.flatMap((w) => w.tabs.map(contentIdentity)),
    ),
    urls = new Set(current.windows.flatMap((w) => w.tabs.map((t) => t.url)));
  const skipped: Plan["skipped"] = [];
  const windows: WorkspaceWindow[] = [];
  for (const w of snapshot.windows) {
    const tabs = w.tabs
      .map((t) => ({ ...t }))
      .filter(
        (t) =>
          all ||
          selection.windowKeys?.includes(w.windowKey) ||
          selection.tabKeys?.includes(t.tabKey) ||
          (t.groupKey && selection.groupKeys?.includes(t.groupKey)),
      )
      .filter((t) => {
        let reason = "";
        const clean = safeUrl(t.url, privacy);
        if (!clean) reason = "不允许的 URL、凭据或域名黑名单";
        else t.url = clean;
        if (!reason && origins.has(contentIdentity(t)))
          reason = "本机已有相同来源与内容";
        else if (!reason && extraUrlDedup && urls.has(t.url))
          reason = "按 URL 去重";
        if (reason) {
          skipped.push({ title: t.title, reason });
          return false;
        }
        return true;
      });
    if (tabs.length)
      windows.push({
        ...w,
        tabs: tabs.sort((a, b) => a.index - b.index),
        groups: w.groups.filter((g) =>
          tabs.some((t) => t.groupKey === g.groupKey),
        ),
      });
  }
  return {
    id: crypto.randomUUID(),
    snapshot,
    windows,
    skipped,
    existingWindows: current.windows.length,
    fingerprint: await hash(snapshot),
    createdAt: new Date().toISOString(),
  };
}
export function readableSnapshotId(date: Date, revision: number): string {
  return (
    date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15) +
    "Z-r" +
    String(revision).padStart(12, "0")
  );
}
export function validTextRef(
  ref: unknown,
  url?: string,
): ref is import("./types").TextRef {
  return (
    obj(ref) &&
    typeof ref.ownerDeviceId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ref.ownerDeviceId) &&
    typeof ref.objectId === "string" &&
    /^[a-f0-9]{64}$/.test(ref.objectId) &&
    Number.isSafeInteger(ref.bytes) &&
    Number(ref.bytes) >= 0 &&
    Number(ref.bytes) <= 60000 &&
    typeof ref.observedAt === "string" &&
    Number.isFinite(Date.parse(ref.observedAt)) &&
    typeof ref.captureUrl === "string" &&
    safeUrl(ref.captureUrl) === ref.captureUrl &&
    (!url || ref.captureUrl === url)
  );
}
export function checkSettings(raw: Settings): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  if (![5, 10, 30, 60, 1440].includes(Number(s.syncIntervalMinutes)))
    throw Error("同步间隔必须为5/10/30分钟、1小时或1天");
  s.contentEnabled = s.contentEnabled === true;
  if (!Array.isArray(s.contentOrigins) || s.contentOrigins.length > 100)
    throw Error("正文站点授权数量无效");
  s.contentOrigins = [
    ...new Set(
      s.contentOrigins.map((value) => {
        const u = new URL(String(value));
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          u.pathname !== "/" ||
          u.hostname.includes("*")
        )
          throw Error("正文站点必须是明确HTTP/HTTPS origin，不含路径或凭据");
        return u.origin;
      }),
    ),
  ];
  s.deviceName = s.deviceName.trim().slice(0, 80) || "我的设备";
  if (s.endpoint) {
    const u = new URL(s.endpoint);
    if (
      !["https:", "http:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw Error(
        "WebDAV 必须使用 HTTP 或 HTTPS，且地址不能包含凭据、查询或片段",
      );
    if (u.protocol === "http:" && s.httpAcknowledgedOrigin !== u.origin)
      throw Error(
        "HTTP 会明文传输账号、密码与标签数据，请在设置中明确确认此主机的风险",
      );
    if (u.protocol === "https:") s.httpAcknowledgedOrigin = undefined;
    s.endpoint = u.href.endsWith("/") ? u.href : u.href + "/";
  } else if (s.enabled) throw Error("请先配置 WebDAV 地址");
  if (
    !Array.isArray(s.blacklist) ||
    !Array.isArray(s.stripParams) ||
    s.blacklist.length > 200 ||
    s.stripParams.length > 200
  )
    throw Error("隐私规则过多");
  s.blacklist = s.blacklist.map((x) => String(x).trim()).filter(Boolean);
  s.stripParams = s.stripParams.map((x) => String(x).trim()).filter(Boolean);
  s.historyLimit = Math.max(
    1,
    Math.min(100, Math.floor(Number(s.historyLimit) || 20)),
  );
  return s;
}
