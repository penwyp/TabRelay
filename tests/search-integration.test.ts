/** Search service integration against simulated session storage and WebDAV, not browser E2E. */
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import type { Snapshot } from "../src/types";
let state: any,
  session: Record<string, any>,
  listDevices: any,
  readSnapshot: any,
  listHistory: any;
const clone = <T>(x: T): T => structuredClone(x);
class FakeWebDAVError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const snapshot = (
  deviceId = "device-a",
  snapshotId = "current-a",
  tabs = true,
): Snapshot => ({
  schemaVersion: 1,
  deviceId,
  snapshotId,
  revision: 1,
  capturedAt: "2026-10-31T16:00:00Z",
  windows: tabs
    ? [
        {
          windowKey: "w1",
          order: 0,
          groups: [],
          tabs: [
            {
              tabKey: "t1",
              url: "https://example.org/cost?token=secret",
              title: "资源成本治理 GPU 预算",
              index: 0,
              pinned: false,
              origin: { deviceId, tabKey: "t1" },
            },
          ],
        },
      ]
    : [],
});
const devices = (...ids: string[]) =>
  ids.map((deviceId) => ({
    deviceId,
    name: deviceId,
    version: "1.2.0",
    updatedAt: "2026-10-31T16:00:00Z",
    windows: 1,
    tabs: 1,
  }));
