/** Real Chromium + actual HTTP WebDAV fixture. Test build alone permits loopback HTTP. */
import { chromium } from "playwright";
import { startDav } from "./dav-server.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import os from "node:os";
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, ["scripts/build.mjs", "--test"], {
  stdio: "inherit",
});
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tabrelay-e2e-"));
const dav = await startDav();
const contexts = [];
const results = [];
await fs.mkdir("evidence/screenshots", { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(100);
  }
  throw last || Error("Timed out waiting for condition");
}
async function test(name, fn) {
  await fn();
  results.push({ name, status: "passed" });
  console.log("PASS", name);
}
async function browser(name) {
  const extension = path.resolve("dist-test");
  const options = {
    headless: true,
    channel: "chromium",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
    viewport: { width: 1180, height: 900 },
    deviceScaleFactor: 2,
  };
  if (process.env.CHROMIUM_PATH) {
    options.executablePath = process.env.CHROMIUM_PATH;
    delete options.channel;
  }
  const context = await chromium.launchPersistentContext(
    path.join(root, name),
    options,
  );
  contexts.push(context);
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  const call = (message) =>
    page
      .evaluate((m) => chrome.runtime.sendMessage(m), message)
      .then((r) => {
        if (!r?.ok) throw Error(r?.error || "No response");
        return r.data;
      });
  await eventually(() => call({ type: "GET_STATE" }));
  return { name, context, worker, page, id, call };
}
async function populate(b, windows) {
  return b.worker.evaluate(
    async ({ windows, origin }) => {
      const existing = await chrome.windows.getAll({ populate: true });
      const normal = existing.filter((w) => w.type === "normal");
      const first = normal[0];
      let originals = [];
      for (let i = 0; i < windows.length; i++) {
        const spec = windows[i];
        let wid;
        if (i === 0 && first) {
          wid = first.id;
          const keep = first.tabs.find(
            (t) => !t.url?.startsWith("chrome-extension:"),
          );
          if (keep)
            await chrome.tabs.update(keep.id, {
              url: origin + "/fixture/" + spec[0],
            });
          else
            await chrome.tabs.create({
              windowId: wid,
              url: origin + "/fixture/" + spec[0],
            });
        } else
          wid = (
            await chrome.windows.create({
              url: origin + "/fixture/" + spec[0],
              focused: false,
            })
          ).id;
        for (const title of spec.slice(1))
          await chrome.tabs.create({
            windowId: wid,
            url: origin + "/fixture/" + title,
            active: false,
          });
        originals.push(wid);
      }
      return originals;
    },
    { windows, origin: dav.origin },
  );
}
async function configured(b, name) {
  let s = await b.call({ type: "GET_STATE" });
  await b.call({
    type: "SAVE_SETTINGS",
    settings: {
      ...s.settings,
      endpoint: dav.endpoint,
      deviceName: name,
      enabled: true,
      historyLimit: 5,
    },
  });
  await delay(100);
  await b.call({ type: "SYNC_NOW" });
  return eventually(async () => {
    const s = await b.call({ type: "GET_STATE" });
    if (s.sync.error) throw Error(s.sync.error);
    return s.sync.lastSuccess && !s.sync.dirty ? s : false;
  });
}
async function synced(b) {
  await b.call({ type: "SYNC_NOW" });
  return eventually(async () => {
    const s = await b.call({ type: "GET_STATE" });
    if (s.sync.dirty && !s.sync.pausedConflict)
      await b.call({ type: "SYNC_NOW" });
    return s.sync.lastSuccess && !s.sync.dirty && !s.sync.error ? s : false;
  });
}
const current = (id) =>
  JSON.parse(dav.files.get(`/dav/tabrelay/v1/devices/${id}/current.json`));
