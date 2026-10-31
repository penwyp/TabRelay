/** Rebuildable search storage: ciphertext persists, decryption key is session-only. */
export const SEARCH_DB_NAME = "tabrelay-search-v2";
export const SEARCH_DB_STORE = "records";
export const SEARCH_STORE_BYTES = 64 * 1024 * 1024;
export const SEARCH_MANIFEST_BYTES = 2 * 1024 * 1024;
export class SearchStoreError extends Error {
  constructor(
    public readonly code: "corrupt" | "limit" | "storage" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "SearchStoreError";
  }
}
const SESSION_KEY = "searchIndexKey";
const MANIFEST_KEY = "searchCache";
type Kind = "snapshot" | "body";
type Ref = { id: string; digest: string; bytes: number; kind: Kind };
type RecordData = {
  id: string;
  kind: Kind;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};
type SessionKey = { version: 1; id: string; raw: string };
type CacheShape = {
  sources: Array<{ id: string; snapshot?: unknown }>;
  bodies: Record<string, unknown>;
};
type Manifest = {
  version: 2;
  keyId: string;
  control: Record<string, unknown>;
  snapshots: Record<string, Ref>;
  bodies: Record<string, Ref>;
  bytes: number;
};
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
let dbPromise: Promise<IDBDatabase> | undefined,
  keyData: SessionKey | undefined,
  key: CryptoKey | undefined,
  hot: CacheShape | undefined;
let epoch = 0,
  queue: Promise<unknown> = Promise.resolve();
const infoCache = new WeakMap<object, { digest: string; bytes: number }>();
const sizeCache = new WeakMap<object, number>();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const promise = queue.then(operation);
  queue = promise.catch(() => {});
  return promise;
}
function openDB(): Promise<IDBDatabase> {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(SEARCH_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SEARCH_DB_STORE))
          request.result.createObjectStore(SEARCH_DB_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          dbPromise = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        dbPromise = undefined;
        reject(new Error("无法打开本地加密搜索数据库。"));
      };
      request.onblocked = () =>
        reject(
          new Error("本地搜索数据库被其他扩展页面占用，请关闭旧页面重试。"),
        );
    });
  return dbPromise;
}
async function transaction(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => void,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEARCH_DB_STORE, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(new Error("加密搜索缓存写入失败，请检查浏览器存储空间。"));
    tx.onabort = () =>
      reject(new Error("加密搜索缓存事务已中止，未报告写入成功。"));
    try {
      action(tx.objectStore(SEARCH_DB_STORE));
    } catch {
      tx.abort();
    }
  });
}
async function record(id: string): Promise<RecordData | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(SEARCH_DB_STORE, "readonly")
      .objectStore(SEARCH_DB_STORE)
      .get(id);
    request.onsuccess = () => resolve(request.result as RecordData | undefined);
    request.onerror = () => reject(new Error("读取加密搜索缓存失败。"));
  });
}
async function prune(keep: Set<string>): Promise<void> {
  await transaction("readwrite", (store) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const value = cursor.result;
      if (value) {
        if (!keep.has(String(value.key))) value.delete();
        value.continue();
      }
    };
  });
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function ensureKey(): Promise<void> {
  const stored = (await chrome.storage.session.get(SESSION_KEY))[
    SESSION_KEY
  ] as SessionKey | undefined;
  let raw: Uint8Array | undefined;
  try {
    if (
      stored?.version === 1 &&
      typeof stored.id === "string" &&
      typeof stored.raw === "string"
    )
      raw = Uint8Array.from(atob(stored.raw), (c) => c.charCodeAt(0));
  } catch {
    /* Invalid session key is treated as lost. */
  }
  if (!stored || raw?.length !== 32) {
    // A browser restart clears storage.session. Destroy unreadable records before
    // returning any cache state; no plaintext persistent index is kept.
    await transaction("readwrite", (store) => {
      store.clear();
    });
    hot = undefined;
    raw = crypto.getRandomValues(new Uint8Array(32));
    keyData = { version: 1, id: crypto.randomUUID(), raw: base64(raw) };
    key = await crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    await chrome.storage.session.set({
      [SESSION_KEY]: keyData,
      [MANIFEST_KEY]: null,
    });
    return;
  }
  if (keyData?.id !== stored.id || keyData.raw !== stored.raw) {
    keyData = stored;
    key = await crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    hot = undefined;
  }
}
function aad(kind: Kind, id: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`TabRelay-search-v2:${keyData!.id}:${kind}:${id}`);
}
async function manifest(): Promise<Manifest | undefined> {
  const value = (await chrome.storage.session.get(MANIFEST_KEY))[
    MANIFEST_KEY
  ] as Manifest | undefined;
  return value?.version === 2 && value.keyId === keyData!.id
    ? value
    : undefined;
}
function refs(value: Manifest | undefined): Ref[] {
  return value
    ? [...Object.values(value.snapshots), ...Object.values(value.bodies)]
    : [];
}
async function payloadInfo(
  value: unknown,
): Promise<{ digest: string; bytes: number; text?: string }> {
  if (value && typeof value === "object") {
    const known = infoCache.get(value);
    if (known) return known;
  }
  const text = JSON.stringify(value),
    data = encoder.encode(text),
    digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
  const info = { digest, bytes: data.length };
  if (value && typeof value === "object") {
    infoCache.set(value, info);
    sizeCache.set(value, data.length);
  }
  return { ...info, text };
}
async function decrypt(ref: Ref): Promise<unknown> {
  const value = await record(ref.id);
  if (!value || value.kind !== ref.kind)
    throw new SearchStoreError("corrupt", "搜索缓存记录缺失，请重建索引。");
  let text: string;
  try {
    text = decoder.decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: value.iv,
          additionalData: aad(ref.kind, ref.id),
        },
        key!,
        value.ciphertext,
      ),
    );
  } catch {
    throw new SearchStoreError(
      "corrupt",
      "搜索缓存无法解密或已损坏，请重建索引。",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SearchStoreError("corrupt", "搜索缓存数据无效，请重建索引。");
  }
  const info = await payloadInfo(parsed);
  if (info.digest !== ref.digest)
    throw new SearchStoreError("corrupt", "搜索缓存内容校验失败，请重建索引。");
  return parsed;
}
/** Returned objects are immutable payloads. Callers must shallow-copy controls before edits. */
export async function readSearchStore<T extends CacheShape>(): Promise<
  T | undefined
