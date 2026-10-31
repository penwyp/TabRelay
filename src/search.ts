import {
  readSearchStore,
  writeSearchStore,
  clearSearchStore,
  estimateSearchStoreBytes,
  SEARCH_STORE_BYTES,
  SearchStoreError,
  searchStoreGeneration,
} from "./search-store";
import { hash, safeUrl, validateSnapshot } from "./model";
import { load } from "./state";
import type { Settings, Snapshot, TabContent, TextRef } from "./types";
import { WebDAVError, WebDAVRepository } from "./webdav";

export type SearchSource = {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: "current" | "recovery" | "history";
  historyId?: string;
  snapshot?: Snapshot;
  status: "loaded" | "failed" | "not-loaded";
  error?: string;
  errorCode?: string;
  loadedAt?: string;
  capturedAt?: string;
  stale?: boolean;
};
export type SearchCache = {
  generation: number;
  loading: boolean;
  cancelled: boolean;
  paused: boolean;
  includeHistory: boolean;
  sources: SearchSource[];
  devicesTotal: number;
  devicesLoaded: number;
  completed: number;
  total: number;
  truncated: boolean;
  bodyLoaded: number;
  bodyMissing: number;
  bodyTruncated: number;
  error?: string;
  updatedAt?: string;
  refreshedAt?: string;
  earliestObservedAt?: string;
};
export type SearchFilters = {
  deviceId?: string;
  domain?: string;
  kind?: "current" | "history";
  pinned?: boolean;
  group?: string;
  after?: string;
  before?: string;
};
export type SearchResult = {
  id: string;
  sourceId: string;
  deviceId: string;
  deviceName: string;
  kind: SearchSource["kind"];
  capturedAt: string;
  windowKey: string;
  tabKey: string;
  title: string;
  url: string;
  domain: string;
  pinned: boolean;
  groupKey?: string;
  groupTitle?: string;
  stale: boolean;
  bodySnippet?: string;
  contentStatus?: string;
  contentReason?: string;
  occurrences?: SearchResult[];
};
type BodyEntry = {
  text?: string;
  identity?: string;
  status: "loaded" | "missing" | "truncated";
  reason?: string;
};
type StoredCache = SearchCache & {
  configFingerprint?: string;
  bodies: Record<string, BodyEntry>;
};
type InternalResult = SearchResult & {
  bodyText?: string;
  bodyIdentity: string;
};
export const SEARCH_LIMITS = {
  snapshots: 2000,
  tabs: 200_000,
  sources: 2000,
  bytes: SEARCH_STORE_BYTES,
};
const CACHE_KEY = "searchCache",
  PAUSE_KEY = "searchAutoPaused",
  FRESH_MS = 5 * 60_000;
let token = 0,
  running = false;
let queue: Promise<unknown> = Promise.resolve();
const empty = (generation = 0, paused = false): StoredCache => ({
  generation,
  loading: false,
  cancelled: false,
  paused,
  includeHistory: true,
  sources: [],
  bodies: {},
  devicesTotal: 0,
  devicesLoaded: 0,
  completed: 0,
  total: 0,
  truncated: false,
  bodyLoaded: 0,
  bodyMissing: 0,
  bodyTruncated: 0,
});
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}
const now = () => new Date().toISOString();
const bytes = estimateSearchStoreBytes;
const keyOf = (source: Pick<SearchSource, "deviceId" | "kind" | "historyId">) =>
  JSON.stringify([source.deviceId, source.kind, source.historyId ?? ""]);
const bodyKey = (ref: TextRef) => `${ref.ownerDeviceId}:${ref.objectId}`;
const newSourceId = (
  epoch: string,
  source: Pick<SearchSource, "deviceId" | "kind" | "historyId">,
) => JSON.stringify([epoch, keyOf(source), crypto.randomUUID()]);
async function paused() {
  return !!(await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY];
}
async function stored(): Promise<StoredCache> {
  return (await readSearchStore<StoredCache>()) ?? empty(0, await paused());
}
function mutableCache(cache: StoredCache): StoredCache {
  return {
    ...cache,
    sources: cache.sources.map((source) => ({ ...source })),
    bodies: { ...cache.bodies },
  };
}