try {
  const a = await browser("A");
  let b = await browser("B");
  await populate(a, [
    ["AI-Research", "Agent-Architecture", "Resource-Cost"],
    ["Weekend-Cycling", "Route-Plan"],
  ]);
  const bOriginals = await populate(b, [
    ["Original-Work"],
    ["Original-Notes"],
    ["Original-Reading"],
  ]);
  await a.worker.evaluate(async () => {
    const windows = await chrome.windows.getAll({ populate: true });
    const w = windows.find((w) =>
      w.tabs?.some((t) => t.url?.includes("AI-Research")),
    );
    const tabs = w.tabs.filter((t) => t.url?.includes("/fixture/"));
    await chrome.tabs.update(tabs[0].id, { pinned: true });
    const gid = await chrome.tabs.group({
      tabIds: tabs.slice(1).map((t) => t.id),
      createProperties: { windowId: w.id },
    });
    await chrome.tabGroups.update(gid, {
      title: "AI 平台研究",
      color: "blue",
      collapsed: true,
    });
  });
  const sa = await configured(a, "工作电脑 A"),
    sb = await configured(b, "个人电脑 B");
  let source;
  let beforeB;
  await test("A/B profiles publish all ordinary windows independently", async () => {
    assert.notEqual(sa.deviceId, sb.deviceId);
    source = current(sa.deviceId);
    assert.equal(source.windows.length, 2);
    assert.equal(source.windows.flatMap((w) => w.tabs).length, 5);
    assert.equal(current(sb.deviceId).windows.length, 3);
    beforeB = await b.worker.evaluate(() =>
      chrome.windows.getAll({ populate: true }),
    );
    assert.ok(
      source.windows.some((w) =>
        w.groups.some((g) => g.title === "AI 平台研究"),
      ),
    );
  });
  const originalSource = JSON.stringify(source);
  await b.page.reload();
  await b.page.locator(`[data-device-id="${sa.deviceId}"]`).click();
  await b.page.locator("input[data-tab-key]").first().waitFor();
  await b.page.screenshot({
    path: "evidence/screenshots/01-devices-and-tabs.png",
    fullPage: true,
  });
  await b.page.locator("#preview-restore").click();
  await b.page.locator("#confirm-restore").waitFor();
  await b.page.screenshot({
    path: "evidence/screenshots/02-restore-confirmation.png",
    fullPage: true,
  });
  await test("UI confirmation restores source windows without modifying existing B windows", async () => {
    await b.page.locator("#confirm-restore").click();
    await eventually(async () => {
      const s = await b.call({ type: "GET_STATE" });
      return s.operation?.status === "COMPLETED" ? s : false;
    });
    const after = await b.worker.evaluate(() =>
      chrome.windows.getAll({ populate: true }),
    );
    for (const old of beforeB) {
      const w = after.find((w) => w.id === old.id);
      assert.ok(w);
      assert.deepEqual(
        w.tabs
          .filter((t) => t.url?.includes("/fixture/"))
          .map((t) => ({ id: t.id, url: t.url })),
        old.tabs
          .filter((t) => t.url?.includes("/fixture/"))
          .map((t) => ({ id: t.id, url: t.url })),
      );
    }
    assert.equal(after.length, beforeB.length + 2);
  });
  await test("Groups, order, pins and merged round-trip are preserved", async () => {
    const s = await synced(b);
    const merged = current(sb.deviceId);
    assert.equal(merged.windows.length, 5);
    assert.equal(merged.windows.flatMap((w) => w.tabs).length, 8);
    assert.equal(
      s.operation.failures.length,
      0,
      JSON.stringify(s.operation.failures),
    );
    const imported = s.operation.createdWindows;
    const w = await b.worker.evaluate(
      async (ids) => {
        const ws = [];
        for (const id of ids)
          ws.push(await chrome.windows.get(id, { populate: true }));
        return { ws, groups: await chrome.tabGroups.query({}) };
      },
      imported.map((w) => w.windowId),
    );
    assert.ok(
      w.groups.some(
        (g) => g.title === "AI 平台研究" && g.color === "blue" && g.collapsed,
      ),
    );
    for (const mapping of imported) {
      const expected = source.windows
        .find((x) => x.windowKey === mapping.sourceWindowKey)
        .tabs.slice()
        .sort((a, b) => a.index - b.index);
      const actual = w.ws
        .find((x) => x.id === mapping.windowId)
        .tabs.slice()
        .sort((a, b) => a.index - b.index);
      assert.deepEqual(
        actual.map((t) => ({ url: t.url, pinned: t.pinned })),
        expected.map((t) => ({ url: t.url, pinned: t.pinned })),
      );
    }
    const all = w.ws.flatMap((w) => w.tabs);
    assert.ok(all.find((t) => t.url?.includes("AI-Research"))?.pinned);
    assert.equal(JSON.stringify(current(sa.deviceId)), originalSource);
  });
  await b.page.reload();
  await synced(b);
  await delay(2200);
  await eventually(() =>
    b.page
      .locator("#operation-title")
      .textContent()
      .then((t) => t === "恢复完成"),
  );
  await b.page.screenshot({
    path: "evidence/screenshots/03-merged-result.png",
    fullPage: true,
  });
  await b.page.setViewportSize({ width: 420, height: 900 });
  await b.page.screenshot({
    path: "evidence/screenshots/04-sidepanel-compact.png",
    fullPage: true,
  });
  await b.page.setViewportSize({ width: 1180, height: 900 });
  await test("Same origin repeated restore is skipped; A to B to A does not loop", async () => {
    const p = await b.call({ type: "PLAN_RESTORE", snapshot: source });
    assert.equal(p.windows.length, 0);
    assert.equal(p.skipped.length, 5);
    const back = await a.call({
      type: "PLAN_RESTORE",
      snapshot: current(sb.deviceId),
    });
    assert.equal(back.windows.flatMap((w) => w.tabs).length, 3);
  });
  await test("Unsafe/malformed remote input is rejected before any window creation", async () => {
    const before = await b.worker.evaluate(() => chrome.windows.getAll());
    await assert.rejects(() =>
      b.call({
        type: "PLAN_RESTORE",
        snapshot: { ...source, schemaVersion: 99 },
      }),
    );
    const bad = structuredClone(source);
    bad.windows[0].tabs[0].url = "javascript:alert(1)";
    const plan = await b.call({ type: "PLAN_RESTORE", snapshot: bad });
    assert.ok(plan.skipped.some((x) => x.reason.includes("URL")));
    const after = await b.worker.evaluate(() => chrome.windows.getAll());
    assert.equal(after.length, before.length);
  });
  await test("401 and offline failure persist a pending snapshot and recover", async () => {
    dav.faults.status = 401;
    await b.call({ type: "SYNC_NOW" });
    await eventually(async () => {
      const s = await b.call({ type: "GET_STATE" });
      return s.sync.errorCode === "unauthorized" && s.sync.pending;
    });
    dav.faults.status = 0;
    await synced(b);
    dav.faults.offline = true;
    await b.call({ type: "SYNC_NOW" });
    await eventually(async () => {
      const s = await b.call({ type: "GET_STATE" });
      return s.sync.errorCode === "network" && s.sync.pending;
    });
    dav.faults.offline = false;
    await synced(b);
  });
  await test("Cancel stops future creations and retains originals plus partial additions", async () => {
    const snap = structuredClone(source);
    snap.snapshotId = "cancel-test";
    snap.windows = [
      {
        windowKey: "cancel-window",
        order: 0,
        groups: [],
        tabs: Array.from({ length: 25 }, (_, i) => ({
          tabKey: "cancel-" + i,
          url: dav.origin + "/fixture/cancel-" + i,
          title: "Cancel " + i,
          index: i,
          pinned: false,
          origin: { deviceId: "cancel-device", tabKey: "cancel-" + i },
        })),
      },
    ];
    const plan = await b.call({ type: "PLAN_RESTORE", snapshot: snap });
    await b.call({ type: "START_RESTORE", planId: plan.id });
    await eventually(async () => {
      const s = await b.call({ type: "GET_STATE" });
      return s.operation.createdTabs.length >= 2;
    });
    await b.call({ type: "CANCEL_RESTORE" });
    await delay(300);
    const s = await b.call({ type: "GET_STATE" });
    assert.equal(s.operation.status, "CANCELLED");
    assert.ok(s.operation.createdTabs.length < 25);
    for (const id of bOriginals)
      assert.ok(await b.worker.evaluate((id) => chrome.windows.get(id), id));
  });
  await synced(b);
  await test("Concurrent user tab changes are reflected in the merged snapshot", async () => {
    const snap = structuredClone(source);
    snap.snapshotId = "user-change-test";
    snap.windows = [
      {
        windowKey: "user-change-window",
        order: 0,
        groups: [],
        tabs: Array.from({ length: 20 }, (_, i) => ({
          tabKey: "user-change-" + i,
          url: dav.origin + "/fixture/user-change-" + i,
          title: "User change " + i,
          index: i,
          pinned: false,
          origin: {
            deviceId: "user-change-device",
            tabKey: "user-change-" + i,
          },
        })),
      },
    ];
    const plan = await b.call({ type: "PLAN_RESTORE", snapshot: snap });
    await b.call({ type: "START_RESTORE", planId: plan.id });
    await eventually(async () => {
      const s = await b.call({ type: "GET_STATE" });
      return s.operation.createdTabs.length >= 2;
    });
    await b.page.evaluate(async (origin) => {
      const tabs = await chrome.tabs.query({});
      const close = tabs.find((t) => t.url?.endsWith("/Original-Notes"));
      if (close) await chrome.tabs.remove(close.id);
      const edit = tabs.find((t) => t.url?.endsWith("/Original-Work"));
      if (edit)
        await chrome.tabs.update(edit.id, {
          url: origin + "/fixture/User-Edited-Work",
        });
    }, dav.origin);
    await eventually(async () => {
      const s = await b.call({ type: "GET_STATE" });
      return s.operation.status === "COMPLETED";
    });
    await synced(b);
    const urls = current(sb.deviceId).windows.flatMap((w) =>
      w.tabs.map((t) => t.url),
    );
    assert.ok(!urls.some((u) => u.endsWith("/Original-Notes")));
    assert.ok(urls.some((u) => u.endsWith("/User-Edited-Work")));
  });
  let interruptedSession;
  await test("Real MV3 worker termination preserves journal and does not replay uncertain work", async () => {
    const snap = structuredClone(source);
    snap.snapshotId = "worker-restart-test";
    snap.windows = [
      {
        windowKey: "worker-restart-window",
        order: 0,
        groups: [],
        tabs: Array.from({ length: 60 }, (_, i) => ({
          tabKey: "worker-restart-" + i,
          url: dav.origin + "/fixture/worker-restart-" + i,
          title: "Worker restart " + i,
          index: i,
          pinned: false,
          origin: {
            deviceId: "worker-restart-device",
            tabKey: "worker-restart-" + i,
          },
        })),
      },
    ];
    const originalTabs = await b.page.evaluate(async () =>
      (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })),
    );
    const plan = await b.call({ type: "PLAN_RESTORE", snapshot: snap });
    await b.call({ type: "START_RESTORE", planId: plan.id });
    await eventually(async () => {
      const s = await b.call({ type: "GET_STATE" });
      return s.operation.createdTabs.length >= 2;
    });
    const cdp = await b.context.newCDPSession(b.page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    const state = await eventually(async () => {
      const s = await b.call({ type: "GET_STATE" });
      return s.operation.status === "INTERRUPTED" ? s : false;
    });
    assert.ok(state.operation.createdTabs.length < 60);
    const count = await b.page.evaluate(
      async () => (await chrome.tabs.query({})).length,
    );
    await delay(500);
    assert.equal(
      await b.page.evaluate(async () => (await chrome.tabs.query({})).length),
      count,
    );
    const currentTabs = await b.page.evaluate(() => chrome.tabs.query({}));
    for (const t of originalTabs)
      assert.ok(currentTabs.some((x) => x.id === t.id && x.url === t.url));
    if (state.operation.uncertain)
      await assert.rejects(() => b.call({ type: "RESUME_RESTORE" }));
    interruptedSession = await b.page.evaluate(
      async () =>
        (await chrome.storage.local.get("state")).state.identities
          .browserSession,
    );
    await cdp.detach();
  });
  await test("Full profile restart retains UUID and refuses stale-runtime undo", async () => {
    const oldId = (await b.call({ type: "GET_STATE" })).deviceId;
    await b.context.close();
    b = await browser("B");
    assert.equal((await b.call({ type: "GET_STATE" })).deviceId, oldId);
    await eventually(() =>
      b.page.evaluate(
        async (old) =>
          (await chrome.storage.local.get("state")).state.identities
            .browserSession !== old,
        interruptedSession,
      ),
    );
    await assert.rejects(() =>
      b.call({ type: "UNDO_RESTORE", confirmed: true }),
    );
    await assert.rejects(() => b.call({ type: "RESUME_RESTORE" }));
    await b.call({ type: "CANCEL_RESTORE" });
    await synced(b);
  });
  await test("Empty current leaves last nonempty recovery intact", async () => {
    const before = dav.files.get(
      `/dav/tabrelay/v1/devices/${sb.deviceId}/recovery.json`,
    );
    await b.worker.evaluate(async () => {
      for (const t of await chrome.tabs.query({}))
        if (t.url?.includes("/fixture/")) await chrome.tabs.remove(t.id);
    });
    await synced(b);
    assert.equal(current(sb.deviceId).windows.length, 0);
    assert.equal(
      dav.files.get(`/dav/tabrelay/v1/devices/${sb.deviceId}/recovery.json`),
      before,
    );
  });
  await test("Same device writer conflict pauses instead of overwriting", async () => {
    const key = `/dav/tabrelay/v1/devices/${sa.deviceId}/current.json`;
    const modified = current(sa.deviceId);
    modified.revision += 100;
    modified.snapshotId = "other-writer";
    dav.files.set(key, JSON.stringify(modified));
    await a.call({ type: "SYNC_NOW" });
    await eventually(async () => {
      const s = await a.call({ type: "GET_STATE" });
      return s.sync.pausedConflict;
    });
    assert.equal(current(sa.deviceId).snapshotId, "other-writer");
  });
  console.log(`All ${results.length} real-browser E2E scenarios passed.`);
} catch (error) {
  results.push({ name: "execution", status: "failed", error: String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await dav.close();
  await fs.writeFile(
    "evidence/e2e-results.json",
    JSON.stringify(
      {
        transport: "test-only loopback HTTP; no TLS warning bypass",
        browser: "Playwright Chromium persistent profiles",
        results,
      },
      null,
      2,
    ),
  );
  await fs.rm(root, { recursive: true, force: true });
}
