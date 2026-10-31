import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Snapshot, Plan } from "../src/types";
let store: Record<string, any>,
  windows: Map<number, any>,
  tabs: Map<number, any>,
  nextWindow: number,
  nextTab: number,
  nextGroup: number,
  api: any;
const copy = <T>(v: T): T => structuredClone(v);
function source(count = 3): Snapshot {
  return {
    schemaVersion: 1,
    deviceId: "remote-A",
    snapshotId: "snap-1",
    revision: 1,
    capturedAt: "2026-10-31T00:00:00Z",
    windows: [
      {
        windowKey: "remote-w",
        order: 0,
        activeTabKey: count > 1 ? "remote-1" : count ? "remote-0" : undefined,
        groups: [
          {
            groupKey: "remote-g",
            title: "Research",
            color: "blue",
            collapsed: true,
          },
        ],
        tabs: Array.from({ length: count }, (_, i) => ({
          tabKey: `remote-${i}`,
          url: `https://example.org/${i}`,
          title: `Remote ${i}`,
          index: i,
          pinned: i === 0,
          groupKey: i ? "remote-g" : undefined,
          origin: { deviceId: "remote-A", tabKey: `remote-${i}` },
        })),
      },
    ],
  };
}
async function plan(count = 3): Promise<Plan> {
  const { makePlan } = await import("../src/model");
  return makePlan(source(count), {
    ...source(0),
    deviceId: "local-B",
    windows: [],
  });
}
function putTab(windowId: number, url: string, extra: any = {}) {
  const id = nextTab++;
  const t = {
    id,
    windowId,
    url,
    title: url,
    index: [...tabs.values()].filter((t) => t.windowId === windowId).length,
    pinned: false,
    active: false,
    groupId: -1,
    ...extra,
  };
  tabs.set(id, t);
  return copy(t);
}
beforeEach(() => {
  vi.resetModules();
  store = {};
  windows = new Map([[1, { id: 1, type: "normal" }]]);
  tabs = new Map();
  nextWindow = 10;
  nextTab = 100;
  nextGroup = 1000;
  putTab(1, "https://original.org/", { id: 7, active: true });
  api = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: copy(store[key]) }),
        set: async (data: any) => {
          Object.assign(store, copy(data));
        },
      },
    },
    windows: {
      getAll: vi.fn(async () => [...windows.values()].map(copy)),
      get: vi.fn(async (id: number) => {
        if (!windows.has(id)) throw Error("missing window");
        return copy(windows.get(id));
      }),
      create: vi.fn(async ({ url }: any) => {
        const id = nextWindow++;
        windows.set(id, { id, type: "normal" });
        const t = putTab(id, url, { active: true });
        return { id, tabs: [t] };
      }),
      remove: vi.fn(async (id: number) => {
        windows.delete(id);
        for (const [tid, t] of tabs) if (t.windowId === id) tabs.delete(tid);
      }),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        if (!tabs.has(id)) throw Error("missing tab");
        return copy(tabs.get(id));
      }),
      query: vi.fn(async ({ windowId }: any) =>
        [...tabs.values()].filter((t) => t.windowId === windowId).map(copy),
      ),
      create: vi.fn(async ({ windowId, url, ...extra }: any) =>
        putTab(windowId, url, extra),
      ),
      update: vi.fn(async (id: number, props: any) => {
        const t = tabs.get(id);
        if (!t) throw Error("missing tab");
        if (props.active)
          for (const x of tabs.values())
            if (x.windowId === t.windowId) x.active = false;
        Object.assign(t, props);
        return copy(t);
      }),
      group: vi.fn(async ({ tabIds }: any) => {
        const id = nextGroup++;
        for (const tid of tabIds) tabs.get(tid).groupId = id;
        return id;
      }),
    },
    tabGroups: {
      update: vi.fn(async (id: number, props: any) => ({ id, ...props })),
    },
  };
  vi.stubGlobal("chrome", api);
});
describe("restore journal with simulated Chrome APIs", () => {
  it("creates new windows, leaves originals untouched and restores pin/group/active metadata", async () => {
    const original = copy([...tabs.values()]);
    const mod = await import("../src/restore");
    await mod.prepare(await plan());
    await mod.execute();
    expect(windows.has(1)).toBe(true);
    expect([...tabs.values()].filter((t) => t.windowId === 1)).toEqual(
      original,
    );
    expect(api.windows.remove).not.toHaveBeenCalled();
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    expect(api.tabs.create).toHaveBeenCalledTimes(2);
    const op = store.state.operation;
    expect(op.status).toBe("COMPLETED");
    expect(op.createdTabs).toHaveLength(3);
    expect([...tabs.values()].find((t) => t.url.endsWith("/0"))?.pinned).toBe(
      true,
    );
    expect([...tabs.values()].find((t) => t.url.endsWith("/1"))?.active).toBe(
      true,
    );
    expect(api.tabGroups.update).toHaveBeenCalledWith(1000, {
      title: "Research",
      color: "blue",
      collapsed: true,
    });
    expect(store.state.sync.dirty).toBe(true);
    expect(
      store.state.identities.tabs[String(op.createdTabs[0].tabId)].origin,
    ).toEqual({ deviceId: "remote-A", tabKey: "remote-0" });
  });
  it("writes uncertain journal before browser side effects", async () => {
    const mod = await import("../src/restore");
    const normal = api.windows.create.getMockImplementation();
    api.windows.create.mockImplementation(async (args: any) => {
      expect(store.state.operation.uncertain).toMatchObject({
        kind: "window",
        sourceTabKey: "remote-0",
      });
      expect(store.state.operation.createdTabs).toHaveLength(0);
      return normal(args);
    });
    await mod.prepare(await plan(1));
    await mod.execute();
    expect(store.state.operation.uncertain).toBeUndefined();
  });
  it("cancel stops subsequent creates and keeps partial result", async () => {
    const mod = await import("../src/restore");
    const normal = api.windows.create.getMockImplementation();
    api.windows.create.mockImplementation(async (args: any) => {
      const result = await normal(args);
      await mod.cancel();
      return result;
    });
    await mod.prepare(await plan(6));
    await mod.execute();
    expect(store.state.operation.status).toBe("CANCELLED");
    expect(store.state.operation.createdTabs).toHaveLength(1);
    expect(api.tabs.create).not.toHaveBeenCalled();
    expect(windows.size).toBe(2);
    expect(api.windows.remove).not.toHaveBeenCalled();
  });
  it("isolates a rejected tab and continues safe remaining tabs", async () => {
    const mod = await import("../src/restore");
    api.tabs.create.mockRejectedValueOnce(Error("browser reject"));
    await mod.prepare(await plan(3));
    await mod.execute();
    expect(store.state.operation.status).toBe("COMPLETED");
    expect(store.state.operation.createdTabs).toHaveLength(2);
    expect(store.state.operation.failures).toContainEqual({
      tabKey: "remote-1",
      reason: "浏览器拒绝创建此标签",
    });
    expect(windows.has(1)).toBe(true);
  });
  it("turns an interrupted running journal into explicit resumable state", async () => {
    const mod = await import("../src/restore");
    await mod.prepare(await plan(1));
    store.state.operation.status = "RUNNING";
    await mod.interruptOnBoot();
    expect(store.state.operation.status).toBe("INTERRUPTED");
    expect(api.windows.create).not.toHaveBeenCalled();
    await mod.execute();
    expect(store.state.operation.status).toBe("COMPLETED");
  });
  it("refuses to replay uncertain side effects after restart", async () => {
    const mod = await import("../src/restore");
    await mod.prepare(await plan(1));
    store.state.operation.status = "RUNNING";
    store.state.operation.uncertain = {
      kind: "window",
      sourceWindowKey: "remote-w",
      sourceTabKey: "remote-0",
      url: "https://example.org/0",
      beforeIds: [1],
    };
    await mod.interruptOnBoot();
    await expect(mod.execute()).rejects.toThrow("不能自动重做");
    expect(api.windows.create).not.toHaveBeenCalled();
    await expect(mod.undo(true)).rejects.toThrow("未确认");
    expect(api.windows.remove).not.toHaveBeenCalled();
  });
  it("requires explicit undo confirmation and preserves original windows", async () => {
    const mod = await import("../src/restore");
    await mod.prepare(await plan(1));
    await mod.execute();
    await expect(mod.undo(false)).rejects.toThrow();
    expect(windows.size).toBe(2);
    await mod.undo(true);
    expect(windows.size).toBe(1);
    expect(windows.has(1)).toBe(true);
    expect(api.windows.remove).toHaveBeenCalledWith(10);
    expect(store.state.operation.status).toBe("ROLLED_BACK");
  });
  it("refuses undo when a created window has user additions or URL changes", async () => {
    const mod = await import("../src/restore");
    await mod.prepare(await plan(1));
    await mod.execute();
    putTab(10, "https://user-added.org/");
    await expect(mod.undo(true)).rejects.toThrow("已被修改");
    expect(api.windows.remove).not.toHaveBeenCalled();
    expect(windows.has(1)).toBe(true);
  });
  it("does not revive previously created tabs that user closed before resume", async () => {
    const mod = await import("../src/restore");
    await mod.prepare(await plan(2));
    await mod.execute();
    const op = store.state.operation;
    tabs.delete(op.createdTabs[0].tabId);
    op.status = "INTERRUPTED";
    await mod.execute();
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
    expect(
      store.state.operation.failures.some((f: any) => f.tabKey === "remote-0"),
    ).toBe(true);
  });
  it("serializes simultaneous execute calls without duplicate windows", async () => {
    const mod = await import("../src/restore");
    await mod.prepare(await plan(2));
    const result = await Promise.allSettled([mod.execute(), mod.execute()]);
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    expect(store.state.operation.createdTabs).toHaveLength(2);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("refuses execute and undo when runtime identities belong to a previous browser session", async () => {
    const mod = await import("../src/restore");
    await mod.prepare(await plan(1));
    store.state.identities.browserSession = "new-browser-session";
    await expect(mod.execute()).rejects.toThrow("浏览器已重启");
    expect(mod.isRestoring()).toBe(false);
    await expect(mod.undo(true)).rejects.toThrow("浏览器已重启");
    expect(api.windows.create).not.toHaveBeenCalled();
    expect(api.windows.remove).not.toHaveBeenCalled();
  });
  it("reports final verification mismatch rather than silently claiming exact restoration", async () => {
    const mod = await import("../src/restore");
    const normal = api.tabs.update.getMockImplementation();
    api.tabs.update.mockImplementation(async (id: number, props: any) => {
      if (props.pinned) return copy(tabs.get(id));
      return normal(id, props);
    });
    await mod.prepare(await plan(1));
    await mod.execute();
    expect(
      store.state.operation.failures.some((f: any) =>
        f.reason.includes("最终核验"),
      ),
    ).toBe(true);
    expect(windows.has(1)).toBe(true);
  });
  it("rejects a second prepared operation while first is pending", async () => {
    const mod = await import("../src/restore");
    await mod.prepare(await plan(1));
    await expect(mod.prepare(await plan(1))).rejects.toThrow("已有恢复任务");
  });
});
