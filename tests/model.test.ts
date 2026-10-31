import { describe, it, expect } from "vitest";
import {
  validateSnapshot,
  safeUrl,
  makePlan,
  checkSettings,
  DEFAULT_SETTINGS,
  LIMITS,
} from "../src/model";
import type { Snapshot, Tab } from "../src/types";
function tab(key = "t1", url = "https://example.org/a", originKey = key): Tab {
  return {
    tabKey: key,
    url,
    title: key,
    index: 0,
    pinned: false,
    origin: { deviceId: "a", tabKey: originKey },
  };
}
function snapshot(tabs: Tab[] = [tab()]): Snapshot {
  return {
    schemaVersion: 1,
    deviceId: "a",
    snapshotId: "s1",
    revision: 1,
    capturedAt: "2026-10-31T00:00:00Z",
    windows: [{ windowKey: "w1", order: 0, tabs, groups: [] }],
  };
}
const empty = (): Snapshot => ({ ...snapshot(), deviceId: "b", windows: [] });
describe("snapshot security and limits (pure unit tests)", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "blob:https://example.org/abc",
    "chrome://settings",
    "file:///etc/passwd",
    "chrome-extension://id/a",
    "https://user:pass@example.org",
    "not a URL",
  ])("rejects unsafe restore URL %s", (url) => expect(safeUrl(url)).toBeNull());
  it("strips only configured sensitive params and blocks domain + subdomains", () => {
    const p = { blacklist: ["secret.example.org"], stripParams: ["token"] };
    expect(
      safeUrl("https://example.org/?TOKEN=secret&q=ok&token=other", p),
    ).toBe("https://example.org/?q=ok");
    expect(safeUrl("https://sub.secret.example.org/a", p)).toBeNull();
    expect(safeUrl("https://notsecret.example.org/a", p)).toBe(
      "https://notsecret.example.org/a",
    );
  });
  it("returns a defensive deep snapshot clone", () => {
    const raw = snapshot();
    const result = validateSnapshot(raw);
    raw.windows[0].tabs[0].title = "changed";
    expect(result.windows[0].tabs[0].title).toBe("t1");
  });
  it.each([
    null,
    [],
    {},
    { ...snapshot(), schemaVersion: 3 },
    { ...snapshot(), revision: -1 },
    { ...snapshot(), capturedAt: "bad" },
  ])("rejects invalid top-level metadata %#", (raw) =>
    expect(() => validateSnapshot(raw)).toThrow(),
  );
  it("rejects too many windows and tabs", () => {
    const s = snapshot();
    s.windows = Array.from({ length: LIMITS.windows + 1 }, (_, i) => ({
      ...s.windows[0],
      windowKey: `w${i}`,
      tabs: [],
    }));
    expect(() => validateSnapshot(s)).toThrow();
    const many = snapshot(
      Array.from({ length: LIMITS.tabs + 1 }, (_, i) => ({
        ...tab(`t${i}`),
        index: i,
      })),
    );
    expect(() => validateSnapshot(many)).toThrow();
  });
  it("enforces byte size for multibyte text, not JavaScript character count", () => {
    const s = snapshot(
      Array.from({ length: 800 }, (_, i) => ({
        ...tab(`t${i}`, "https://example.org/" + "界".repeat(2000)),
        title: "界".repeat(1000),
        index: i,
      })),
    );
    expect(JSON.stringify(s).length).toBeLessThan(LIMITS.bytes);
    expect(
      new TextEncoder().encode(JSON.stringify(s)).byteLength,
    ).toBeGreaterThan(LIMITS.bytes);
    expect(() => validateSnapshot(s)).toThrow();
  });
  it("rejects duplicate identities, broken group references and pinned group membership", () => {
    expect(() => validateSnapshot(snapshot([tab(), tab()]))).toThrow();
    const t = { ...tab(), groupKey: "missing" };
    expect(() => validateSnapshot(snapshot([t]))).toThrow();
    const s = snapshot([{ ...t, pinned: true }]);
    s.windows[0].groups = [
      { groupKey: "missing", title: "g", color: "blue", collapsed: false },
    ];
    expect(() => validateSnapshot(s)).toThrow();
  });
  it("rejects missing active-tab references and invalid group colors", () => {
    const s = snapshot();
    s.windows[0].activeTabKey = "absent";
    expect(() => validateSnapshot(s)).toThrow();
    delete s.windows[0].activeTabKey;
    s.windows[0].groups = [
      { groupKey: "g", title: "g", color: "neon" as any, collapsed: false },
    ];
    expect(() => validateSnapshot(s)).toThrow();
  });
  it("accepts empty current workspace", () =>
    expect(validateSnapshot(empty()).windows).toEqual([]));
  it("binds HTTP plaintext consent to an exact origin and clears it for HTTPS", () => {
    expect(
      checkSettings({
        ...DEFAULT_SETTINGS,
        endpoint: "http://nas.local:8080/dav",
        httpAcknowledgedOrigin: "http://nas.local:8080",
      }).endpoint,
    ).toBe("http://nas.local:8080/dav/");
    expect(() =>
      checkSettings({
        ...DEFAULT_SETTINGS,
        endpoint: "http://nas.local:8081/dav",
        httpAcknowledgedOrigin: "http://nas.local:8080",
      }),
    ).toThrow(/HTTP/);
    expect(
      checkSettings({
        ...DEFAULT_SETTINGS,
        endpoint: "https://nas.local/dav",
        httpAcknowledgedOrigin: "http://nas.local",
      }).httpAcknowledgedOrigin,
    ).toBeUndefined();
  });
  it("requires HTTPS or acknowledged HTTP WebDAV, clamps history and normalizes endpoint", () => {
    expect(
      checkSettings({
        ...DEFAULT_SETTINGS,
        endpoint: "https://dav.example.org/root",
        historyLimit: 1000,
      }).endpoint,
    ).toBe("https://dav.example.org/root/");
    expect(
      checkSettings({ ...DEFAULT_SETTINGS, historyLimit: 1000 }).historyLimit,
    ).toBe(100);
    for (const endpoint of [
      "http://dav.example.org/",
      "https://u:p@dav.example.org/",
      "https://dav.example.org/?x=1",
    ])
      expect(() => checkSettings({ ...DEFAULT_SETTINGS, endpoint })).toThrow();
  });
});
describe("restore plans and provenance (pure unit tests)", () => {
  it("keeps intentionally equal URLs with distinct origins", async () => {
    const plan = await makePlan(
      snapshot([tab("t2", "https://example.org/a", "other")]),
      snapshot(),
    );
    expect(plan.windows[0].tabs).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });
  it("skips same origin AND same content, but keeps navigation of same origin", async () => {
    const source = snapshot([
      tab("copy", "https://example.org/a", "t1"),
      { ...tab("navigated", "https://example.org/b", "t1"), index: 1 },
    ]);
    const plan = await makePlan(source, snapshot());
    expect(plan.skipped).toHaveLength(1);
    expect(plan.windows[0].tabs.map((t) => t.tabKey)).toEqual(["navigated"]);
  });
  it("URL dedup is opt-in", async () => {
    const source = snapshot([tab("other")]);
    const current = snapshot([tab("local")]);
    expect((await makePlan(source, current)).windows).toHaveLength(1);
    expect((await makePlan(source, current, {}, true)).windows).toHaveLength(0);
  });
  it("filters unsafe URLs without mutating source", async () => {
    const source = snapshot([
      tab("safe"),
      { ...tab("bad", "javascript:alert(1)"), index: 1 },
    ]);
    const before = structuredClone(source);
    const plan = await makePlan(source, empty());
    expect(plan.windows[0].tabs.map((t) => t.tabKey)).toEqual(["safe"]);
    expect(plan.skipped[0].reason).toContain("URL");
    expect(source).toEqual(before);
    source.windows[0].tabs[0].url = "https://changed.org/";
    expect(plan.snapshot.windows[0].tabs[0].url).toBe("https://example.org/a");
  });
  it("selects group or individual members and preserves order", async () => {
    const s = snapshot([
      { ...tab("t2"), index: 2 },
      { ...tab("t1"), index: 1, groupKey: "g" },
      { ...tab("t0"), index: 0, groupKey: "g" },
    ]);
    s.windows[0].groups = [
      { groupKey: "g", title: "Research", color: "blue", collapsed: true },
    ];
    const p = await makePlan(s, empty(), { groupKeys: ["g"] });
    expect(p.windows[0].tabs.map((t) => t.tabKey)).toEqual(["t0", "t1"]);
    expect(p.windows[0].groups).toHaveLength(1);
    const one = await makePlan(s, empty(), { tabKeys: ["t2"] });
    expect(one.windows[0].groups).toEqual([]);
  });
  it("applies local privacy rules to remote restore plans without mutating pinned source", async () => {
    const s = snapshot([
      tab("blocked", "https://sub.private.org/"),
      { ...tab("safe", "https://example.org/?token=secret&q=ok"), index: 1 },
    ]);
    const p = await makePlan(s, empty(), {}, false, {
      blacklist: ["private.org"],
      stripParams: ["token"],
    });
    expect(p.windows[0].tabs).toHaveLength(1);
    expect(p.windows[0].tabs[0].url).toBe("https://example.org/?q=ok");
    expect(p.skipped).toHaveLength(1);
    expect(s.windows[0].tabs[1].url).toContain("token=secret");
  });
  it("rejects bad snapshots before a plan is produced", async () => {
    await expect(
      makePlan({ ...snapshot(), schemaVersion: 99 }, empty()),
    ).rejects.toThrow();
  });
});
