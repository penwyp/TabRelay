import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Snapshot } from "../src/types";
const mocks = vi.hoisted(() => ({
  state: {} as any,
  listDevices: vi.fn(),
  readSnapshot: vi.fn(),
  listHistory: vi.fn(),
  readText: vi.fn(),
}));
vi.mock("../src/state", () => ({
  load: async () => structuredClone(mocks.state),
}));
vi.mock("../src/webdav", () => ({
  WebDAVError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  WebDAVRepository: class {
    listDevices = mocks.listDevices;
    readSnapshot = mocks.readSnapshot;
    listHistory = mocks.listHistory;
    readText = mocks.readText;
  },
}));
import {
  clearSearch,
  searchStatus,
  loadSearch,
  cancelSearch,
  querySearch,
  getSearchSource,
  getSearchResult,
  SEARCH_LIMITS,
  autoSearch,
  rebuildSearch,
} from "../src/search";
const settings: Settings = {
  endpoint: "https://dav.example/",
  username: "private-user",
  password: "private-password",
  deviceName: "Local",
  enabled: true,
  blacklist: ["private.example"],
  stripParams: ["token"],
  historyLimit: 20,
  encryptionPassphrase: "private-passphrase",
};
let session: Record<string, any>;
let local: Record<string, any>;
function snapshot(
  deviceId = "device-A",
  title = "中文研究",
  revision = 1,
): Snapshot {
  return {
    schemaVersion: 1,
    deviceId,
    snapshotId: `snapshot-${revision}`,
    revision,
    capturedAt: `2026-10-${String(20 + revision).padStart(2, "0")}T10:00:00Z`,
    windows: [
      {
        windowKey: "window-1",
        order: 0,
        groups: [
          {
            groupKey: "group-1",
            title: "数据库研究",
            color: "blue",
            collapsed: false,
          },
        ],
        tabs: [
          {
            tabKey: "tab-1",
            url: "https://example.com/docs?token=secret&lang=zh",
            title,
            index: 0,
            pinned: false,
            groupKey: "group-1",
            origin: { deviceId, tabKey: "tab-1" },
          },
          {
            tabKey: "tab-2",
            url: "https://example.com/docs?token=secret&lang=zh",
            title: "独立来源",
            index: 1,
            pinned: false,
            groupKey: "group-1",
            origin: { deviceId, tabKey: "tab-2" },
          },
          {
            tabKey: "tab-3",
            url: "https://private.example/secret",
            title: "Hidden",
            index: 2,
            pinned: false,
            origin: { deviceId, tabKey: "tab-3" },
          },
        ],
      },
    ],
  };
}
async function settled() {
  for (let i = 0; i < 100; i++) {
    const s = await searchStatus();
    if (!s.loading) return s;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw Error("load did not finish");
}
beforeEach(async () => {
  session = {};
  local = {};
  mocks.state = { deviceId: "local", settings: structuredClone(settings) };
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]: structuredClone(local[key]),
        })),
        set: vi.fn(async (value: Record<string, any>) => {
          Object.assign(local, structuredClone(value));
        }),
      },
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: structuredClone(session[key]),
        })),
        set: vi.fn(async (value: Record<string, any>) => {
          Object.assign(session, structuredClone(value));
        }),
      },
    },
  });
  mocks.listDevices
    .mockReset()
    .mockResolvedValue([{ deviceId: "device-A", name: "Laptop" }]);
  mocks.readSnapshot
    .mockReset()
    .mockImplementation(
      async (deviceId: string, _kind: string, historyId?: string) =>
        snapshot(
          deviceId,
          historyId ? "历史页面" : "中文研究",
          historyId ? 2 : 1,
        ),
    );
  mocks.listHistory
    .mockReset()
    .mockResolvedValue(["000000000002-snapshot-2.json"]);
  mocks.readText
    .mockReset()
    .mockResolvedValue("只有正文中的独特关键词 bodyneedle");
  await clearSearch();
});
describe("search local cache and ranking", () => {
  it("querying an unloaded cache never networks", async () => {
    expect((await querySearch("example")).results).toEqual([]);
    expect(mocks.listDevices).not.toHaveBeenCalled();
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
  });
  it("all retained sources load automatically even for legacy false flag", async () => {
    await loadSearch(false);
    const coverage = await settled();
    expect(mocks.listHistory).toHaveBeenCalledOnce();
    expect(coverage.sources.map((source) => source.kind)).toEqual([
      "current",
      "recovery",
      "history",
    ]);
    expect(coverage.completed).toBe(3);
    expect(coverage.devicesLoaded).toBe(1);
    expect(coverage.sources[0]).not.toHaveProperty("snapshot");
  });

  it("retains Chinese matching, distinct same-URL occurrences and source identity", async () => {
    await loadSearch(false);
    await settled();
    const chinese = await querySearch("中文");
    expect(chinese.total).toBe(1);
    const duplicate = await querySearch("example.com");
    expect(duplicate.total).toBe(3);
    expect(duplicate.occurrenceTotal).toBe(6);
    expect(
      new Set(duplicate.results.flatMap((r) => r.occurrences!.map((o) => o.id)))
        .size,
    ).toBe(6);
    expect(duplicate.results.every((r) => r.groupTitle === "数据库研究")).toBe(
      true,
    );
    const result = await getSearchResult(chinese.results[0].id);
    const source = await getSearchSource(result.sourceId);
    expect(source.snapshot?.snapshotId).toBe("snapshot-1");
    source.snapshot!.windows[0].tabs[0].title = "Mutated";
    expect(
      (await getSearchSource(result.sourceId)).snapshot?.windows[0].tabs[0]
        .title,
    ).toBe("中文研究");
  });
  it("filters private domains and strips query secrets before persisting", async () => {
    const remote: any = snapshot();
    remote.password = "remote-extra-secret";
    remote.windows[0].tabs[0].credential = "extra-secret";
    mocks.readSnapshot.mockResolvedValue(remote);
    await loadSearch(false);
    await settled();
    const raw = JSON.stringify(session.searchCache);
    for (const secret of [
      "private-password",
      "private-user",
      "private-passphrase",
      "remote-extra-secret",
      "extra-secret",
      "token=secret",
      "private.example",
    ])
      expect(raw).not.toContain(secret);
    expect((await querySearch("example")).results[0].url).toBe(
      "https://example.com/docs?lang=zh",
    );
  });
  it("exact field matches rank before substring and filters run before limit", async () => {
    mocks.listDevices.mockResolvedValue([
      { deviceId: "device-A", name: "A" },
      { deviceId: "device-B", name: "B" },
    ]);
    mocks.readSnapshot.mockImplementation(async (device: string) =>
      snapshot(
        device,
        device === "device-A" ? "prefix needle suffix" : "needle",
      ),
    );
    await loadSearch(false);
    await settled();
    expect((await querySearch("needle", {}, 1)).results[0].deviceId).toBe(
      "device-B",
    );
    expect(
      (await querySearch("needle", { deviceId: "device-A" }, 1)).results[0]
        .deviceId,
    ).toBe("device-A");
    expect(
      (
        await querySearch(
          "",
          { group: "数据库", domain: "example.com", pinned: false },
          1,
        )
      ).occurrenceTotal,
    ).toBe(12);
    expect((await querySearch("", { pinned: true })).total).toBe(0);
  });
  it("opt-in historical load includes recovery and retained versions with bounded time filters", async () => {
    await loadSearch(true);
    const coverage = await settled();
    expect(mocks.listHistory).toHaveBeenCalledOnce();
    expect(coverage.sources.map((s) => s.kind)).toEqual([
      "current",
      "recovery",
      "history",
    ]);
    expect(coverage.earliestObservedAt).toBe("2026-10-21T10:00:00Z");
    const result = await querySearch("", {
      kind: "history",
      after: "2026-10-22T00:00:00Z",
    });
    expect(result.total).toBe(2);
    expect(result.results.every((r) => r.kind === "history" && r.stale)).toBe(
      true,
    );
    expect((await querySearch("", { before: "2026-10-20" })).total).toBe(0);
  });
  it("isolates damaged devices while retaining healthy results", async () => {
    mocks.listDevices.mockResolvedValue([
      { deviceId: "device-A", name: "A" },
      { deviceId: "device-B", name: "B" },
    ]);
    mocks.readSnapshot.mockImplementation(async (deviceId: string) =>
      deviceId === "device-A" ? snapshot(deviceId) : { schemaVersion: 55 },
    );
    await loadSearch(false);
    const coverage = await settled();
    expect(
      coverage.sources.find(
        (s) => s.deviceId === "device-B" && s.kind === "current",
      )?.status,
    ).toBe("failed");
    expect((await querySearch("example")).occurrenceTotal).toBe(6);
  });
  it("refresh replaces pruned history rather than keeping obsolete records", async () => {
    await loadSearch(true);
    await settled();
    expect((await querySearch("历史页面")).total).toBe(1);
    mocks.listHistory.mockResolvedValue([]);
    await loadSearch(true);
    await settled();
    expect((await querySearch("历史页面")).total).toBe(0);
  });
  it("settings changes invalidate existing cache without networking", async () => {
    await loadSearch(false);
    await settled();
    const calls = mocks.readSnapshot.mock.calls.length;
    mocks.state.settings.blacklist.push("example.com");
    expect((await querySearch("")).total).toBe(0);
    expect(mocks.readSnapshot).toHaveBeenCalledTimes(calls);
    expect((await searchStatus()).error).toContain("隐私");
  });
  it("cancel prevents a late network reply from repopulating the cache", async () => {
    let resolve!: (value: Snapshot) => void;
    mocks.readSnapshot.mockImplementation(
      () =>
        new Promise<Snapshot>((r) => {
          resolve = r;
        }),
    );
    await loadSearch(false);
    for (let i = 0; i < 30 && !resolve; i++)
      await new Promise((r) => setTimeout(r, 1));
    const cancelled = await cancelSearch();
    resolve(snapshot());
    await new Promise((r) => setTimeout(r, 5));
    const final = await searchStatus();
    expect(final.cancelled).toBe(true);
    expect(final.generation).toBe(cancelled.generation);
    expect((await querySearch("")).total).toBe(0);
  });
  it("clear removes source/result authority and all cached snapshots", async () => {
    await loadSearch(false);
    await settled();
    const result = (await querySearch("中文")).results[0];
    await clearSearch();
    await expect(getSearchResult(result.id)).rejects.toThrow();
    await expect(getSearchSource(result.sourceId)).rejects.toThrow();
  });
  it("enforces snapshot budget with explicit unloaded coverage", async () => {
    const old = SEARCH_LIMITS.snapshots;
    SEARCH_LIMITS.snapshots = 1;
    try {
      await loadSearch(true);
      const status = await settled();
      expect(status.truncated).toBe(true);
      expect(status.sources.filter((s) => s.status === "loaded")).toHaveLength(
        1,
      );
      expect(status.sources.some((s) => s.errorCode === "limit")).toBe(true);
    } finally {
      SEARCH_LIMITS.snapshots = old;
    }
  });
  it("does not resolve obsolete source or result IDs to a refreshed snapshot", async () => {
    await loadSearch(false);
    await settled();
    const old = (await querySearch("中文")).results[0];
    await loadSearch(false);
    await settled();
    const fresh = (await querySearch("中文")).results[0];
    expect(fresh.sourceId).not.toBe(old.sourceId);
    expect(fresh.id).not.toBe(old.id);
    await expect(getSearchSource(old.sourceId)).rejects.toThrow();
    await expect(getSearchResult(old.id)).rejects.toThrow();
  });
  it("reports enumeration failures and truncation without hiding healthy devices", async () => {
    mocks.listDevices.mockImplementation(async (onIssue: any) => {
      onIssue({
        deviceId: "bad-device",
        code: "unauthorized",
        message: "设备读取失败",
      });
      onIssue({ deviceId: "*", code: "limit", message: "设备过多" });
      return [{ deviceId: "device-A", name: "Laptop" }];
    });
    await loadSearch(false);
    const status = await settled();
    expect(status.truncated).toBe(true);
    expect(status.error).toContain("不完整");
    expect(
      status.sources.some((source) => source.errorCode === "unauthorized"),
    ).toBe(true);
    expect((await querySearch("中文")).total).toBe(1);
  });
  it("automatically loads once, then performs no network for fresh repeated input", async () => {
    await autoSearch();
    await settled();
    const reads = mocks.readSnapshot.mock.calls.length;
    await autoSearch();
    await querySearch("中文");
    await autoSearch();
    expect(mocks.readSnapshot).toHaveBeenCalledTimes(reads);
  });
  it("clear pauses persistently until explicit rebuild", async () => {
    await autoSearch();
    await settled();
    await clearSearch(true);
    const calls = mocks.listDevices.mock.calls.length;
    session = {};
    expect((await autoSearch()).paused).toBe(true);
    expect(mocks.listDevices).toHaveBeenCalledTimes(calls);
    await rebuildSearch();
    await settled();
    expect((await searchStatus()).paused).toBe(false);
    expect(mocks.listDevices).toHaveBeenCalledTimes(calls + 1);
  });
  it("reuses immutable history but re-reads current and recovery incrementally", async () => {
    await loadSearch();
    await settled();
    mocks.readSnapshot.mockClear();
    await loadSearch();
    await settled();
    expect(mocks.readSnapshot.mock.calls.map((call) => call[1])).toEqual([
      "current",
      "recovery",
    ]);
  });
  it("keeps known snapshots as explicitly stale when refresh fails", async () => {
    await loadSearch();
    await settled();
    mocks.readSnapshot.mockRejectedValue(Error("offline secret-password"));
    await loadSearch();
    const coverage = await settled();
    const current = coverage.sources.find(
      (source) => source.kind === "current",
    )!;
    expect(current.status).toBe("loaded");
    expect(current.stale).toBe(true);
    expect(current.error).toBeTruthy();
    expect((await querySearch("中文")).occurrenceTotal).toBe(2);
    expect(JSON.stringify(session)).not.toContain("offline secret-password");
  });
  it("matches body-only text, reuses objects and aggregates identical content across owners", async () => {
    mocks.listDevices.mockResolvedValue([
      { deviceId: "device-A", name: "A" },
      { deviceId: "device-B", name: "B" },
    ]);
    mocks.listHistory.mockResolvedValue([]);
    mocks.readSnapshot.mockImplementation(async (deviceId: string) => {
      const value = snapshot(deviceId);
      value.schemaVersion = 2;
      value.snapshotId = "20261021-100000Z-r000001";
      value.windows[0].tabs = value.windows[0].tabs.slice(0, 1);
      value.windows[0].tabs[0].content = {
        status: "available",
        ref: {
          ownerDeviceId: deviceId,
          objectId: (deviceId === "device-A" ? "a" : "b").repeat(64),
          bytes: 48,
          observedAt: value.capturedAt,
          captureUrl: value.windows[0].tabs[0].url,
        },
      };
      return value;
    });
    await loadSearch();
    await settled();
    const result = await querySearch("bodyneedle");
    expect(result.total).toBe(1);
    expect(result.occurrenceTotal).toBe(4);
    expect(result.results[0].occurrences).toHaveLength(4);
    expect(result.results[0].bodySnippet).toContain("bodyneedle");
    expect(mocks.readText).toHaveBeenCalledTimes(2);
    await loadSearch();
    await settled();
    expect(mocks.readText).toHaveBeenCalledTimes(2);
    expect(
      (await querySearch("bodyneedle", { deviceId: "device-B" }))
        .occurrenceTotal,
    ).toBe(2);
  });
  it("does not fetch a body with mismatched capture URL, but still indexes metadata", async () => {
    mocks.readSnapshot.mockImplementation(async () => {
      const value = snapshot();
      value.schemaVersion = 2;
      value.snapshotId = "20261021-100000Z-r000001";
      value.windows[0].tabs[0].content = {
        status: "available",
        ref: {
          ownerDeviceId: "device-A",
          objectId: "a".repeat(64),
          bytes: 10,
          observedAt: value.capturedAt,
          captureUrl: "https://another.example/",
        },
      };
      return value;
    });
    await loadSearch();
    await settled();
    expect(mocks.readText).not.toHaveBeenCalled();
    const result = await querySearch("中文");
    expect(result.total).toBe(1);
    expect(result.results[0].contentReason).toContain("不一致");
  });
  it("rejects an interim cached source ID when refreshed current content replaces it", async () => {
    await loadSearch();
    await settled();
    let resolve!: (value: Snapshot) => void;
    mocks.readSnapshot.mockImplementation(
      async (deviceId: string, kind: string) =>
        kind === "current"
          ? new Promise<Snapshot>((r) => {
              resolve = r;
            })
          : snapshot(deviceId),
    );
    await loadSearch();
    for (let i = 0; i < 50 && !resolve; i++)
      await new Promise((r) => setTimeout(r, 1));
    const interim = (await searchStatus()).sources.find(
      (source) => source.kind === "current",
    )!;
    expect((await getSearchSource(interim.id)).snapshot?.snapshotId).toBe(
      "snapshot-1",
    );
    const oldLeaf = JSON.stringify([interim.id, "window-1", "tab-1"]);
    expect((await getSearchResult(oldLeaf)).title).toBe("中文研究");
    resolve(snapshot("device-A", "New current content", 3));
    await settled();
    await expect(getSearchSource(interim.id)).rejects.toThrow();
    await expect(getSearchResult(oldLeaf)).rejects.toThrow();
    expect((await querySearch("New current content")).total).toBe(1);
  });
  it("bounds combined metadata and body cache, preserving metadata when body is over budget", async () => {
    const prior = SEARCH_LIMITS.bytes;
    SEARCH_LIMITS.bytes = 6000;
    mocks.listHistory.mockResolvedValue([]);
    mocks.readText.mockResolvedValue("bodytext".repeat(2500));
    mocks.readSnapshot.mockImplementation(async () => {
      const value = snapshot();
      value.schemaVersion = 2;
      value.snapshotId = "20261021-100000Z-r000001";
      value.windows[0].tabs = value.windows[0].tabs.slice(0, 1);
      value.windows[0].tabs[0].content = {
        status: "available",
        ref: {
          ownerDeviceId: "device-A",
          objectId: "a".repeat(64),
          bytes: 20000,
          observedAt: value.capturedAt,
          captureUrl: value.windows[0].tabs[0].url,
        },
      };
      return value;
    });
    try {
      await loadSearch();
      const status = await settled();
      expect(status.truncated).toBe(true);
      expect(
        new TextEncoder().encode(JSON.stringify(session.searchCache)).length,
      ).toBeLessThanOrEqual(6000);
      expect((await querySearch("中文")).total).toBe(1);
      expect((await querySearch("bodytext")).total).toBe(0);
    } finally {
      SEARCH_LIMITS.bytes = prior;
    }
  });
  it.each(["missing", "tampered"])(
    "local clear and rebuild recover from %s encrypted payloads",
    async (mode) => {
      await loadSearch();
      await settled();
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tabrelay-search-v2", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("records", "readwrite"),
          store = tx.objectStore("records");
        if (mode === "missing") store.clear();
        else {
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (current) {
              const value = current.value;
              value.ciphertext = new Uint8Array([1, 2, 3]).buffer;
              current.update(value);
              current.continue();
            }
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
      vi.resetModules();
      const restarted = await import("../src/search");
      await expect(restarted.searchStatus()).rejects.toMatchObject({
        code: "corrupt",
      });
      if (mode === "missing") {
        await restarted.clearSearch(true);
        expect((await restarted.querySearch("")).total).toBe(0);
      }
      await restarted.rebuildSearch();
      for (let n = 0; n < 100; n++) {
        if (!(await restarted.searchStatus()).loading) break;
        await new Promise((r) => setTimeout(r, 1));
      }
      expect((await restarted.querySearch("中文")).total).toBe(1);
      await restarted.clearSearch();
    },
  );
});