> {
  return serial(async () => {
    await ensureKey();
    if (hot) return hot as T;
    const saved = await manifest();
    if (!saved) {
      await prune(new Set());
      return undefined;
    }
    const payloads = new Map<string, unknown>();
    for (const ref of refs(saved))
      if (!payloads.has(ref.id)) payloads.set(ref.id, await decrypt(ref));
    const control = structuredClone(saved.control) as unknown as T;
    control.sources = control.sources.map((source) => ({
      ...source,
      snapshot: saved.snapshots[source.id]
        ? payloads.get(saved.snapshots[source.id].id)
        : undefined,
    }));
    control.bodies = Object.fromEntries(
      Object.entries(saved.bodies).map(([name, ref]) => [
        name,
        payloads.get(ref.id),
      ]),
    );
    await prune(new Set(refs(saved).map((ref) => ref.id)));
    hot = control;
    return control;
  });
}
export async function writeSearchStore<T extends CacheShape>(
  cache: T,
): Promise<{ bytes: number; records: number }> {
  const callEpoch = epoch;
  return serial(async () => {
    if (callEpoch !== epoch)
      throw new SearchStoreError("cancelled", "搜索缓存写入已取消。");
    await ensureKey();
    const prior = await manifest();
    const previousIds = new Set(refs(prior).map((ref) => ref.id));
    // Clean orphaned staging records from any prior interrupted/failed attempt.
    await prune(previousIds);
    const known = new Map(
      refs(prior).map((ref) => [`${ref.kind}:${ref.digest}`, ref]),
    );
    const additions: RecordData[] = [],
      snapshots: Record<string, Ref> = {},
      bodies: Record<string, Ref> = {};
    const encode = async (kind: Kind, value: unknown): Promise<Ref> => {
      const info = await payloadInfo(value),
        lookup = `${kind}:${info.digest}`,
        existing = known.get(lookup);
      if (existing) return existing;
      const id = crypto.randomUUID(),
        iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(kind, id) },
        key!,
        encoder.encode(info.text ?? JSON.stringify(value)),
      );
      const ref: Ref = {
        id,
        digest: info.digest,
        bytes: ciphertext.byteLength + iv.byteLength,
        kind,
      };
      known.set(lookup, ref);
      additions.push({ id, kind, iv: iv.buffer, ciphertext });
      return ref;
    };
    for (const source of cache.sources)
      if (source.snapshot !== undefined)
        snapshots[source.id] = await encode("snapshot", source.snapshot);
    for (const [name, body] of Object.entries(cache.bodies))
      bodies[name] = await encode("body", body);
    const { sources, bodies: _bodyValues, ...rest } = cache;
    const control = {
      ...rest,
      sources: sources.map(({ snapshot: _snapshot, ...source }) => source),
    };
    const value: Manifest = {
      version: 2,
      keyId: keyData!.id,
      control,
      snapshots,
      bodies,
      bytes: 0,
    };
    const unique = new Map(refs(value).map((ref) => [ref.id, ref]));
    value.bytes =
      [...unique.values()].reduce((sum, ref) => sum + ref.bytes, 0) +
      encoder.encode(JSON.stringify(value)).length;
    if (value.bytes > SEARCH_STORE_BYTES)
      throw new SearchStoreError(
        "limit",
        "加密搜索缓存超过 64 MiB 安全上限，未提交本次写入。",
      );
    if (encoder.encode(JSON.stringify(value)).length > SEARCH_MANIFEST_BYTES)
      throw new SearchStoreError(
        "limit",
        "搜索控制清单超过 2 MiB 上限，覆盖范围已截断；已有数据仍可查询。",
      );
    if (callEpoch !== epoch)
      throw new SearchStoreError("cancelled", "搜索缓存写入已取消。");
    // Commit encrypted records first. Old referenced records remain until the
    // session manifest commits, so a failed session write cannot corrupt it.
    if (additions.length)
      await transaction("readwrite", (store) => {
        for (const item of additions) store.put(item);
      });
    if (callEpoch !== epoch)
      throw new SearchStoreError("cancelled", "搜索缓存写入已取消。");
    try {
      await chrome.storage.session.set({ [MANIFEST_KEY]: value });
    } catch {
      // New ciphertext is not reachable until the manifest commits. Remove it
      // on failure, preserving every record needed by the previous manifest.
      await prune(previousIds);
      throw new SearchStoreError(
        "storage",
        "搜索控制清单写入失败；本次更新未完成，原缓存保留。",
      );
    }
    if (callEpoch !== epoch)
      throw new SearchStoreError("cancelled", "搜索缓存写入已取消。");
    await prune(new Set(unique.keys()));
    hot = cache;
    return { bytes: value.bytes, records: unique.size };
  });
}
export async function clearSearchStore(): Promise<void> {
  ++epoch;
  hot = undefined;
  return serial(async () => {
    await transaction("readwrite", (store) => {
      store.clear();
    });
    await chrome.storage.session.set({
      [MANIFEST_KEY]: null,
      [SESSION_KEY]: null,
    });
    key = undefined;
    keyData = undefined;
    hot = undefined;
  });
}
function payloadSize(value: unknown): number {
  if (value && typeof value === "object") {
    const cached = sizeCache.get(value);
    if (cached !== undefined) return cached;
    const size = encoder.encode(JSON.stringify(value)).length;
    sizeCache.set(value, size);
    return size;
  }
  return encoder.encode(JSON.stringify(value)).length;
}
/** Conservative in-memory estimate used before staging; write enforces exact unique ciphertext bytes. */
export function estimateSearchStoreBytes(cache: CacheShape): number {
  const { sources, bodies, ...rest } = cache;
  let size = encoder.encode(
    JSON.stringify({
      ...rest,
      sources: sources.map(({ snapshot: _snapshot, ...source }) => source),
    }),
  ).length;
  const seenBodies = new Set<string>(),
    seenSnapshots = new Set<unknown>();
  for (const source of sources)
    if (source.snapshot !== undefined && !seenSnapshots.has(source.snapshot)) {
      seenSnapshots.add(source.snapshot);
      size += payloadSize(source.snapshot) + 256;
    }
  for (const [name, body] of Object.entries(bodies)) {
    const entry = body as {
      identity?: string;
      status?: string;
      reason?: string;
    };
    const identity = entry.identity
      ? JSON.stringify([entry.identity, entry.status, entry.reason])
      : name;
    if (!seenBodies.has(identity)) {
      seenBodies.add(identity);
      size += payloadSize(body) + 256;
    }
  }
  return size;
}

export async function searchStoreGeneration(): Promise<number> {
  try {
    const value = (await chrome.storage.session.get(MANIFEST_KEY))[
      MANIFEST_KEY
    ] as Manifest | undefined;
    const generation = value?.control?.generation;
    return Number.isSafeInteger(generation) ? Number(generation) : 0;
  } catch {
    return 0;
  }
}
