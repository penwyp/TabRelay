import { hash, safeUrl, validateSnapshot } from "./model";
import { load } from "./state";
import type { Settings, Snapshot } from "./types";
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
};
export type SearchCache = {
  generation: number;
  loading: boolean;
  cancelled: boolean;
  includeHistory: boolean;
  sources: SearchSource[];
  devicesTotal: number;
  devicesLoaded: number;
  completed: number;
  total: number;
  truncated: boolean;
  error?: string;
  updatedAt?: string;
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
};
type StoredCache = SearchCache & { configFingerprint?: string };
export const SEARCH_LIMITS = {
  snapshots: 300,
  tabs: 30_000,
  sources: 2000,
  // Conservative serialized budget: session quota measures in-memory allocation,
  // so leave room for UTF-16 strings, object overhead and other session data.
  bytes: 3 * 1024 * 1024,
};
const CACHE_KEY = "searchCache";
let token = 0;
let running = false;
let queue: Promise<unknown> = Promise.resolve();
const empty = (generation = 0): StoredCache => ({
  generation,
  loading: false,
  cancelled: false,
  includeHistory: false,
  sources: [],
  devicesTotal: 0,
  devicesLoaded: 0,
  completed: 0,
  total: 0,
  truncated: false,
});
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const promise = queue.then(fn);
  queue = promise.catch(() => {});
  return promise;
}
async function stored(): Promise<StoredCache> {
  const result = await chrome.storage.session.get(CACHE_KEY);
  return (result[CACHE_KEY] as StoredCache | undefined) ?? empty();
}
async function fingerprint(): Promise<string> {
  const state = await load();
  return hash({ deviceId: state.deviceId, settings: state.settings });
}
function publicCache(cache: StoredCache): SearchCache {
  const { configFingerprint: _private, ...coverage } = cache;
  return {
    ...coverage,
    sources: coverage.sources.map(
      ({ snapshot: _snapshot, ...source }) => source,
    ),
  };
}
function time(): string {
  return new Date().toISOString();
}

