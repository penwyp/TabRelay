import type {
  Snapshot,
  Settings,
  WorkspaceWindow,
  Plan,
  Selection,
} from "./types";
declare const __TABRELAY_TEST__: boolean;
export const LIMITS = {
  bytes: 5_000_000,
  windows: 30,
  tabs: 1500,
  groups: 500,
  title: 1000,
  url: 16000,
};
export const DEFAULT_SETTINGS: Settings = {
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
    value.schemaVersion !== 1 ||
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
  return structuredClone(value) as unknown as Snapshot;
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
    new TextEncoder().encode(JSON.stringify(value)),
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
export function checkSettings(raw: Settings): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  s.deviceName = s.deviceName.trim().slice(0, 80) || "我的设备";
  if (s.endpoint) {
    const u = new URL(s.endpoint);
    if (
      (u.protocol !== "https:" &&
        !(
          typeof __TABRELAY_TEST__ !== "undefined" &&
          __TABRELAY_TEST__ &&
          u.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(u.hostname)
        )) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw Error("WebDAV 必须使用 HTTPS，且地址不能包含凭据、查询或片段");
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
