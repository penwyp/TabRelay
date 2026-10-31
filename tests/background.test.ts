import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { DEFAULT_SETTINGS } from "../src/model";
import type { Snapshot } from "../src/types";
let store: Record<string, any>,
  sessionStore: Record<string, any>,
  chromeMock: any,
  publish: any,
  connectionTest: any,
  collect: any,
  messageListener: any;
const copy = <T>(x: T): T => structuredClone(x);
const snap = (id = "first", url = "https://example.org/"): Snapshot => ({
  schemaVersion: 1,
  deviceId: "local-device",
  snapshotId: id,
  revision: 1,
  capturedAt: "2026-10-31T00:00:00Z",
  windows: [
    {
      windowKey: "w",
      order: 0,
      groups: [],
      tabs: [
        {
          tabKey: "t",
          url,
          title: "example",
          index: 0,
          pinned: false,
          origin: { deviceId: "local-device", tabKey: "t" },
        },
      ],
    },
  ],
});
function event() {
  return { addListener: vi.fn() };
}
async function send(
  message: any,
  sender = {
    id: "test-extension",
    url: "chrome-extension://test-extension/sidepanel.html",
  },
): Promise<any> {
  return new Promise((resolve) => messageListener(message, sender, resolve));
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("indexedDB", new IDBFactory());
  store = {
    state: {
      deviceId: "local-device",
      settings: {
        ...DEFAULT_SETTINGS,
        endpoint: "https://dav.example.org/",
        enabled: true,
      },
      sync: { dirty: true, generation: 5, revision: 0, retryCount: 0 },
      identities: {
        browserSession: "session",
        tabs: {},
        windows: {},
        groups: {},
      },
    },
  };
  sessionStore = { browserSession: "session" };
  connectionTest = vi.fn(async () => {});
  publish = vi.fn(async () => ({ etag: '"v1"' }));
  collect = vi.fn(async () => copy(snap()));
  vi.doMock("../src/webdav", () => ({
    WebDAVRepository: class {
      publish = publish;
      connectionTest = connectionTest;
      listDevices = vi.fn();
      readSnapshot = vi.fn();
      listHistory = vi.fn();
    },
  }));
  vi.doMock("../src/collector", () => ({ collect }));
  vi.doMock("../src/restore", () => ({
    prepare: vi.fn(),
    execute: vi.fn(async () => {}),
    cancel: vi.fn(),
    undo: vi.fn(),
    isRestoring: () => false,
    interruptOnBoot: vi.fn(async () => {}),
  }));
  chromeMock = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: copy(sessionStore[key]) }),
        set: async (data: any) => {
          Object.assign(sessionStore, copy(data));
        },
        setAccessLevel: vi.fn(async () => {}),
      },
      local: {
        get: async (key: string) => ({ [key]: copy(store[key]) }),
        set: async (data: any) => {
          Object.assign(store, copy(data));
        },
        remove: async (key: string) => {
          delete store[key];
        },
        setAccessLevel: vi.fn(async () => {}),
      },
    },
    runtime: {
      id: "test-extension",
      getManifest: () => ({ version: "1.2.0" }),
      getURL: (p: string) => "chrome-extension://test-extension/" + p,
      onMessage: {
        addListener: (fn: any) => {
          messageListener = fn;
        },
      },
      onStartup: event(),
      onInstalled: event(),
    },
    tabs: {},
    windows: {
      onCreated: event(),
      onRemoved: event(),
      getAll: vi.fn(async () => []),
    },
    tabGroups: {},
    alarms: { create: vi.fn(async () => {}), onAlarm: event() },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    permissions: { contains: vi.fn(async () => true), onRemoved: event() },
  };
  for (const k of [
    "onCreated",
    "onUpdated",
    "onRemoved",
    "onMoved",
    "onAttached",
    "onDetached",
    "onActivated",
  ])
    chromeMock.tabs[k] = event();
  for (const k of ["onCreated", "onUpdated", "onRemoved", "onMoved"])
    chromeMock.tabGroups[k] = event();
  vi.stubGlobal("chrome", chromeMock);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.doUnmock("../src/webdav");
  vi.doUnmock("../src/collector");
  vi.doUnmock("../src/restore");
});
describe("sync coordinator with simulated events/storage and repository", () => {
  it("preserves runtime mappings when the browser session survives a worker restart", async () => {
    store.state.identities.windows = { "41": "logical-window" };
    store.state.identities.tabs = {
      "52": {
        key: "logical-tab",
        origin: { deviceId: "a", tabKey: "t" },
        url: "https://example.org/",
        windowKey: "logical-window",
        index: 0,
      },
    };
    const original = copy(store.state.identities);
    await import("../src/background");
    await send({ type: "GET_STATE" });
    expect(store.state.identities).toEqual(original);
    vi.resetModules();
    await import("../src/background");
    await send({ type: "GET_STATE" });
    expect(store.state.identities).toEqual(original);
    expect(sessionStore.browserSession).toBe("session");
  });
  it("invalidates runtime mappings when session storage clears on full browser relaunch", async () => {
    sessionStore = {};
    store.state.identities.windows = { "41": "old-window" };
    store.state.identities.tabs = { "52": { key: "old-tab" } };
    store.state.identities.groups = { "63": "old-group" };
    store.state.current = snap("previous-capture");
    store.state.operation = {
      id: "old-operation",
      browserSession: "session",
      status: "INTERRUPTED",
      syncStatus: "pending",
    };
    await import("../src/background");
    await send({ type: "GET_STATE" });
    expect(sessionStore.browserSession).toEqual(expect.any(String));
    expect(sessionStore.browserSession).not.toBe("session");
    expect(store.state.identities.browserSession).toBe(
      sessionStore.browserSession,
    );
    expect(store.state.identities.windows).toEqual({});
    expect(store.state.identities.tabs).toEqual({});
    expect(store.state.identities.groups).toEqual({});
    expect(store.state.current.snapshotId).toBe("previous-capture");
    expect(store.state.operation.browserSession).toBe("session");
    expect(store.state.sync.dirty).toBe(true);
  });
  it("invalidates copied local mappings when an existing session marker differs", async () => {
    sessionStore.browserSession = "another-browser-session";
    store.state.identities.windows = { "41": "copied-window" };
    await import("../src/background");
    await send({ type: "GET_STATE" });
    expect(store.state.identities.browserSession).toBe(
      "another-browser-session",
    );
    expect(store.state.identities.windows).toEqual({});
  });
  it("durably stores pending version before network and advances revision only after success", async () => {
    const { sync } = await import("../src/background");
    publish.mockImplementation(async (s: Snapshot) => {
      expect(store.state.sync.pending.snapshotId).toBe(s.snapshotId);
      expect(store.state.sync.revision).toBe(0);
      return { etag: '"v1"' };
    });
    await sync(true);
    expect(store.state.sync.pending).toBeUndefined();
    expect(store.state.sync.revision).toBe(1);
    expect(store.state.sync.etag).toBe('"v1"');
    expect(store.state.sync.dirty).toBe(false);
    expect(chromeMock.storage.local.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });
  it("retries durable pending snapshot before collecting newer browser changes", async () => {
    const { sync } = await import("../src/background");
    publish.mockRejectedValueOnce(Error("network unavailable"));
    await sync(true);
    expect(store.state.sync.pending.snapshotId).toBe("first");
    expect(store.state.sync.revision).toBe(0);
    store.state.sync.generation++;
    collect.mockResolvedValue(snap("newer", "https://newer.org/"));
    await sync(true);
    expect(publish.mock.calls[1][0].snapshotId).toBe("first");
    expect(collect).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[2][0].snapshotId).toBe("newer");
    expect(publish).toHaveBeenCalledTimes(3);
    expect(store.state.sync.dirty).toBe(false);
  });
  it("manual restore sync reconciles old pending first then immediately publishes fresh workspace", async () => {
    store.state.sync.pending = snap("before-restore");
    store.state.settings.syncIntervalMinutes = 1440;
    store.state.operation = {
      id: "new-restore",
      status: "COMPLETED",
      syncStatus: "pending",
    };
    collect.mockResolvedValue(snap("after-restore", "https://newer.org/"));
    publish.mockImplementation(async () => {
      expect(store.state.operation.syncStatus).toBe("pending");
      return { etag: '"next"' };
    });
    const { sync } = await import("../src/background");
    await sync(true);
    expect(publish.mock.calls.map((args: any[]) => args[0].snapshotId)).toEqual(
      ["before-restore", "after-restore"],
    );
    expect(collect).toHaveBeenCalledTimes(1);
    expect(store.state.sync.dirty).toBe(false);
    expect(store.state.operation.syncStatus).toBe("synced");
  });
  it("automatic due reconciliation remains one pass and does not falsely mark newer restore synced", async () => {
    store.state.sync.pending = snap("before-restore");
    store.state.operation = {
      id: "new-restore",
      status: "COMPLETED",
      syncStatus: "pending",
    };
    const { sync } = await import("../src/background");
    await send({ type: "GET_STATE" });
    vi.setSystemTime(store.state.sync.nextDueAt + 1);
    await sync(false);
    expect(publish.mock.calls.map((args: any[]) => args[0].snapshotId)).toEqual(
      ["before-restore"],
    );
    expect(collect).not.toHaveBeenCalled();
    expect(store.state.sync.dirty).toBe(true);
    expect(store.state.operation.syncStatus).toBe("pending");
  });
  it("bounds pending-followup to two passes and preserves failed fresh publish for retry", async () => {
    store.state.sync.pending = snap("old");
    store.state.operation = {
      id: "restored",
      status: "COMPLETED",
      syncStatus: "pending",
    };
    collect.mockResolvedValue(snap("fresh"));
    publish
      .mockResolvedValueOnce({ etag: '"old"' })
      .mockRejectedValueOnce(Error("offline during fresh publish"));
    const { sync } = await import("../src/background");
    await sync(true);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map((args: any[]) => args[0].snapshotId)).toEqual(
      ["old", "fresh"],
    );
    expect(store.state.sync.pending.snapshotId).toBe("fresh");
    expect(store.state.operation.syncStatus).toBe("pending");
    expect(store.state.sync.dirty).toBe(true);
  });
  it("marks restore synced after retry and unchanged-current reconciliation", async () => {
    store.state.operation = {
      id: "restored",
      status: "COMPLETED",
      syncStatus: "pending",
    };
    const { sync } = await import("../src/background");
    publish.mockRejectedValueOnce(Error("temporary network error"));
    await sync(true);
    await sync(true);
    vi.setSystemTime(store.state.sync.nextDueAt + 1);
    await sync(false);
    expect(store.state.sync.dirty).toBe(false);
    expect(store.state.operation.syncStatus).toBe("synced");
  });
  it("never marks a mutation during capture as clean", async () => {
    const { sync } = await import("../src/background");
    collect.mockImplementation(async () => {
      store.state.sync.generation++;
      store.state.sync.dirty = true;
      return copy(snap());
    });
    await sync(true);
    expect(store.state.sync.dirty).toBe(true);
    expect(store.state.sync.generation).toBe(6);
  });
  it("serializes concurrent sync attempts", async () => {
    const { sync } = await import("../src/background");
    await Promise.all([sync(true), sync(true)]);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("pauses on a same-device conflict instead of retrying overwrite", async () => {
    const { sync } = await import("../src/background");
    publish.mockRejectedValue(
      Object.assign(Error("conflict"), { code: "conflict" }),
    );
    await sync(true);
    expect(store.state.sync.pausedConflict).toBe(true);
    expect(store.state.sync.pending).toBeDefined();
    await sync(true);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("rejects settings changes during an in-flight publication", async () => {
    const { sync } = await import("../src/background");
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    publish.mockImplementation(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { etag: '"v1"' };
    });
    const run = sync(true);
    await started;
    const result = await send({
      type: "SAVE_SETTINGS",
      settings: {
        ...store.state.settings,
        endpoint: "https://other.example.org/",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("正在进行");
    expect(store.state.settings.endpoint).toBe("https://dav.example.org/");
    release();
    await run;
  });
  it.each([
    { blacklist: ["example.org"] },
    { stripParams: ["private"] },
    { contentEnabled: true, contentOrigins: ["https://example.org"] },
    { contentOrigins: ["https://example.org"] },
  ])(
    "refuses privacy policy mutation while uncertain pending remains at the same endpoint (%j)",
    async (patch) => {
      store.state.sync.pending = snap("uncertain");
      const original = copy(store.state.settings);
      await import("../src/background");
      const result = await send({
        type: "SAVE_SETTINGS",
        settings: { ...original, ...patch },
      });
      expect(result.ok).toBe(false);
      expect(store.state.settings).toEqual(original);
      expect(store.state.sync.pending.snapshotId).toBe("uncertain");
      expect(publish).not.toHaveBeenCalled();
      expect(
        (
          await send({
            type: "SAVE_SETTINGS",
            settings: { ...original, enabled: false },
          })
        ).ok,
      ).toBe(true);
      expect(store.state.settings.enabled).toBe(false);
    },
  );
  it("blocks key rotation at an endpoint that received body objects even before snapshot revision 1", async () => {
    store.state.contentObjectEndpoint = store.state.settings.endpoint;
    store.state.sync.revision = 0;
    await import("../src/background");
    const result = await send({
      type: "SAVE_SETTINGS",
      settings: {
        ...store.state.settings,
        encryptionPassphrase: "rotated-key",
      },
    });
    expect(result.ok).toBe(false);
    expect(store.state.settings.encryptionPassphrase).toBe("");
  });
  it.each(["endpoint", "policy"])(
    "clears old body refs and capture coverage on %s change",
    async (change) => {
      const content = {
        status: "available",
        ref: {
          ownerDeviceId: "local-device",
          objectId: "a".repeat(64),
          bytes: 12,
          observedAt: "2026-10-31T00:00:00Z",
          captureUrl: "https://example.org/",
        },
      };
      store.state.current = snap();
      store.state.current.windows[0].tabs[0].content = copy(content);
      store.state.identities.tabs[1] = {
        key: "t",
        url: "https://example.org/",
        windowKey: "w",
        content: copy(content),
      };
      store.state.contentCapture = { sampled: 1 };
      await import("../src/background");
      const result = await send({
        type: "SAVE_SETTINGS",
        settings: {
          ...store.state.settings,
          enabled: false,
          ...(change === "endpoint"
            ? { endpoint: "https://new-dav.example.org/" }
            : { contentOrigins: ["https://example.org"] }),
        },
      });
      expect(result.ok).toBe(true);
      expect(store.state.current.windows[0].tabs[0].content).toBeUndefined();
      expect(store.state.identities.tabs[1].content).toBeUndefined();
      expect(store.state.contentCapture).toBeUndefined();
    },
  );
  it("requires a new endpoint before changing an existing encrypted history key", async () => {
    await import("../src/background");
    store.state.sync.revision = 3;
    const result = await send({
      type: "SAVE_SETTINGS",
      settings: { ...store.state.settings, encryptionPassphrase: "new key" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("新的 WebDAV 目录");
    expect(store.state.settings.encryptionPassphrase).toBe("");
  });
  it.each([undefined, "http://other.example.org"])(
    "rejects HTTP save without matching origin consent (%s)",
    async (ack) => {
      await import("../src/background");
      const result = await send({
        type: "SAVE_SETTINGS",
        settings: {
          ...store.state.settings,
          endpoint: "http://dav.example.org/",
          httpAcknowledgedOrigin: ack,
          enabled: false,
        },
      });
      expect(result.ok).toBe(false);
      expect(store.state.settings.endpoint).toBe("https://dav.example.org/");
      expect(publish).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "http://other.example.org"])(
    "rejects HTTP connection test without matching origin consent (%s)",
    async (ack) => {
      await import("../src/background");
      const result = await send({
        type: "TEST_CONNECTION",
        settings: {
          ...store.state.settings,
          endpoint: "http://dav.example.org/",
          httpAcknowledgedOrigin: ack,
          enabled: false,
        },
      });
      expect(result.ok).toBe(false);
      expect(connectionTest).not.toHaveBeenCalled();
    },
  );
  it("accepts explicit HTTP origin consent and invalidates it for another origin", async () => {
    await import("../src/background");
    const settings = {
      ...store.state.settings,
      endpoint: "http://dav.example.org/root/",
      httpAcknowledgedOrigin: "http://dav.example.org",
      enabled: false,
    };
    expect((await send({ type: "SAVE_SETTINGS", settings })).ok).toBe(true);
    expect(store.state.settings.httpAcknowledgedOrigin).toBe(
      "http://dav.example.org",
    );
    expect((await send({ type: "TEST_CONNECTION", settings })).ok).toBe(true);
    expect(connectionTest).toHaveBeenCalledTimes(1);
    const changed = await send({
      type: "SAVE_SETTINGS",
      settings: { ...settings, endpoint: "http://another.example.org/root/" },
    });
    expect(changed.ok).toBe(false);
    expect(store.state.settings.endpoint).toBe("http://dav.example.org/root/");
  });
  it("accepts HTTPS settings without HTTP consent", async () => {
    await import("../src/background");
    const result = await send({
      type: "SAVE_SETTINGS",
      settings: {
        ...store.state.settings,
        endpoint: "https://secure.example.org/root/",
        httpAcknowledgedOrigin: undefined,
        enabled: false,
      },
    });
    expect(result.ok).toBe(true);
    expect(store.state.settings.endpoint).toBe(
      "https://secure.example.org/root/",
    );
  });
  it.each([5, 10, 30, 60, 1440])(
    "saves the supported %i minute cadence",
    async (minutes) => {
      await import("../src/background");
      const result = await send({
        type: "SAVE_SETTINGS",
        settings: {
          ...store.state.settings,
          enabled: false,
          syncIntervalMinutes: minutes,
        },
      });
      expect(result.ok).toBe(true);
      expect(store.state.settings.syncIntervalMinutes).toBe(minutes);
    },
  );
  it("migrates missing cadence and keeps body capture opt-in", async () => {
    delete store.state.settings.syncIntervalMinutes;
    delete store.state.settings.contentEnabled;
    delete store.state.settings.contentOrigins;
    await import("../src/background");
    const result = await send({ type: "GET_STATE" });
    expect(result.data.settings.syncIntervalMinutes).toBe(10);
    expect(result.data.settings.contentEnabled).toBe(false);
    expect(result.data.settings.contentOrigins).toEqual([]);
  });
  it("tab events mark dirty but do not publish before the scheduled due time", async () => {
    store.state.sync.dirty = false;
    store.state.sync.nextDueAt = Date.now() + 10 * 60_000;
    const { sync } = await import("../src/background");
    await send({ type: "GET_STATE" });
    const callback = chromeMock.tabs.onCreated.addListener.mock.calls[0][0];
    callback({ id: 15, url: "https://example.org/" });
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.state.sync.dirty).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    await sync(false);
    expect(publish).not.toHaveBeenCalled();
    await sync(true);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("publishes dirty state once due and advances next due by its chosen cadence", async () => {
    store.state.settings.syncIntervalMinutes = 30;
    store.state.sync.nextDueAt = Date.now() - 1;
    const { sync } = await import("../src/background");
    await send({ type: "GET_STATE" });
    vi.setSystemTime(Date.now() + 5000);
    const now = Date.now();
    await sync(false);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.state.sync.nextDueAt).toBeGreaterThanOrEqual(
      now + 30 * 60_000,
    );
    expect(store.state.sync.dirty).toBe(false);
    await sync(false);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("refuses body capture consent for wildcard origins or missing scripting permission", async () => {
    await import("../src/background");
    const wildcard = await send({
      type: "SAVE_SETTINGS",
      settings: {
        ...store.state.settings,
        enabled: false,
        contentEnabled: true,
        contentOrigins: ["https://*.example.org"],
      },
    });
    expect(wildcard.ok).toBe(false);
    chromeMock.permissions.contains.mockResolvedValue(false);
    const missing = await send({
      type: "SAVE_SETTINGS",
      settings: {
        ...store.state.settings,
        enabled: false,
        contentEnabled: true,
        contentOrigins: ["https://example.org"],
      },
    });
    expect(missing.ok).toBe(false);
    expect(store.state.settings.contentEnabled).toBe(false);
  });
  it("permission removal purges body refs and search, invalidates plan, pauses sync, but preserves uncertain pending", async () => {
    const content = { status: "available", ref: { objectId: "a".repeat(64) } };
    store.state.current = snap();
    store.state.current.windows[0].tabs[0].content = copy(content);
    store.state.identities.tabs[1] = {
      key: "t",
      url: "https://example.org/",
      content: copy(content),
    };
    store.state.contentCapture = { sampled: 1 };
    store.state.sync.pending = snap("uncertain");
    store.restorePlan = { id: "stale-plan" };
    await import("../src/background");
    await send({ type: "GET_STATE" });
    chromeMock.permissions.onRemoved.addListener.mock.calls[0][0]({
      permissions: ["scripting"],
    });
    await vi.waitFor(() => expect(store.state.settings.enabled).toBe(false));
    expect(store.restorePlan).toBeUndefined();
    expect(store.state.current.windows[0].tabs[0].content).toBeUndefined();
    expect(store.state.identities.tabs[1].content).toBeUndefined();
    expect(store.state.contentCapture).toBeUndefined();
    expect(store.state.sync.pending.snapshotId).toBe("uncertain");
    expect(store.state.sync.dirty).toBe(true);
    expect(store.state.sync.errorCode).toBe("permission-denied");
    const status = await send({ type: "SEARCH_STATUS" });
    expect(status.data.paused).toBe(true);
    expect(status.data.sources).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
  it("rejects content-script or foreign senders before exposing credentials", async () => {
    await import("../src/background");
    const result = await send(
      { type: "GET_STATE" },
      { id: "test-extension", url: "https://evil.example.org/" },
    );
    expect(result).toEqual({ ok: false, error: "不可信消息来源" });
  });
});
