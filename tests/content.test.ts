/** Unit simulation of browser APIs. Actual DOM visibility is additionally checked by Chromium E2E. */
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import type { Snapshot } from "../src/types";
let state: any, writeText: any, tabsGet: any, executeScript: any, contains: any;
const clone = <T>(x: T): T => structuredClone(x);
function snapshot(count = 1): Snapshot {
  return {
    schemaVersion: 2,
    deviceId: "local-device",
    snapshotId: "snapshot",
    revision: 1,
    capturedAt: "2026-10-31T00:00:00Z",
    windows: [
      {
        windowKey: "window",
        order: 0,
        groups: [],
        tabs: Array.from({ length: count }, (_, i) => ({
          tabKey: "tab-" + i,
          url: "https://example.org/page-" + i,
          title: "Page " + i,
          index: i,
          pinned: false,
          origin: { deviceId: "local-device", tabKey: "tab-" + i },
        })),
      },
    ],
  };
}
function identities(s: Snapshot) {
  state.identities.tabs = Object.fromEntries(
    s.windows
      .flatMap((w) => w.tabs)
      .map((tab, i) => [
        i + 1,
        { key: tab.tabKey, url: tab.url, windowKey: "window" },
      ]),
  );
}
beforeEach(() => {
  vi.resetModules();
  state = {
    deviceId: "local-device",
    settings: {
      ...DEFAULT_SETTINGS,
      endpoint: "https://dav.example.org/",
      contentEnabled: true,
      contentOrigins: ["https://example.org"],
    },
    identities: { tabs: {} },
  };
  identities(snapshot());
  writeText = vi.fn(async (_id: string, text: string) => ({
    objectId: "a".repeat(64),
    bytes: new TextEncoder().encode(text).length,
    objectCount: 1,
  }));
  tabsGet = vi.fn(async (id: number) => ({
    id,
    windowId: 7,
    url: state.identities.tabs[id].url,
    incognito: false,
    status: "complete",
  }));
  executeScript = vi.fn(async ({ target }: any) => [
    {
      result: {
        url: state.identities.tabs[target.tabId].url,
        text: "量子陀螺导航的可见正文",
        truncated: false,
      },
    },
  ]);
  contains = vi.fn(async () => true);
  vi.doMock("../src/state", () => ({
    load: async () => clone(state),
    update: async (fn: any) => fn(state),
  }));
  vi.doMock("../src/webdav", () => ({
    WebDAVRepository: class {
      writeText = writeText;
    },
  }));
  vi.stubGlobal("chrome", {
    permissions: { contains },
    tabs: { get: tabsGet },
    windows: { get: vi.fn(async () => ({ type: "normal", incognito: false })) },
    scripting: { executeScript },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../src/state");
  vi.doUnmock("../src/webdav");
});
describe("opt-in body capture with simulated browser APIs", () => {
  it("does not inject or upload while disabled and does not mutate its input", async () => {
    state.settings.contentEnabled = false;
    const input = snapshot(),
      before = clone(input);
    const { captureSnapshotText } = await import("../src/content");
    const output = await captureSnapshotText(input);
    expect(output.windows[0].tabs[0].content?.status).toBe("disabled");
    expect(input).toEqual(before);
    expect(executeScript).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
  it("requires exact origin and browser scripting permission", async () => {
    const { captureSnapshotText } = await import("../src/content");
    state.settings.contentOrigins = ["https://sub.example.org"];
    expect(
      (await captureSnapshotText(snapshot())).windows[0].tabs[0].content
        ?.status,
    ).toBe("permission-denied");
    state.settings.contentOrigins = ["https://example.org"];
    contains.mockResolvedValue(false);
    expect(
      (await captureSnapshotText(snapshot())).windows[0].tabs[0].content
        ?.status,
    ).toBe("permission-denied");
    expect(contains).toHaveBeenCalledWith({
      permissions: ["scripting"],
      origins: ["https://example.org/*"],
    });
    expect(executeScript).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
  it.each(["popup", "incognito"])(
    "refuses a tab moved into a %s window after collection",
    async (kind) => {
      vi.mocked(chrome.windows.get).mockResolvedValue({
        type: kind === "popup" ? "popup" : "normal",
        incognito: kind === "incognito",
      } as chrome.windows.Window);
      const { captureSnapshotText } = await import("../src/content");
      const output = await captureSnapshotText(snapshot());
      expect(output.windows[0].tabs[0].content?.status).toBe("unavailable");
      expect(executeScript).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
    },
  );
  it.each(["incognito", "loading", "changed", "credentials"])(
    "rejects %s tabs before extraction",
    async (kind) => {
      tabsGet.mockResolvedValue({
        id: 1,
        url:
          kind === "changed"
            ? "https://example.org/other"
            : kind === "credentials"
              ? "https://user:secret@example.org/page-0"
              : "https://example.org/page-0",
        incognito: kind === "incognito",
        status: kind === "loading" ? "loading" : "complete",
      });
      const { captureSnapshotText } = await import("../src/content");
      const output = await captureSnapshotText(snapshot());
      expect(output.windows[0].tabs[0].content?.status).toBe("unavailable");
      expect(executeScript).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
    },
  );
  it.each(["navigation", "incognito", "injected-url"])(
    "rejects %s changes during extraction before uploading",
    async (kind) => {
      if (kind === "injected-url")
        executeScript.mockResolvedValue([
          {
            result: {
              url: "https://example.org/other",
              text: "wrong page",
              truncated: false,
            },
          },
        ]);
      else
        tabsGet
          .mockResolvedValueOnce({
            id: 1,
            url: "https://example.org/page-0",
            incognito: false,
            status: "complete",
          })
          .mockResolvedValueOnce({
            id: 1,
            url:
              kind === "navigation"
                ? "https://example.org/other"
                : "https://example.org/page-0",
            incognito: kind === "incognito",
            status: "complete",
          });
      const { captureSnapshotText } = await import("../src/content");
      const output = await captureSnapshotText(snapshot());
      expect(output.windows[0].tabs[0].content?.status).toBe("unavailable");
      expect(writeText).not.toHaveBeenCalled();
    },
  );
  it("does not upload if scripting or origin permission is revoked while extraction is in flight", async () => {
    contains.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { captureSnapshotText } = await import("../src/content");
    const output = await captureSnapshotText(snapshot());
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(output.windows[0].tabs[0].content?.status).not.toBe("available");
  });
  it("uploads only bounded text and binds an immutable ref to verified capture URL", async () => {
    const { captureSnapshotText } = await import("../src/content");
    const input = snapshot(),
      output = await captureSnapshotText(input);
    expect(writeText).toHaveBeenCalledWith(
      "local-device",
      "量子陀螺导航的可见正文",
    );
    expect(output.windows[0].tabs[0].content).toMatchObject({
      status: "available",
      ref: {
        ownerDeviceId: "local-device",
        objectId: "a".repeat(64),
        captureUrl: input.windows[0].tabs[0].url,
      },
    });
    expect(input.windows[0].tabs[0].content).toBeUndefined();
    expect(state.contentCapture).toMatchObject({
      sampled: 1,
      eligible: 1,
      failed: 0,
      remaining: 0,
      limit: 1000,
    });
  });
  it("preserves an explicit truncated coverage state instead of claiming full body", async () => {
    executeScript.mockResolvedValue([
      {
        result: {
          url: "https://example.org/page-0",
          text: "有界摘录",
          truncated: true,
        },
      },
    ]);
    const { captureSnapshotText } = await import("../src/content");
    const output = await captureSnapshotText(snapshot());
    expect(output.windows[0].tabs[0].content?.status).toBe("truncated");
    expect(output.windows[0].tabs[0].content?.reason).toContain("20000");
  });
  it.each(["", "x".repeat(20001)])(
    "rejects empty or over-limit returned body",
    async (text) => {
      executeScript.mockResolvedValue([
        {
          result: { url: "https://example.org/page-0", text, truncated: false },
        },
      ]);
      const { captureSnapshotText } = await import("../src/content");
      expect(
        (await captureSnapshotText(snapshot())).windows[0].tabs[0].content
          ?.status,
      ).toBe("unavailable");
      expect(writeText).not.toHaveBeenCalled();
    },
  );
  it("caps each pass at 100 and rotates so the 101st page is not starved", async () => {
    const input = snapshot(101);
    identities(input);
    const { captureSnapshotText } = await import("../src/content");
    const first = await captureSnapshotText(input);
    expect(executeScript).toHaveBeenCalledTimes(100);
    expect(first.windows[0].tabs[100].content?.status).toBe("unavailable");
    expect(state.contentCapture).toMatchObject({
      sampled: 100,
      eligible: 101,
      remaining: 1,
    });
    expect(state.contentCaptureCursor).toBe(100);
    executeScript.mockClear();
    await captureSnapshotText(input);
    expect(executeScript.mock.calls[0][0].target.tabId).toBe(101);
    expect(executeScript).toHaveBeenCalledTimes(100);
  });
  it("reports object quota failure without breaking title/URL snapshot", async () => {
    writeText.mockRejectedValue(
      Object.assign(new Error("quota"), { code: "object-limit" }),
    );
    const { captureSnapshotText } = await import("../src/content");
    const output = await captureSnapshotText(snapshot());
    expect(output.windows[0].tabs[0]).toMatchObject({
      title: "Page 0",
      url: "https://example.org/page-0",
      content: { status: "unavailable" },
    });
    expect(state.contentCapture.failed).toBe(1);
  });
});
