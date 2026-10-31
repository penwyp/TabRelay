import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Snapshot } from "../src/types";
const mocks = vi.hoisted(() => ({
  state: {} as any,
  listDevices: vi.fn(),
  readSnapshot: vi.fn(),
  listHistory: vi.fn(),
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
  mocks.state = { deviceId: "local", settings: structuredClone(settings) };
  vi.stubGlobal("chrome", {
    storage: {
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
  await clearSearch();
});
describe("search local cache and ranking", () => {
  it("querying an unloaded cache never networks", async () => {
    expect((await querySearch("example")).results).toEqual([]);
    expect(mocks.listDevices).not.toHaveBeenCalled();
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
  });
  it("current-only loading exposes unknown history coverage without fetching it", async () => {
    await loadSearch(false);
    const coverage = await settled();
    expect(mocks.listHistory).not.toHaveBeenCalled();
    expect(coverage.sources.map((s) => s.status)).toEqual([
      "loaded",
      "not-loaded",
    ]);
    expect(coverage.sources[1].errorCode).toBe("history-not-loaded");
    expect(coverage.completed).toBe(1);
    expect(coverage.devicesLoaded).toBe(1);
    expect(coverage.sources[0]).not.toHaveProperty("snapshot");
  });
  it("retains Chinese matching, distinct same-URL occurrences and source identity", async () => {
    await loadSearch(false);
    await settled();
    const chinese = await querySearch("中文");
    expect(chinese.total).toBe(1);
    const duplicate = await querySearch("example.com");
    expect(duplicate.total).toBe(2);
    expect(new Set(duplicate.results.map((r) => r.id)).size).toBe(2);
    expect(duplicate.results.every((r) => r.groupTitle === "数据库研究")).toBe(
      true,
    );
    const result = await getSearchResult(duplicate.results[0].id);
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
      ).total,
    ).toBe(4);
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
    expect((await querySearch("example")).total).toBe(2);
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
});
