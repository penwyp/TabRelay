import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import type { Snapshot } from "../src/types";
let store: Record<string, any>,
  chromeMock: any,
  publish: any,
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
  vi.useFakeTimers();
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
  publish = vi.fn(async () => ({ etag: '"v1"' }));
  collect = vi.fn(async () => copy(snap()));
  vi.doMock("../src/webdav", () => ({
    WebDAVRepository: class {
      publish = publish;
      connectionTest = vi.fn();
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
    permissions: { contains: vi.fn(async () => true) },
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
    expect(collect).toHaveBeenCalledTimes(1);
    expect(store.state.sync.dirty).toBe(true);
    await sync(true);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[2][0].snapshotId).toBe("newer");
  });
  it("does not label a newer restore synced when merely reconciling an older pending snapshot", async () => {
    store.state.sync.pending = snap("before-restore");
    store.state.operation = {
      id: "new-restore",
      status: "COMPLETED",
      syncStatus: "pending",
    };
    const { sync } = await import("../src/background");
    await sync(true);
    expect(publish.mock.calls[0][0].snapshotId).toBe("before-restore");
    expect(store.state.sync.dirty).toBe(true);
    expect(store.state.operation.syncStatus).toBe("pending");
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
    vi.setSystemTime(Date.now() + 5000);
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
  it("rejects content-script or foreign senders before exposing credentials", async () => {
    await import("../src/background");
    const result = await send(
      { type: "GET_STATE" },
      { id: "test-extension", url: "https://evil.example.org/" },
    );
    expect(result).toEqual({ ok: false, error: "不可信消息来源" });
  });
});