async function fingerprint() {
  const state = await load();
  return hash({ deviceId: state.deviceId, settings: state.settings });
}
function publicCache(cache: StoredCache): SearchCache {
  const {
    configFingerprint: _fingerprint,
    bodies: _bodies,
    ...coverage
  } = cache;
  return {
    ...coverage,
    sources: coverage.sources.map(
      ({ snapshot: _snapshot, ...source }) => source,
    ),
  };
}
function errorInfo(error: unknown) {
  return error instanceof WebDAVError
    ? { error: error.message, errorCode: error.code }
    : { error: "来源读取或校验失败，请稍后重试。", errorCode: "invalid-data" };
}
function sanitizedContent(
  value: unknown,
  originalUrl: string,
  url: string,
): TabContent | undefined {
  if (value === undefined) return undefined;
  const unavailable = (reason: string): TabContent => ({
    status: "unavailable",
    reason,
  });
  if (!value || typeof value !== "object")
    return unavailable("正文状态格式无效，仍可搜索标签信息。");
  const content = value as TabContent;
  if (
    ![
      "available",
      "disabled",
      "permission-denied",
      "unavailable",
      "truncated",
    ].includes(content.status)
  )
    return unavailable("未知正文状态。");
  const reason =
    typeof content.reason === "string"
      ? content.reason.slice(0, 1000)
      : undefined;
  if (!["available", "truncated"].includes(content.status))
    return { status: content.status, reason };
  const ref = content.ref;
  if (
    !ref ||
    typeof ref.ownerDeviceId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ref.ownerDeviceId) ||
    typeof ref.objectId !== "string" ||
    !/^[a-f0-9]{64}$/.test(ref.objectId) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0 ||
    ref.bytes > 60_000 ||
    typeof ref.observedAt !== "string" ||
    !Number.isFinite(Date.parse(ref.observedAt)) ||
    typeof ref.captureUrl !== "string"
  )
    return unavailable("正文引用无效，未发送正文请求。");
  // Match the captured page BEFORE privacy normalization, not only after removing parameters.
  if (
    safeUrl(ref.captureUrl) !== safeUrl(originalUrl) ||
    !safeUrl(ref.captureUrl)
  )
    return unavailable("正文采集地址与此标签不一致，未读取过期正文。");
  return {
    status: content.status,
    reason,
    ref: {
      ownerDeviceId: ref.ownerDeviceId,
      objectId: ref.objectId,
      bytes: ref.bytes,
      observedAt: ref.observedAt,
      captureUrl: url,
    },
  };
}
function cleanSnapshot(raw: Snapshot, settings: Settings): Snapshot {
  const without = structuredClone(raw),
    rawContent = new Map<string, unknown>();
  if (Array.isArray(without.windows))
    for (const window of without.windows)
      if (window && Array.isArray(window.tabs))
        for (const tab of window.tabs)
          if (tab && typeof tab === "object") {
            rawContent.set(tab.tabKey, tab.content);
            delete tab.content;
          }
  const validated = validateSnapshot(without);
  return {
    schemaVersion: validated.schemaVersion,
    deviceId: validated.deviceId,
    snapshotId: validated.snapshotId,
    revision: validated.revision,
    capturedAt: validated.capturedAt,
    windows: validated.windows
      .map((window) => {
        const tabs = window.tabs.flatMap((tab) => {
          const url = safeUrl(tab.url, settings);
          return url
            ? [
                {
                  tabKey: tab.tabKey,
                  url,
                  title: tab.title,
                  index: tab.index,
                  pinned: tab.pinned,
                  groupKey: tab.groupKey,
                  origin: {
                    deviceId: tab.origin.deviceId,
                    tabKey: tab.origin.tabKey,
                  },
                  content:
                    validated.schemaVersion === 2
                      ? sanitizedContent(
                          rawContent.get(tab.tabKey),
                          tab.url,
                          url,
                        )
                      : undefined,
                },
              ]
            : [];
        });
        return {
          windowKey: window.windowKey,
          order: window.order,
          activeTabKey: tabs.some((tab) => tab.tabKey === window.activeTabKey)
            ? window.activeTabKey
            : tabs[0]?.tabKey,
          groups: window.groups
            .filter((group) =>
              tabs.some((tab) => tab.groupKey === group.groupKey),
            )
            .map((group) => ({
              groupKey: group.groupKey,
              title: group.title,
              color: group.color,
              collapsed: group.collapsed,
            })),
          tabs,
        };
      })
      .filter((window) => window.tabs.length > 0),
  };
}
function recalculate(cache: StoredCache) {
  cache.completed = cache.sources.filter(
    (source) => source.status !== "not-loaded",
  ).length;
  cache.total = cache.sources.length;
  cache.devicesLoaded = new Set(
    cache.sources
      .filter((source) => source.snapshot)
      .map((source) => source.deviceId),
  ).size;
  cache.earliestObservedAt = cache.sources
    .flatMap((source) => (source.snapshot ? [source.snapshot.capturedAt] : []))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const refs = new Set<string>();
  let unavailable = 0;
  for (const source of cache.sources)
    for (const window of source.snapshot?.windows ?? [])
      for (const tab of window.tabs) {
        if (tab.content?.ref) refs.add(bodyKey(tab.content.ref));
        else unavailable++;
      }
  cache.bodyLoaded = [...refs].filter(
    (key) => cache.bodies[key]?.text !== undefined,
  ).length;
  cache.bodyMissing =
    unavailable +
    [...refs].filter(
      (key) => !cache.bodies[key] || cache.bodies[key].status === "missing",
    ).length;
  cache.bodyTruncated = [...refs].filter(
    (key) => cache.bodies[key]?.status === "truncated",
  ).length;
  cache.updatedAt = now();
}
async function checkedCache(): Promise<StoredCache> {
  let cache = { ...(await stored()), paused: await paused() };
  if (
    cache.configFingerprint &&
    cache.configFingerprint !== (await fingerprint())
  ) {
    ++token;
    running = false;
    cache = {
      ...empty(cache.generation + 1, cache.paused),
      error: "配置或隐私规则已变化，请重新加载搜索数据。",
    };
    await clearSearchStore();
    await writeSearchStore(cache);
  } else if (cache.loading && !running) {
    cache = {
      ...cache,
      loading: false,
      cancelled: true,
      error: "加载被中断，已加载数据仍可搜索；下次刷新会补齐。",
    };
    await writeSearchStore(cache);
  }
  return cache;
}
export async function searchStatus(): Promise<SearchCache> {
  return serial(async () => publicCache(await checkedCache()));
}
export async function clearSearch(pause = false): Promise<SearchCache> {
  ++token;
  running = false;
  return serial(async () => {
    const generation = await searchStoreGeneration();
    await chrome.storage.local.set({ [PAUSE_KEY]: pause });
    const cache = empty(generation + 1, pause);
    await clearSearchStore();
    await writeSearchStore(cache);
    return publicCache(cache);
  });
}
export async function cancelSearch(): Promise<SearchCache> {
  ++token;
  running = false;
  return serial(async () => {
    const old = await stored();
    await chrome.storage.local.set({ [PAUSE_KEY]: true });
    const cache = {
      ...old,
      generation: old.generation + 1,
      loading: false,
      cancelled: true,
      paused: true,
      error: "已暂停加载，已加载数据仍可搜索；点击重建索引恢复。",
      updatedAt: now(),
    };
    await writeSearchStore(cache);
    return publicCache(cache);
  });
}
export async function autoSearch(): Promise<SearchCache> {
  const status = await searchStatus();
  if (status.paused || status.loading) return status;
  if (
    !status.refreshedAt ||
    Date.now() - Date.parse(status.refreshedAt) >= FRESH_MS
  )
    return loadSearch(true);
  return status;
}
export async function rebuildSearch(): Promise<SearchCache> {
  try {
    await readSearchStore<StoredCache>();
  } catch (error) {
    if (!(error instanceof SearchStoreError) || error.code !== "corrupt")
      throw error;
    await clearSearchStore();
  }
  await chrome.storage.local.set({ [PAUSE_KEY]: false });
  return loadSearch(true);
}
/** Explicit refresh also unpauses. Every refresh includes all retained history. */
export async function loadSearch(_includeHistory = true): Promise<SearchCache> {
  const myToken = ++token;
  running = true;
  return serial(async () => {
    const state = await load(),
      previous = await stored(),
      configFingerprint = await hash({
        deviceId: state.deviceId,
        settings: state.settings,
      }),
      epoch = crypto.randomUUID();
    const reusable =
      previous.configFingerprint === configFingerprint
        ? previous
        : empty(previous.generation);
    const cache: StoredCache = {
      ...reusable,
      generation: previous.generation + 1,
      loading: true,
      cancelled: false,
      paused: false,
      includeHistory: true,
      configFingerprint,
      error: undefined,
      truncated: false,
      updatedAt: now(),
      sources: reusable.sources.map((source) => ({
        ...source,
        id: newSourceId(epoch, source),
        stale: true,
      })),
    };
    if (myToken !== token) return publicCache(await stored());
    await chrome.storage.local.set({ [PAUSE_KEY]: false });
    await writeSearchStore(cache);
    void runLoad(
      myToken,
      structuredClone(state.settings),
      configFingerprint,
      epoch,
    ).catch(() => {
      if (myToken === token) running = false;
    });
    return publicCache(cache);
  });
}
async function commit(
  myToken: number,
  expected: string,
  mutate: (cache: StoredCache) => void,
): Promise<boolean> {
  return serial(async () => {
    if (myToken !== token) return false;
    if ((await fingerprint()) !== expected) {
      ++token;
      running = false;
      const old = await stored();
      await clearSearchStore();
      await writeSearchStore({
        ...empty(old.generation + 1, await paused()),
        error: "配置已变化，加载已取消。",
      });
      return false;
    }
    const original = await stored();
    if (myToken !== token || original.configFingerprint !== expected)
      return false;
    const cache = mutableCache(original),
      previous = mutableCache(original);
    mutate(cache);
    recalculate(cache);
    if (bytes(cache) > SEARCH_LIMITS.bytes) {
      previous.truncated = true;
      previous.error = "搜索缓存达到 64 MiB 安全预算，部分来源或正文未载入。";
      previous.loading = cache.loading;
      recalculate(previous);
      await writeSearchStore(previous);
      return true;
    }
    try {
      await writeSearchStore(cache);
    } catch (error) {
      if (!(error instanceof SearchStoreError) || error.code !== "limit")
        throw error;
      previous.truncated = true;
      previous.error = error.message;
      previous.loading = cache.loading;
      recalculate(previous);
      await writeSearchStore(previous);
    }
    return true;
  });
}
function upsert(cache: StoredCache, source: SearchSource) {
  const index = cache.sources.findIndex(
    (item) => keyOf(item) === keyOf(source),
  );
  if (index >= 0) cache.sources[index] = source;
  else if (cache.sources.length < SEARCH_LIMITS.sources)
    cache.sources.push(source);
  else cache.truncated = true;
}
function sourceBudget(cache: StoredCache, candidate: SearchSource): boolean {
  const sources = cache.sources.filter(
    (source) => keyOf(source) !== keyOf(candidate),
  );
  sources.push(candidate);
  return (
    sources.filter((source) => source.snapshot).length <=
      SEARCH_LIMITS.snapshots &&
    sources.reduce(
      (sum, source) =>
        sum +
        (source.snapshot?.windows.reduce(
          (n, window) => n + window.tabs.length,
          0,
        ) ?? 0),
      0,
    ) <= SEARCH_LIMITS.tabs &&
    bytes({ ...cache, sources }) <= SEARCH_LIMITS.bytes
  );
}
async function runLoad(
  myToken: number,
  settings: Settings,
  expected: string,
  epoch: string,
): Promise<void> {
  try {
    const repo = new WebDAVRepository(settings, {
      shouldContinue: () => myToken === token,
    });
    const issues: { deviceId: string; code: string; message: string }[] = [];
    const devices = await repo.listDevices((issue) => issues.push(issue));
    if (
      !(await commit(myToken, expected, (cache) => {
        cache.devicesTotal =
          devices.length +
          issues.filter((issue) => issue.deviceId !== "*").length;
        const known = new Set([
          ...devices.map((device) => device.deviceId),
          ...issues.map((issue) => issue.deviceId),
        ]);
        if (!issues.some((issue) => issue.deviceId === "*"))
          cache.sources = cache.sources.filter((source) =>
            known.has(source.deviceId),
          );
        if (issues.length)
          cache.error = "部分设备枚举失败，覆盖不完整；旧缓存已标记过期。";
        for (const issue of issues) {
          if (issue.code === "limit") cache.truncated = true;
          const old = cache.sources.filter(
            (source) => source.deviceId === issue.deviceId,
          );
          for (const source of old) {
            source.stale = true;
            source.error = issue.message;
            source.errorCode = issue.code;
          }
          if (!old.length)
            upsert(cache, {
              id: newSourceId(epoch, {
                deviceId: issue.deviceId,
                kind: "current",
              }),
              deviceId: issue.deviceId,
              deviceName: issue.deviceId,
              kind: "current",
              status: issue.code === "limit" ? "not-loaded" : "failed",
              error: issue.message,
              errorCode: issue.code,
            });
        }
      }))
    )
      return;
    const bodyAttempted = new Set<string>();
    const loadBodies = async (snapshot: Snapshot): Promise<boolean> => {
      for (const window of snapshot.windows)
        for (const tab of window.tabs) {
          const ref = tab.content?.ref;
          if (!ref) continue;
          const key = bodyKey(ref);
          if (bodyAttempted.has(key)) continue;
          bodyAttempted.add(key);
          if (myToken !== token) return false;
          const existing = (await stored()).bodies[key];
          if (existing?.text !== undefined) continue;
          let entry: BodyEntry;
          try {
            const text = await repo.readText(ref);
            entry = {
              text,
              identity: await hash(text),
              status:
                tab.content?.status === "truncated" ? "truncated" : "loaded",
            };
          } catch (error) {
            entry = { status: "missing", reason: errorInfo(error).error };
          }
          if (
            !(await commit(myToken, expected, (cache) => {
              if (
                bytes({ ...cache, bodies: { ...cache.bodies, [key]: entry } }) >
                SEARCH_LIMITS.bytes
              ) {
                cache.truncated = true;
                cache.bodies[key] = {
                  status: "truncated",
                  reason: "正文未载入：达到本地缓存预算。",
                };
              } else cache.bodies[key] = entry;
            }))
          )
            return false;
        }
      return true;
    };
    const fetchSource = async (
      device: { deviceId: string; name: string },
      kind: SearchSource["kind"],
      historyId?: string,
    ): Promise<boolean> => {
      if (myToken !== token) return false;
      const descriptor = { deviceId: device.deviceId, kind, historyId },
        before = await stored(),
        old = before.sources.find(
          (source) => keyOf(source) === keyOf(descriptor),
        );
      let candidate: SearchSource;
      try {
        const snapshot =
          kind === "history" && old?.snapshot
            ? old.snapshot
            : cleanSnapshot(
                await repo.readSnapshot(device.deviceId, kind, historyId),
                settings,
              );
        candidate = {
          ...descriptor,
          id: newSourceId(epoch, descriptor),
          deviceName: device.name,
          status: "loaded",
          snapshot,
          capturedAt: snapshot.capturedAt,
          loadedAt: kind === "history" && old?.loadedAt ? old.loadedAt : now(),
          stale: false,
        };
      } catch (error) {
        candidate = {
          ...descriptor,
          id: newSourceId(epoch, descriptor),
          deviceName: device.name,
          status: old?.snapshot ? "loaded" : "failed",
          snapshot: old?.snapshot,
          capturedAt: old?.capturedAt,
          loadedAt: old?.loadedAt,
          stale: true,
          ...errorInfo(error),
        };
      }
      let accepted = false;
      if (
        !(await commit(myToken, expected, (cache) => {
          if (candidate.snapshot && !sourceBudget(cache, candidate)) {
            cache.truncated = true;
            upsert(
              cache,
              old
                ? {
                    ...old,
                    stale: true,
                    error: "快照超过本地搜索缓存预算，保留旧版本。",
                    errorCode: "limit",
                  }
                : {
                    ...candidate,
                    snapshot: undefined,
                    status: "not-loaded",
                    error: "快照超过本地搜索缓存预算。",
                    errorCode: "limit",
                  },
            );
          } else {
            upsert(cache, candidate);
            accepted = !!candidate.snapshot;
          }
        }))
      )
        return false;
      return !accepted || !candidate.snapshot
        ? myToken === token
        : loadBodies(candidate.snapshot);
    };
    for (const device of devices)
      if (!(await fetchSource(device, "current"))) return;
    for (const device of devices) {
      if (!(await fetchSource(device, "recovery"))) return;
      let history: string[];
      try {
        history = await repo.listHistory(device.deviceId);
      } catch (error) {
        if (
          !(await commit(myToken, expected, (cache) => {
            const old = cache.sources.filter(
              (source) =>
                source.deviceId === device.deviceId &&
                source.kind === "history",
            );
            for (const source of old) {
              source.stale = true;
              Object.assign(source, errorInfo(error));
            }
            if (!old.length)
              upsert(cache, {
                id: newSourceId(epoch, {
                  deviceId: device.deviceId,
                  kind: "history",
                  historyId: "discovery",
                }),
                deviceId: device.deviceId,
                deviceName: device.name,
                kind: "history",
                historyId: "discovery",
                status: "failed",
                ...errorInfo(error),
              });
          }))
        )
          return;
        continue;
      }
      if (
        !(await commit(myToken, expected, (cache) => {
          const retained = new Set(history);
          cache.sources = cache.sources.filter(
            (source) =>
              source.deviceId !== device.deviceId ||
              source.kind !== "history" ||
              (!!source.historyId && retained.has(source.historyId)),
          );
        }))
      )
        return;
      const available = Math.max(
        0,
        SEARCH_LIMITS.sources -
          (await stored()).sources.filter(
            (source) =>
              source.deviceId !== device.deviceId || source.kind !== "history",
          ).length,
      );
      for (const historyId of history.slice(0, available))
        if (!(await fetchSource(device, "history", historyId))) return;
      if (
        history.length > available &&
        !(await commit(myToken, expected, (cache) => {
          cache.truncated = true;
          cache.error = "部分保留版本超过来源上限，覆盖不完整。";
        }))
      )
        return;
    }
    await commit(myToken, expected, (cache) => {
      const used = new Set(
        cache.sources.flatMap(
          (source) =>
            source.snapshot?.windows.flatMap((window) =>
              window.tabs.flatMap((tab) =>
                tab.content?.ref ? [bodyKey(tab.content.ref)] : [],
              ),
            ) ?? [],
        ),
      );
      cache.bodies = Object.fromEntries(
        Object.entries(cache.bodies).filter(([key]) => used.has(key)),
      );
      cache.loading = false;
      cache.refreshedAt = now();
    });
  } catch (error) {
    await commit(myToken, expected, (cache) => {
      cache.loading = false;
      cache.error = errorInfo(error).error;
      for (const source of cache.sources) {
        source.stale = true;
        source.error = source.error ?? cache.error;
      }
      cache.refreshedAt = now();
    });
  } finally {
    if (myToken === token) running = false;
  }
}
function occurrences(cache: StoredCache): InternalResult[] {
  const results: InternalResult[] = [];
  for (const source of cache.sources) {
    if (!source.snapshot) continue;
    for (const window of source.snapshot.windows)
      for (const tab of window.tabs) {
        const group = window.groups.find(
            (item) => item.groupKey === tab.groupKey,
          ),
          ref = tab.content?.ref,
          body = ref ? cache.bodies[bodyKey(ref)] : undefined;
        results.push({
          id: JSON.stringify([source.id, window.windowKey, tab.tabKey]),
          sourceId: source.id,
          deviceId: source.deviceId,
          deviceName: source.deviceName,
          kind: source.kind,
          capturedAt: source.snapshot.capturedAt,
          windowKey: window.windowKey,
          tabKey: tab.tabKey,
          title: tab.title,
          url: tab.url,
          domain: new URL(tab.url).hostname,
          pinned: tab.pinned,
          groupKey: tab.groupKey,
          groupTitle: group?.title,
          stale:
            !!source.stale ||
            source.kind !== "current" ||
            Date.now() - Date.parse(source.snapshot.capturedAt) > FRESH_MS,
          bodyText: body?.text,
          bodyIdentity:
            body?.identity ??
            (ref
              ? bodyKey(ref)
              : `status:${tab.content?.status ?? "unavailable"}`),
          contentStatus:
            body?.text !== undefined
              ? tab.content?.status
              : tab.content?.status === "available" ||
                  tab.content?.status === "truncated"
                ? body?.status === "truncated"
                  ? "truncated"
                  : "unavailable"
                : (tab.content?.status ?? "unavailable"),
          contentReason:
            body?.reason ??
            tab.content?.reason ??
            (!tab.content ? "旧快照或此标签没有采集正文。" : undefined),
        });
      }
  }
  return results;
}
const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase();
function filterResult(result: SearchResult, filters: SearchFilters) {
  if (filters.deviceId && result.deviceId !== filters.deviceId) return false;
  if (
    filters.kind &&
    (filters.kind === "current"
      ? result.kind !== "current"
      : result.kind === "current")
  )
    return false;
  if (filters.pinned !== undefined && result.pinned !== filters.pinned)
    return false;
  if (filters.domain) {
    const domain = normalize(filters.domain.trim().replace(/^\*\./, ""));
    if (result.domain !== domain && !result.domain.endsWith("." + domain))
      return false;
  }
  if (
    filters.group &&
    !normalize(result.groupTitle ?? "").includes(normalize(filters.group))
  )
    return false;
  if (
    filters.after &&
    Date.parse(result.capturedAt) < Date.parse(filters.after)
  )
    return false;
  if (
    filters.before &&
    Date.parse(result.capturedAt) > Date.parse(filters.before)
  )
    return false;
  return true;
}
function visibleResult(result: InternalResult, needle = ""): SearchResult {
  const { bodyText, bodyIdentity: _identity, ...visible } = result;
  if (bodyText !== undefined) {
    const position = needle ? normalize(bodyText).indexOf(needle) : -1;
    const start = Math.max(0, (position < 0 ? 0 : position) - 60);
    visible.bodySnippet =
      (start ? "…" : "") +
      bodyText.slice(start, start + 220) +
      (bodyText.length > start + 220 ? "…" : "");
  }
  return visible;
}
export async function querySearch(
  query: string,
  filters: SearchFilters = {},
  limit = 100,
): Promise<{
  results: SearchResult[];
  total: number;
  occurrenceTotal: number;
  coverage: SearchCache;
}> {
  if (typeof query !== "string" || query.length > 2000)
    throw Error("搜索词最长为 2000 个字符。");
  for (const date of [filters.after, filters.before])
    if (date && !Number.isFinite(Date.parse(date)))
      throw Error("搜索日期无效。");
  return serial(async () => {
    const cache = await checkedCache(),
      needle = normalize(query.trim());
    const scored = occurrences(cache)
      .filter((result) => filterResult(result, filters))
      .map((result) => {
        const fields = [
          result.title,
          result.url,
          result.domain,
          result.groupTitle ?? "",
          result.bodyText ?? "",
        ].map(normalize);
        return {
          result,
          rank: needle && fields.some((field) => field === needle) ? 0 : 1,
          matches: !needle || fields.some((field) => field.includes(needle)),
        };
      })
      .filter((item) => item.matches)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          Date.parse(b.result.capturedAt) - Date.parse(a.result.capturedAt) ||
          a.result.id.localeCompare(b.result.id),
      );
    const grouped = new Map<string, SearchResult>();
    for (const { result } of scored) {
      const identity = JSON.stringify([
          result.url,
          result.title,
          result.bodyIdentity,
          result.groupTitle ?? "",
          result.pinned,
        ]),
        leaf = visibleResult(result, needle),
        row = grouped.get(identity);
      if (row) row.occurrences!.push(leaf);
      else grouped.set(identity, { ...leaf, occurrences: [leaf] });
    }
    const count = Number.isFinite(limit)
      ? Math.max(1, Math.min(1000, Math.trunc(limit)))
      : 100;
    return {
      results: [...grouped.values()].slice(0, count),
      total: grouped.size,
      occurrenceTotal: scored.length,
      coverage: publicCache(cache),
    };
  });
}
export async function getSearchSource(id: string): Promise<SearchSource> {
  return serial(async () => {
    const cache = await checkedCache(),
      source = cache.sources.find((item) => item.id === id);
    if (!source?.snapshot) throw Error("搜索来源已失效，请重新搜索。");
    return structuredClone(source);
  });
}
export async function getSearchResult(id: string): Promise<SearchResult> {
  return serial(async () => {
    const cache = await checkedCache(),
      result = occurrences(cache).find((item) => item.id === id);
    if (!result) throw Error("搜索结果已失效，请重新搜索。");
    return visibleResult(result);
  });
}