async function settle(predicate: () => Promise<boolean>, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw Error("Search test timed out");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetModules();
  session = {};
  state = {
    deviceId: "local-device",
    settings: {
      ...DEFAULT_SETTINGS,
      endpoint: "https://dav.example.org/",
      enabled: true,
    },
    sync: {},
    identities: {},
  };
  listDevices = vi.fn(async () => devices("device-a"));
  readSnapshot = vi.fn(async (deviceId: string, kind: string) =>
    snapshot(deviceId, kind === "current" ? "current-a" : kind + "-a"),
  );
  listHistory = vi.fn(async () => ["000000000001-history-a.json"]);
  vi.doMock("../src/state", () => ({ load: async () => clone(state) }));
  vi.doMock("../src/webdav", () => ({
    WebDAVError: FakeWebDAVError,
    WebDAVRepository: class {
      listDevices = listDevices;
      readSnapshot = readSnapshot;
      listHistory = listHistory;
    },
  }));
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: clone(session[key]) }),
        set: async (values: any) => {
          Object.assign(session, clone(values));
        },
      },
    },
  });
});
afterEach(() => {
  vi.doUnmock("../src/state");
  vi.doUnmock("../src/webdav");
});
describe("search loading lifecycle and truthful coverage", () => {
  it("does not equate never-loaded cache with a successfully loaded empty snapshot", async () => {
    const search = await import("../src/search");
    const initial = await search.querySearch("");
    expect(initial.total).toBe(0);
    expect(initial.coverage.updatedAt).toBeUndefined();
    expect(listDevices).not.toHaveBeenCalled();
    readSnapshot.mockResolvedValue(snapshot("device-a", "empty", false));
    await search.loadSearch(false);
    await settle(async () => !(await search.searchStatus()).loading);
    const after = await search.querySearch("");
    expect(after.total).toBe(0);
    expect(
      after.coverage.sources.find((s) => s.kind === "current")?.status,
    ).toBe("loaded");
    expect(
      after.coverage.sources.find((s) => s.kind === "history")?.status,
    ).toBe("not-loaded");
    expect(after.coverage.updatedAt).toEqual(expect.any(String));
    expect(listHistory).not.toHaveBeenCalled();
  });
  it("records source failure separately from empty recovery and unrequested history", async () => {
    const search = await import("../src/search");
    listDevices.mockResolvedValue(devices("device-a", "device-b"));
    readSnapshot.mockImplementation(async (deviceId: string, kind: string) => {
      if (deviceId === "device-b" && kind === "current")
        throw new FakeWebDAVError("unauthorized", "认证失败");
      return snapshot(deviceId, `${kind}-${deviceId}`, kind !== "recovery");
    });
    await search.loadSearch(true);
    await settle(async () => !(await search.searchStatus()).loading);
    const status = await search.searchStatus();
    expect(
      status.sources.find(
        (s) => s.deviceId === "device-b" && s.kind === "current",
      ),
    ).toMatchObject({ status: "failed", errorCode: "unauthorized" });
    expect(
      status.sources.find(
        (s) => s.deviceId === "device-a" && s.kind === "recovery",
      )?.status,
    ).toBe("loaded");
    const result = await search.querySearch("GPU");
    expect(result.total).toBe(3);
    expect(result.results.every((r) => !r.url.includes("secret"))).toBe(true);
    expect(result.coverage.sources.every((s) => s.snapshot === undefined)).toBe(
      true,
    );
    expect(JSON.stringify(result.coverage)).not.toContain("configFingerprint");
    const calls = readSnapshot.mock.calls.length;
    await search.querySearch("资源");
    await search.querySearch("not-present");
    expect(readSnapshot).toHaveBeenCalledTimes(calls);
  });
  it("cancellation retains completed sources but blocks late in-flight writes", async () => {
    const search = await import("../src/search");
    const slow = deferred<Snapshot>();
    listDevices.mockResolvedValue(devices("device-a", "device-b"));
    readSnapshot.mockImplementation(async (deviceId: string) =>
      deviceId === "device-a" ? snapshot("device-a") : slow.promise,
    );
    await search.loadSearch(false);
    await settle(async () =>
      readSnapshot.mock.calls.some((args: any[]) => args[0] === "device-b"),
    );
    const before = await search.searchStatus();
    expect(
      before.sources.find(
        (s) => s.deviceId === "device-a" && s.kind === "current",
      )?.status,
    ).toBe("loaded");
    await search.cancelSearch();
    const cancelled = await search.searchStatus();
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.loading).toBe(false);
    const retained = JSON.stringify(cancelled.sources);
    slow.resolve(snapshot("device-b"));
    await new Promise((r) => setTimeout(r, 20));
    const after = await search.searchStatus();
    expect(JSON.stringify(after.sources)).toBe(retained);
    expect(after.cancelled).toBe(true);
    expect((await search.querySearch("GPU")).total).toBe(1);
  });
  it("clear and a new generation cannot be overwritten by a previous slow load", async () => {
    const search = await import("../src/search");
    const old = deferred<Snapshot>();
    readSnapshot.mockImplementationOnce(() => old.promise);
    await search.loadSearch(false);
    await settle(async () => readSnapshot.mock.calls.length === 1);
    const first = (await search.searchStatus()).generation;
    await search.clearSearch();
    listDevices.mockResolvedValue(devices("device-new"));
    readSnapshot.mockResolvedValue(snapshot("device-new", "new-data"));
    await search.loadSearch(false);
    await settle(async () => !(await search.searchStatus()).loading);
    old.resolve(snapshot("device-a", "obsolete"));
    await new Promise((r) => setTimeout(r, 20));
    const result = await search.querySearch("GPU");
    expect(result.coverage.generation).toBeGreaterThan(first);
    expect(result.results.map((r) => r.deviceId)).toEqual(["device-new"]);
  });
  it("configuration changes invalidate cached results and stale identifiers", async () => {
    const search = await import("../src/search");
    await search.loadSearch(false);
    await settle(async () => !(await search.searchStatus()).loading);
    const hit = (await search.querySearch("GPU")).results[0];
    state.settings.blacklist = ["example.org"];
    const result = await search.querySearch("GPU");
    expect(result.total).toBe(0);
    expect(result.coverage.error).toContain("配置");
    await expect(search.getSearchResult(hit.id)).rejects.toThrow();
    await expect(search.getSearchSource(hit.sourceId)).rejects.toThrow();
  });
  it("settings mutation while a response is pending discards that response", async () => {
    const search = await import("../src/search");
    const pending = deferred<Snapshot>();
    readSnapshot.mockImplementationOnce(() => pending.promise);
    await search.loadSearch(false);
    await settle(async () => readSnapshot.mock.calls.length === 1);
    state.settings.endpoint = "https://another.example.org/";
    pending.resolve(snapshot());
    await settle(async () => !(await search.searchStatus()).loading);
    const after = await search.querySearch("GPU");
    expect(after.total).toBe(0);
    expect(after.coverage.error).toContain("配置");
    expect(after.coverage.sources).toEqual([]);
  });
  it("worker-module restart reports interrupted load without silently resuming network", async () => {
    const search = await import("../src/search");
    await search.loadSearch(false);
    await settle(async () => !(await search.searchStatus()).loading);
    session.searchCache.loading = true;
    const calls = listDevices.mock.calls.length;
    vi.resetModules();
    const restarted = await import("../src/search");
    const status = await restarted.searchStatus();
    expect(status.loading).toBe(false);
    expect(status.cancelled).toBe(true);
    expect(status.error).toContain("中断");
    expect((await restarted.querySearch("GPU")).total).toBe(1);
    expect(listDevices).toHaveBeenCalledTimes(calls);
  });
});