function errorInfo(error: unknown): { error: string; errorCode: string } {
  if (error instanceof WebDAVError) {
    return { error: error.message, errorCode: error.code };
  }
  // Do not cache arbitrary exception text; it may contain server URLs or secrets.
  return {
    error: "快照读取或校验失败，请检查来源后重试。",
    errorCode: "invalid-data",
  };
}
function cleanSnapshot(raw: Snapshot, settings: Settings): Snapshot {
  const validated = validateSnapshot(raw);
  // Whitelist persisted fields; untrusted extra properties never enter the cache.
  const snapshot: Snapshot = {
    schemaVersion: 1,
    deviceId: validated.deviceId,
    snapshotId: validated.snapshotId,
    revision: validated.revision,
    capturedAt: validated.capturedAt,
    windows: validated.windows.map((window) => ({
      windowKey: window.windowKey,
      order: window.order,
      activeTabKey: window.activeTabKey,
      groups: window.groups.map((group) => ({
        groupKey: group.groupKey,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
      })),
      tabs: window.tabs.map((tab) => ({
        tabKey: tab.tabKey,
        url: tab.url,
        title: tab.title,
        index: tab.index,
        pinned: tab.pinned,
        groupKey: tab.groupKey,
        origin: { deviceId: tab.origin.deviceId, tabKey: tab.origin.tabKey },
      })),
    })),
  };
  snapshot.windows = snapshot.windows
    .map((window) => {
      const tabs = window.tabs.flatMap((tab) => {
        const url = safeUrl(tab.url, settings);
        return url ? [{ ...tab, url }] : [];
      });
      const groups = window.groups.filter((group) =>
        tabs.some((tab) => tab.groupKey === group.groupKey),
      );
      return {
        ...window,
        tabs,
        groups,
        activeTabKey: tabs.some((tab) => tab.tabKey === window.activeTabKey)
          ? window.activeTabKey
          : tabs[0]?.tabKey,
      };
    })
    .filter((window) => window.tabs.length > 0);
  return snapshot;
}
function recalculate(cache: StoredCache): void {
  const finished = cache.sources.filter(
    (source) => source.status !== "not-loaded",
  );
  cache.completed = finished.length;
  cache.total = cache.sources.length;
  cache.devicesLoaded = new Set(
    cache.sources
      .filter((source) => source.status === "loaded")
      .map((source) => source.deviceId),
  ).size;
  const timestamps = cache.sources.flatMap((source) =>
    source.status === "loaded" && source.capturedAt ? [source.capturedAt] : [],
  );
  cache.earliestObservedAt = timestamps.sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  )[0];
  cache.updatedAt = time();
}
/** Must run inside the serial queue. */
async function checkedCache(): Promise<StoredCache> {
  let cache = await stored();
  if (
    cache.configFingerprint &&
    cache.configFingerprint !== (await fingerprint())
  ) {
    ++token;
    running = false;
    cache = {
      ...empty(cache.generation + 1),
      error: "配置或隐私规则已变化，请重新加载搜索数据。",
    };
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
  } else if (cache.loading && !running) {
    cache = {
      ...cache,
      loading: false,
      cancelled: true,
      error: "搜索加载被中断；已加载数据仍可搜索，请手动刷新补齐。",
      updatedAt: time(),
    };
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
  }
  return cache;
}
export async function searchStatus(): Promise<SearchCache> {
  return serial(async () => publicCache(await checkedCache()));
}
export async function clearSearch(): Promise<SearchCache> {
  ++token;
  running = false;
  return serial(async () => {
    const old = await stored();
    const cache = empty(old.generation + 1);
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
    return publicCache(cache);
  });
}
export async function cancelSearch(): Promise<SearchCache> {
  ++token;
  running = false;
  return serial(async () => {
    const old = await stored();
    const cache = {
      ...old,
      generation: old.generation + 1,
      loading: false,
      cancelled: true,
      error: "已取消加载；已加载的数据仍可搜索。",
      updatedAt: time(),
    };
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
    return publicCache(cache);
  });
}
/** Start explicit loading and return immediately. Querying never contacts WebDAV. */
export async function loadSearch(
  includeHistory: boolean,
): Promise<SearchCache> {
  const myToken = ++token;
  running = true;
  return serial(async () => {
    const state = await load();
    const previous = await stored();
    const configFingerprint = await hash({
      deviceId: state.deviceId,
      settings: state.settings,
    });
    const cache: StoredCache = {
      ...empty(previous.generation + 1),
      loading: true,
      includeHistory: !!includeHistory,
      configFingerprint,
      updatedAt: time(),
    };
    if (myToken !== token) return publicCache(await stored());
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
    void runLoad(
      myToken,
      structuredClone(state.settings),
      configFingerprint,
    ).catch(() => {
      // Storage/API failure must not create an unhandled rejection. The next
      // status read marks a persisted loading state as interrupted.
      if (myToken === token) running = false;
    });
    return publicCache(cache);
  });
}
async function commit(
  myToken: number,
  expectedFingerprint: string,
  mutate: (cache: StoredCache) => void,
): Promise<boolean> {
  return serial(async () => {
    if (token !== myToken) return false;
    if ((await fingerprint()) !== expectedFingerprint) {
      ++token;
      running = false;
      const old = await stored();
      await chrome.storage.session.set({
        [CACHE_KEY]: {
          ...empty(old.generation + 1),
          error: "配置或隐私规则已变化，搜索加载已取消。",
        },
      });
      return false;
    }
    const cache = await stored();
    if (token !== myToken || cache.configFingerprint !== expectedFingerprint)
      return false;
    mutate(cache);
    recalculate(cache);
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
    return true;
  });
}
async function runLoad(
  myToken: number,
  settings: Settings,
  expectedFingerprint: string,
): Promise<void> {
  let loadedSnapshots = 0,
    loadedTabs = 0,
    snapshotBytes = 0,
    exhausted = false;
  const sourceEpoch = crypto.randomUUID();
  const sourceId = (
    deviceId: string,
    kind: SearchSource["kind"],
    historyId?: string,
  ): string => JSON.stringify([sourceEpoch, deviceId, kind, historyId ?? ""]);
  try {
    const repo = new WebDAVRepository(settings, {
      shouldContinue: () => myToken === token,
    });
    const enumerationIssues: {
      deviceId: string;
      code: string;
      message: string;
    }[] = [];
    const devices = await repo.listDevices((issue) =>
      enumerationIssues.push(issue),
    );
    if (
      !(await commit(myToken, expectedFingerprint, (cache) => {
        cache.devicesTotal =
          devices.length +
          enumerationIssues.filter((issue) => issue.deviceId !== "*").length;
        cache.truncated = enumerationIssues.some(
          (issue) => issue.code === "limit",
        );
        if (enumerationIssues.length)
          cache.error = "部分远端设备未能枚举或读取，覆盖范围不完整。";
        cache.sources = devices.flatMap((device) => [
          {
            id: sourceId(device.deviceId, "current"),
            deviceId: device.deviceId,
            deviceName: device.name,
            kind: "current" as const,
            status: "not-loaded" as const,
          },
          ...(cache.includeHistory
            ? []
            : [
                {
                  id: sourceId(device.deviceId, "history", "unloaded"),
                  deviceId: device.deviceId,
                  deviceName: device.name,
                  kind: "history" as const,
                  status: "not-loaded" as const,
                  error: "历史及恢复点尚未加载；历史总量未知。",
                  errorCode: "history-not-loaded",
                },
              ]),
        ]);
        cache.sources.push(
          ...enumerationIssues.map((issue, index) => ({
            id: sourceId(issue.deviceId, "current", `enumeration-${index}`),
            deviceId: issue.deviceId,
            deviceName: issue.deviceId === "*" ? "设备枚举" : issue.deviceId,
            kind: "current" as const,
            status:
              issue.code === "limit"
                ? ("not-loaded" as const)
                : ("failed" as const),
            error: issue.message,
            errorCode: issue.code,
          })),
        );
      }))
    )
      return;
    const fetchSource = async (source: SearchSource): Promise<boolean> => {
      if (myToken !== token) return false;
      if (exhausted) return true;
      if (
        loadedSnapshots >= SEARCH_LIMITS.snapshots ||
        loadedTabs >= SEARCH_LIMITS.tabs ||
        snapshotBytes >= SEARCH_LIMITS.bytes - 500_000
      ) {
        exhausted = true;
        return commit(myToken, expectedFingerprint, (cache) => {
          cache.truncated = true;
          const target = cache.sources.find((item) => item.id === source.id);
          if (target) {
            target.error = "达到本地搜索缓存安全上限，未加载此来源。";
            target.errorCode = "limit";
          }
        });
      }
      try {
        const raw = await repo.readSnapshot(
          source.deviceId,
          source.kind,
          source.historyId,
        );
        const snapshot = cleanSnapshot(raw, settings);
        const tabs = snapshot.windows.reduce(
          (sum, window) => sum + window.tabs.length,
          0,
        );
        const bytes = new TextEncoder().encode(
          JSON.stringify(snapshot),
        ).byteLength;
        const fits =
          loadedTabs + tabs <= SEARCH_LIMITS.tabs &&
          snapshotBytes + bytes <= SEARCH_LIMITS.bytes - 500_000;
        if (
          !(await commit(myToken, expectedFingerprint, (cache) => {
            const target = cache.sources.find((item) => item.id === source.id);
            if (!target) return;
            if (!fits) {
              cache.truncated = true;
              target.error = "此快照超过剩余搜索缓存容量，未加载。";
              target.errorCode = "limit";
              return;
            }
            Object.assign(target, {
              snapshot,
              status: "loaded",
              loadedAt: time(),
              capturedAt: snapshot.capturedAt,
            });
            delete target.error;
            delete target.errorCode;
          }))
        )
          return false;
        if (fits) {
          loadedSnapshots++;
          loadedTabs += tabs;
          snapshotBytes += bytes;
        }
      } catch (error) {
        if (
          !(await commit(myToken, expectedFingerprint, (cache) => {
            const target = cache.sources.find((item) => item.id === source.id);
            if (target)
              Object.assign(target, { status: "failed", ...errorInfo(error) });
          }))
        )
          return false;
      }
      return myToken === token;
    };
    // Current snapshots are prioritized so one device's long history cannot hide peers.
    for (const device of devices) {
      if (
        !(await fetchSource({
          id: sourceId(device.deviceId, "current"),
          deviceId: device.deviceId,
          deviceName: device.name,
          kind: "current",
          status: "not-loaded",
        }))
      )
        return;
    }
    const currentCache = await stored();
    if (currentCache.includeHistory)
      for (const device of devices) {
        if (myToken !== token) return;
        const recovery: SearchSource = {
          id: sourceId(device.deviceId, "recovery"),
          deviceId: device.deviceId,
          deviceName: device.name,
          kind: "recovery",
          status: "not-loaded",
        };
        const discoveryId = sourceId(device.deviceId, "history", "discovery");
        if (
          !(await commit(myToken, expectedFingerprint, (cache) => {
            cache.sources.push(recovery);
          }))
        )
          return;
        if (!(await fetchSource(recovery))) return;
        let history: string[];
        try {
          history = await repo.listHistory(device.deviceId);
        } catch (error) {
          if (
            !(await commit(myToken, expectedFingerprint, (cache) => {
              cache.sources.push({
                id: discoveryId,
                deviceId: device.deviceId,
                deviceName: device.name,
                kind: "history",
                status: "failed",
                ...errorInfo(error),
              });
            }))
          )
            return;
          continue;
        }
        let sources: SearchSource[] = [];
        if (
          !(await commit(myToken, expectedFingerprint, (cache) => {
            const available = Math.max(
              0,
              SEARCH_LIMITS.sources -
                cache.sources.length -
                devices.length * 2 -
                1,
            );
            sources = history.slice(0, available).map((historyId) => ({
              id: sourceId(device.deviceId, "history", historyId),
              deviceId: device.deviceId,
              deviceName: device.name,
              kind: "history",
              historyId,
              status: "not-loaded",
            }));
            cache.sources.push(...sources);
            if (history.length > available) {
              cache.truncated = true;
              cache.sources.push({
                id: discoveryId,
                deviceId: device.deviceId,
                deviceName: device.name,
                kind: "history",
                status: "not-loaded",
                error: `还有 ${history.length - available} 个保留版本超过来源列表上限，未加载。`,
                errorCode: "limit",
              });
            }
          }))
        )
          return;
        for (const source of sources) if (!(await fetchSource(source))) return;
      }
    await commit(myToken, expectedFingerprint, (cache) => {
      cache.loading = false;
      if (exhausted)
        for (const source of cache.sources) {
          if (source.status === "not-loaded" && !source.errorCode) {
            source.error = "达到本地搜索缓存安全上限，未加载此来源。";
            source.errorCode = "limit";
          }
        }
    });
  } catch (error) {
    await commit(myToken, expectedFingerprint, (cache) => {
      cache.loading = false;
      cache.error = errorInfo(error).error;
    });
  } finally {
    if (myToken === token) running = false;
  }
}
function occurrences(cache: StoredCache): SearchResult[] {
  const results: SearchResult[] = [];
  for (const source of cache.sources) {
    if (source.status !== "loaded" || !source.snapshot) continue;
    for (const window of source.snapshot.windows)
      for (const tab of window.tabs) {
        const group = window.groups.find(
          (item) => item.groupKey === tab.groupKey,
        );
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
            source.kind !== "current" ||
            Date.now() - Date.parse(source.snapshot.capturedAt) > 5 * 60_000,
        });
      }
  }
  return results;
}
const normalize = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase();
function filterResult(result: SearchResult, filters: SearchFilters): boolean {
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
export async function querySearch(
  query: string,
  filters: SearchFilters = {},
  limit = 100,
): Promise<{ results: SearchResult[]; total: number; coverage: SearchCache }> {
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
        ].map(normalize);
        const exact = needle !== "" && fields.some((field) => field === needle);
        return {
          result,
          rank: exact ? 0 : 1,
          matches:
            needle === "" || fields.some((field) => field.includes(needle)),
        };
      })
      .filter((item) => item.matches)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          Date.parse(b.result.capturedAt) - Date.parse(a.result.capturedAt) ||
          a.result.id.localeCompare(b.result.id),
      );
    const count = Number.isFinite(limit)
      ? Math.max(1, Math.min(1000, Math.trunc(limit)))
      : 100;
    return {
      results: scored.slice(0, count).map((item) => item.result),
      total: scored.length,
      coverage: publicCache(cache),
    };
  });
}
export async function getSearchSource(id: string): Promise<SearchSource> {
  return serial(async () => {
    const cache = await checkedCache(),
      source = cache.sources.find((item) => item.id === id);
    if (!source || source.status !== "loaded" || !source.snapshot)
      throw Error("此搜索来源尚未加载或已失效，请重新加载。");
    return structuredClone(source);
  });
}
export async function getSearchResult(id: string): Promise<SearchResult> {
  return serial(async () => {
    const cache = await checkedCache(),
      result = occurrences(cache).find((item) => item.id === id);
    if (!result) throw Error("此搜索结果已失效，请重新搜索。");
    return structuredClone(result);
  });
}
