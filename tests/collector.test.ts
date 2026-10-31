import { beforeEach, describe, it, expect, vi } from "vitest";
let store: Record<string, any>, windows: any[], groups: any[];
function clone<T>(x: T): T {
  return structuredClone(x);
}
function browserTab(id: number, url: string, extra: any = {}) {
  return {
    id,
    url,
    title: `Tab ${id}`,
    index: id - 1,
    pinned: false,
    groupId: -1,
    active: id === 1,
    ...extra,
  };
}
beforeEach(() => {
  vi.resetModules();
  store = {};
  windows = [];
  groups = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: clone(store[key]) }),
        set: async (data: any) => {
          Object.assign(store, clone(data));
        },
      },
    },
    windows: { getAll: async () => clone(windows) },
    tabGroups: { query: async () => clone(groups) },
  });
});
describe("collector with simulated Chrome APIs", () => {
  it("collects only ordinary non-incognito windows and safe tabs", async () => {
    windows = [
      {
        id: 1,
        type: "normal",
        incognito: false,
        tabs: [
          browserTab(1, "https://example.org/?token=secret&q=ok"),
          browserTab(2, "chrome://settings"),
        ],
      },
      {
        id: 2,
        type: "normal",
        incognito: true,
        tabs: [browserTab(3, "https://private.org/")],
      },
      {
        id: 3,
        type: "popup",
        incognito: false,
        tabs: [browserTab(4, "https://popup.org/")],
      },
    ];
    const { collect } = await import("../src/collector");
    const s = await collect();
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0].tabs).toHaveLength(1);
    expect(s.windows[0].tabs[0].url).toBe("https://example.org/?q=ok");
    expect(s.windows[0].activeTabKey).toBe(s.windows[0].tabs[0].tabKey);
  });
  it("preserves logical tab/group identities over service-worker reload", async () => {
    windows = [
      {
        id: 1,
        type: "normal",
        incognito: false,
        tabs: [browserTab(1, "https://example.org/", { groupId: 9 })],
      },
    ];
    groups = [
      { id: 9, windowId: 1, title: "Research", color: "blue", collapsed: true },
    ];
    let mod = await import("../src/collector");
    const first = await mod.collect();
    vi.resetModules();
    mod = await import("../src/collector");
    const second = await mod.collect();
    expect(second.windows[0]).toEqual(first.windows[0]);
    expect(second.snapshotId).toMatch(/^\d{8}-\d{6}Z-r\d{12}$/);
    expect(second.revision).toBe(first.revision); // Repeated collection is not a published revision.
    expect(second.windows[0].groups[0]).toMatchObject({
      title: "Research",
      color: "blue",
      collapsed: true,
    });
  });
  it("reassociates unique position/URL after runtime ids change", async () => {
    windows = [
      {
        id: 1,
        type: "normal",
        incognito: false,
        tabs: [browserTab(1, "https://example.org/", { index: 0 })],
      },
    ];
    const { collect } = await import("../src/collector");
    const first = await collect();
    store.state.identities.tabs = {};
    store.state.identities.windows = {};
    store.state.identities.groups = {};
    windows = [
      {
        id: 80,
        type: "normal",
        incognito: false,
        tabs: [browserTab(90, "https://example.org/", { index: 0 })],
      },
    ];
    const next = await collect();
    expect(next.windows[0].windowKey).toBe(first.windows[0].windowKey);
    expect(next.windows[0].tabs[0].origin).toEqual(
      first.windows[0].tabs[0].origin,
    );
  });
  it("does not recreate closed tabs from its prior snapshot", async () => {
    windows = [
      {
        id: 1,
        type: "normal",
        incognito: false,
        tabs: [
          browserTab(1, "https://one.org/"),
          browserTab(2, "https://two.org/"),
        ],
      },
    ];
    const { collect } = await import("../src/collector");
    await collect();
    windows[0].tabs.splice(0, 1);
    const next = await collect();
    expect(next.windows[0].tabs.map((t) => t.url)).toEqual([
      "https://two.org/",
    ]);
    expect(Object.keys(store.state.identities.tabs)).toEqual(["2"]);
  });
  it("applies domain blacklist and supports empty capture without invented windows", async () => {
    const { load } = await import("../src/state");
    await load();
    store.state.settings.blacklist = ["blocked.org"];
    windows = [
      {
        id: 1,
        type: "normal",
        incognito: false,
        tabs: [browserTab(1, "https://sub.blocked.org/")],
      },
    ];
    const { collect } = await import("../src/collector");
    expect((await collect()).windows).toEqual([]);
  });
});
