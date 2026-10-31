/** Real Chromium + HTTP WebDAV fixture with explicit user-equivalent origin consent. */
import { chromium } from "playwright";
import { startDav } from "./dav-server.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import os from "node:os";
import crypto from "node:crypto";
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
const fixtureSnapshotId = (revision, time = "20261031-160000") =>
  `${time}Z-r${String(revision).padStart(12, "0")}`;
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
async function configured(b, name, endpoint = dav.endpoint) {
  let s = await b.call({ type: "GET_STATE" });
  await b.call({
    type: "SAVE_SETTINGS",
    settings: {
      ...s.settings,
      endpoint,
      httpAcknowledgedOrigin: new URL(endpoint).origin,
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

/** Curated labeled corpus. It tests these exact examples, not universal retrieval quality. */
function seedSearchFixture() {
  const endpoint = dav.origin + "/dav/search-fixture/";
  const rootPath = "/dav/search-fixture/tabrelay/v1/";
  const deviceId = "remote-search-device";
  const devicePath = rootPath + "devices/" + deviceId + "/";
  for (const dir of [
    "/dav/search-fixture/",
    rootPath,
    rootPath + "devices/",
    devicePath,
    devicePath + "history/",
  ])
    dav.dirs.add(dir);
  const tab = (
    tabKey,
    title,
    suffix,
    index,
    groupKey,
    originDevice = deviceId,
  ) => ({
    tabKey,
    title,
    url: dav.origin + "/fixture/" + suffix,
    index,
    pinned: false,
    ...(groupKey ? { groupKey } : {}),
    origin: { deviceId: originDevice, tabKey },
  });
  const make = (snapshotId, revision, windows) => ({
    schemaVersion: 1,
    deviceId,
    snapshotId,
    revision,
    capturedAt: "2026-10-31T16:00:00Z",
    windows,
  });
  const currentSnapshot = make("search-current", 2, [
    {
      windowKey: "search-current-window",
      order: 0,
      activeTabKey: "search-k8s",
      groups: [
        {
          groupKey: "engineering",
          title: "平台工程",
          color: "green",
          collapsed: false,
        },
      ],
      tabs: [
        tab(
          "search-k8s",
          "Kubernetes 调度实战",
          "kubernetes-scheduler",
          0,
          "engineering",
        ),
        tab(
          "search-duplicate-a",
          "重复标签 同一网址",
          "same-url",
          1,
          undefined,
          "origin-first",
        ),
        tab(
          "search-duplicate-b",
          "重复标签 同一网址",
          "same-url",
          2,
          undefined,
          "origin-second",
        ),
      ],
    },
  ]);
  const historical = make("search-history", 1, [
    {
      windowKey: "cost-window",
      order: 0,
      activeTabKey: "search-budget",
      groups: [
        {
          groupKey: "cost-group",
          title: "资源治理",
          color: "blue",
          collapsed: false,
        },
      ],
      tabs: [
        tab(
          "search-budget",
          "资源成本治理 GPU 预算",
          "gpu-budget-2026",
          0,
          "cost-group",
        ),
        tab(
          "search-finops",
          "FinOps 成本日报",
          "finops-daily",
          1,
          "cost-group",
        ),
        tab("search-reference", "容量模型参考", "capacity-model", 2),
      ],
    },
    {
      windowKey: "travel-window",
      order: 1,
      groups: [],
      tabs: [tab("search-trip", "周末骑行路线", "cycling-route", 0)],
    },
  ]);
  const recovery = make("search-empty-recovery", 1, []);
  dav.files.set(
    devicePath + "device.json",
    JSON.stringify({
      deviceId,
      name: "研究电脑 · 远端",
      version: "1.2.0",
      updatedAt: "2026-10-31T16:00:00Z",
      windows: 1,
      tabs: 3,
    }),
  );
  dav.files.set(devicePath + "current.json", JSON.stringify(currentSnapshot));
  dav.files.set(devicePath + "recovery.json", JSON.stringify(recovery));
  const historyId = "000000000001-search-history.json";
  dav.files.set(
    devicePath + "history/" + historyId,
    JSON.stringify(historical),
  );
  return {
    endpoint,
    deviceId,
    devicePath,
    currentSnapshot,
    historical,
    historyId,
  };
}
try {
  const a = await browser("A");
  let b = await browser("B");
  let optionsPage;
  await test("Manifest action popup opens the default search experience at popup dimensions", async () => {
    const manifest = await a.worker.evaluate(() =>
      chrome.runtime.getManifest(),
    );
    assert.equal(manifest.action.default_popup, "popup.html");
    const cdp = await a.context.newCDPSession(a.page);
    const actual = await a.worker.evaluate(async () => {
      try {
        await chrome.action.openPopup();
        return { opened: true };
      } catch (error) {
        return { opened: false, reason: String(error) };
      }
    });
    let target;
    if (actual.opened) {
      target = await eventually(
        async () =>
          (await cdp.send("Target.getTargets")).targetInfos.find(
            (info) => info.url === `chrome-extension://${a.id}/popup.html`,
          ),
        5000,
      );
      assert.ok(
        target,
        "Successful action.openPopup must produce a real popup target",
      );
    }
    await fs.writeFile(
      "evidence/action-popup-target.json",
      JSON.stringify(
        {
          ...actual,
          target: target && { type: target.type, url: target.url },
          fallback: actual.opened
            ? undefined
            : "Action popup unavailable in this Chromium environment; same document verified at popup viewport, not claimed as actual action target",
        },
        null,
        2,
      ),
    );
    if (target)
      await cdp.send("Target.closeTarget", { targetId: target.targetId });
    await cdp.detach();
    const popup = await a.context.newPage();
    await popup.setViewportSize({ width: 600, height: 600 });
    await popup.goto(`chrome-extension://${a.id}/popup.html`);
    await popup.locator("#search-query").waitFor();
    assert.equal(
      await popup.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Popup must not require horizontal scrolling",
    );
    await popup.screenshot({
      path: "evidence/screenshots/09-popup-default-search.png",
    });
    await popup.close();
  });
  await test("Settings opens in a dedicated tab and extension icons decode", async () => {
    const opened = a.context.waitForEvent("page");
    await a.page.locator("#settings-open").click();
    optionsPage = await opened;
    await optionsPage.waitForURL(`chrome-extension://${a.id}/options.html`);
    await optionsPage.locator("#settings-fields:not([disabled])").waitFor();
    assert.notEqual(optionsPage, a.page);
    assert.ok(a.page.url().endsWith("/sidepanel.html"));
    const icons = await optionsPage.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const dimensions = [];
      for (const [size, file] of Object.entries(manifest.icons)) {
        const image = new Image();
        image.src = chrome.runtime.getURL(file);
        await image.decode();
        dimensions.push({
          size: Number(size),
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      }
      return {
        dimensions,
        options: manifest.options_ui,
        action: manifest.action.default_icon,
      };
    });
    assert.equal(icons.options.open_in_tab, true);
    for (const icon of icons.dimensions)
      assert.deepEqual([icon.width, icon.height], [icon.size, icon.size]);
    assert.equal(icons.dimensions.length, 4);
    assert.ok(icons.action[16] && icons.action[32]);
  });
  await test("HTTP settings require explicit consent and HTTPS saves without insecure warning", async () => {
    await optionsPage.locator("#endpoint").fill(dav.endpoint);
    await optionsPage.locator("#device-name").fill("工作电脑 A");
    await optionsPage.locator("#enabled").uncheck();
    assert.equal(await optionsPage.locator("#http-risk").isVisible(), true);
    assert.equal(
      await optionsPage.locator("#http-acknowledged").isChecked(),
      false,
    );
    await optionsPage.locator("#save-settings").click();
    await eventually(async () =>
      (await optionsPage.locator("#settings-error").textContent()).includes(
        "明确勾选",
      ),
    );
    assert.equal((await a.call({ type: "GET_STATE" })).settings.endpoint, "");
    await optionsPage.locator("#http-acknowledged").check();
    await optionsPage.locator("#save-settings").click();
    await eventually(async () =>
      (await optionsPage.locator("#settings-error").textContent()).includes(
        "设置已保存",
      ),
    );
    let state = await a.call({ type: "GET_STATE" });
    assert.equal(state.settings.httpAcknowledgedOrigin, dav.origin);
    assert.equal(state.settings.enabled, false);
    await optionsPage.screenshot({
      path: "evidence/screenshots/05-http-settings-consent.png",
      fullPage: true,
    });
    await optionsPage
      .locator("#endpoint")
      .fill(dav.endpoint.replace("127.0.0.1", "localhost"));
    assert.equal(
      await optionsPage.locator("#http-acknowledged").isChecked(),
      false,
    );
    await optionsPage.locator("#save-settings").click();
    await eventually(async () =>
      (await optionsPage.locator("#settings-error").textContent()).includes(
        "明确勾选",
      ),
    );
    assert.equal(
      (await a.call({ type: "GET_STATE" })).settings.endpoint,
      dav.endpoint,
    );
    const httpsEndpoint = dav.endpoint.replace("http:", "https:");
    await optionsPage.locator("#endpoint").fill(httpsEndpoint);
    assert.equal(await optionsPage.locator("#http-risk").isVisible(), false);
    await optionsPage.locator("#save-settings").click();
    await eventually(async () =>
      (await optionsPage.locator("#settings-error").textContent()).includes(
        "设置已保存",
      ),
    );
    state = await a.call({ type: "GET_STATE" });
    assert.equal(state.settings.endpoint, httpsEndpoint);
    assert.equal(state.settings.enabled, false);
    await optionsPage.screenshot({
      path: "evidence/screenshots/06-https-settings.png",
      fullPage: true,
    });
    await optionsPage.close();
  });
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
    await chrome.tabs.update(tabs[0].id, { active: true });
    const second = windows.find((item) =>
      item.tabs?.some((t) => t.url?.includes("Weekend-Cycling")),
    );
    const secondTabs = second.tabs.filter((t) => t.url?.includes("/fixture/"));
    for (const tab of secondTabs)
      await chrome.tabs.update(tab.id, { pinned: true });
    await chrome.tabs.update(secondTabs[secondTabs.length - 1].id, {
      active: true,
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
  await test("Group-only selection restores one window with only group members", async () => {
    const c = await browser("C-group-only");
    const selected = structuredClone(source);
    selected.snapshotId = fixtureSnapshotId(
      selected.revision,
      "20261031-160100",
    );
    const sourceWindow = selected.windows.find((w) => w.groups.length);
    const selectedGroup = sourceWindow.groups[0];
    // An all-group window has no ungrouped active tab. Use the expanded variant
    // here; the main full-window scenario separately asserts collapsed=true.
    selectedGroup.collapsed = false;
    const expected = sourceWindow.tabs
      .filter((t) => t.groupKey === selectedGroup.groupKey)
      .sort((x, y) => x.index - y.index);
    const before = await c.page.evaluate(() =>
      chrome.windows.getAll({ populate: true }),
    );
    const plan = await c.call({
      type: "PLAN_RESTORE",
      snapshot: selected,
      selection: { groupKeys: [selectedGroup.groupKey] },
    });
    assert.equal(plan.windows.length, 1);
    assert.equal(plan.windows[0].tabs.length, expected.length);
    await c.call({ type: "START_RESTORE", planId: plan.id });
    const state = await eventually(async () => {
      const state = await c.call({ type: "GET_STATE" });
      return state.operation?.status === "COMPLETED" ? state : false;
    });
    assert.deepEqual(state.operation.failures, []);
    assert.equal(state.operation.createdWindows.length, 1);
    const actual = await c.page.evaluate(
      async (id) => ({
        window: await chrome.windows.get(id, { populate: true }),
        groups: await chrome.tabGroups.query({ windowId: id }),
        all: await chrome.windows.getAll({ populate: true }),
      }),
      state.operation.createdWindows[0].windowId,
    );
    assert.equal(actual.all.length, before.length + 1);
    for (const original of before)
      assert.deepEqual(
        actual.all
          .find((w) => w.id === original.id)
          .tabs.map((t) => ({ id: t.id, url: t.url })),
        original.tabs.map((t) => ({ id: t.id, url: t.url })),
      );
    assert.deepEqual(
      actual.window.tabs
        .slice()
        .sort((x, y) => x.index - y.index)
        .map((t) => t.url),
      expected.map((t) => t.url),
    );
    assert.equal(
      actual.window.tabs.some((t) => t.pinned),
      false,
    );
    assert.equal(actual.groups.length, 1);
    assert.deepEqual(
      {
        title: actual.groups[0].title,
        color: actual.groups[0].color,
        collapsed: actual.groups[0].collapsed,
      },
      {
        title: selectedGroup.title,
        color: selectedGroup.color,
        collapsed: false,
      },
    );
    assert.ok(
      actual.window.tabs.every((t) => t.groupId === actual.groups[0].id),
    );
    await c.context.close();
  });
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
      const sourceWindow = source.windows.find(
        (x) => x.windowKey === mapping.sourceWindowKey,
      );
      const activeExpected = sourceWindow.tabs.find(
        (t) => t.tabKey === sourceWindow.activeTabKey,
      );
      if (activeExpected)
        assert.equal(actual.find((t) => t.active)?.url, activeExpected.url);
    }
    assert.ok(
      w.ws.some((item) => item.tabs.filter((t) => t.pinned).length >= 2),
      "multiple pinned tabs survive restoration",
    );
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
    snap.snapshotId = fixtureSnapshotId(snap.revision, "20261031-160200");
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
    snap.snapshotId = fixtureSnapshotId(snap.revision, "20261031-160300");
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
    snap.snapshotId = fixtureSnapshotId(snap.revision, "20261031-160400");
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
    modified.snapshotId = fixtureSnapshotId(
      modified.revision,
      "20261031-160500",
    );
    dav.files.set(key, JSON.stringify(modified));
    await a.call({ type: "SYNC_NOW" });
    await eventually(async () => {
      const s = await a.call({ type: "GET_STATE" });
      return s.sync.pausedConflict;
    });
    assert.equal(current(sa.deviceId).snapshotId, modified.snapshotId);
  });
  const searchFixture = seedSearchFixture();
  const d = await browser("D-search");
  const localSearchPage = await d.context.newPage();
  await localSearchPage.goto(dav.origin + "/fixture/search-local");
  await localSearchPage.evaluate(() => {
    document.title = "本地 SRE 值班手册";
  });
  const sd = await configured(d, "搜索验证设备", searchFixture.endpoint);
  let searchPage;
  const querySearch = (query, filters = {}, limit = 100) =>
    d.call({ type: "SEARCH_QUERY", query, filters, limit });
  const waitSearch = (afterGeneration = -1) =>
    eventually(async () => {
      const status = await d.call({ type: "SEARCH_STATUS" });
      return !status.loading &&
        status.updatedAt &&
        status.generation > afterGeneration
        ? status
        : false;
    });
  let historicalHit;
  await test("Popup automatically indexes all retained snapshots without a history toggle", async () => {
    searchPage = await d.context.newPage();
    await searchPage.setViewportSize({ width: 600, height: 600 });
    await searchPage.goto(`chrome-extension://${d.id}/popup.html`);
    await searchPage.locator("#search-query").waitFor();
    assert.equal(await searchPage.locator("#include-history").count(), 0);
    const complete = await waitSearch();
    assert.ok(
      complete.sources.some(
        (source) => source.kind === "current" && source.status === "loaded",
      ),
      "Expected automatically loaded current source: " +
        JSON.stringify(complete),
    );
    assert.ok(
      complete.sources.some(
        (source) =>
          source.deviceId === searchFixture.deviceId &&
          source.kind === "recovery" &&
          source.status === "loaded",
      ),
      "Expected valid loaded empty recovery: " + JSON.stringify(complete),
    );
    assert.ok(
      complete.sources.some(
        (source) =>
          source.deviceId === searchFixture.deviceId &&
          source.kind === "history" &&
          source.status === "loaded",
      ),
      "Expected loaded historical source: " + JSON.stringify(complete),
    );
    const historicalResponse = await querySearch("资源成本治理");
    historicalHit = historicalResponse.results[0];
    assert.ok(
      historicalHit,
      "Expected labeled historical hit: " + JSON.stringify(historicalResponse),
    );
    assert.equal(historicalHit.tabKey, "search-budget");
    assert.equal(historicalHit.kind, "history");
    assert.equal(historicalHit.stale, true);
  });
  await test("Curated Chinese mixed-language title URL and group queries preserve provenance", async () => {
    const labels = [
      { query: "资源成本治理", expected: ["search-budget"] },
      { query: "gpu 预算", expected: ["search-budget"] },
      { query: "FinOps 成本日报", expected: ["search-finops"] },
      { query: "gpu-budget-2026", expected: ["search-budget"] },
      { query: "资源治理", expected: ["search-budget", "search-finops"] },
      { query: "KUBERNETES", expected: ["search-k8s"] },
      { query: "周末骑行", expected: ["search-trip"] },
    ];
    const measurements = [];
    for (const label of labels) {
      const response = await querySearch(
        label.query,
        { deviceId: searchFixture.deviceId },
        10,
      );
      const actual = response.results.map((result) => result.tabKey);
      const hits = label.expected.filter((key) => actual.includes(key)).length;
      const recallAt10 = hits / label.expected.length;
      assert.equal(
        recallAt10,
        1,
        label.query +
          " expected " +
          JSON.stringify(label.expected) +
          " response=" +
          JSON.stringify(response),
      );
      measurements.push({ ...label, returned: actual, recallAt10 });
    }
    const duplicate = await querySearch("same-url", {
      deviceId: searchFixture.deviceId,
      kind: "current",
    });
    assert.equal(
      duplicate.total,
      1,
      "Same URL should aggregate into one result: " + JSON.stringify(duplicate),
    );
    assert.equal(duplicate.occurrenceTotal, 2);
    const occurrences = duplicate.results[0].occurrences;
    assert.deepEqual(
      new Set(occurrences.map((result) => result.tabKey)),
      new Set(["search-duplicate-a", "search-duplicate-b"]),
    );
    assert.equal(new Set(occurrences.map((result) => result.id)).size, 2);
    const filtered = await querySearch(
      "",
      { deviceId: searchFixture.deviceId, kind: "history", group: "资源治理" },
      1,
    );
    assert.equal(filtered.total, 2);
    assert.equal(filtered.results.length, 1);
    assert.equal(filtered.results[0].groupTitle, "资源治理");
    await fs.writeFile(
      "evidence/search-recall-fixture.json",
      JSON.stringify(
        {
          scope:
            "Seven explicit labeled queries over the deterministic test fixture only; not a universal search-quality estimate",
          k: 10,
          measurements,
        },
        null,
        2,
      ),
    );
    await searchPage.locator("#search-query").fill("资源治理");
    await searchPage.locator("#search-submit").click();
    await searchPage
      .locator('.search-result[data-tab-key="search-budget"]')
      .waitFor();
    await searchPage.screenshot({
      path: "evidence/screenshots/07-search-history-results.png",
      fullPage: true,
    });
  });
  await test("Aggregated result source dropdown plans the selected exact occurrence", async () => {
    await searchPage.locator("#search-query").fill("same-url");
    await searchPage.locator("#search-submit").click();
    const card = searchPage.locator(".search-result").first();
    const selector = card.locator("select[data-action='select-source']");
    await selector.waitFor();
    const choices = await selector
      .locator("option")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({ value: node.value, text: node.textContent })),
      );
    assert.ok(
      choices.length >= 2,
      "Distinct same-URL provenance must remain selectable: " +
        JSON.stringify(choices),
    );
    const response = await querySearch("same-url", {
      deviceId: searchFixture.deviceId,
      kind: "current",
    });
    const leaf = response.results[0].occurrences.find(
      (item) => item.tabKey === "search-duplicate-b",
    );
    assert.ok(leaf);
    await selector.selectOption(leaf.id);
    await card.locator("[data-action='restore-tab']").click();
    await searchPage.locator("#search-restore-dialog[open]").waitFor();
    const plan = await d.page.evaluate(
      async () => (await chrome.storage.local.get("restorePlan")).restorePlan,
    );
    assert.equal(plan.windows[0].tabs[0].tabKey, "search-duplicate-b");
    assert.equal(plan.windows[0].tabs[0].origin.deviceId, "origin-second");
    await searchPage.keyboard.press("Escape");
    await searchPage.locator("#search-query").fill("资源治理");
    await searchPage.locator("#search-submit").click();
    await searchPage
      .locator('.search-result[data-tab-key="search-budget"]')
      .waitFor();
  });
  await test("Historical search tab group and window plans require confirmation and preserve existing windows", async () => {
    const before = await d.page.evaluate(() =>
      chrome.windows.getAll({ populate: true }),
    );
    const tabPlan = await d.call({
      type: "SEARCH_PLAN",
      sourceId: historicalHit.sourceId,
      tabKey: historicalHit.tabKey,
    });
    assert.equal(tabPlan.windows.length, 1);
    assert.equal(tabPlan.windows[0].tabs.length, 1);
    const groupPlan = await d.call({
      type: "SEARCH_PLAN",
      sourceId: historicalHit.sourceId,
      groupKey: historicalHit.groupKey,
    });
    assert.equal(groupPlan.windows[0].tabs.length, 2);
    const windowPlan = await d.call({
      type: "SEARCH_PLAN",
      sourceId: historicalHit.sourceId,
      windowKey: historicalHit.windowKey,
    });
    assert.equal(windowPlan.windows[0].tabs.length, 3);
    assert.equal(
      (await d.page.evaluate(() => chrome.windows.getAll())).length,
      before.length,
    );
    const card = searchPage
      .locator('.search-result[data-tab-key="search-budget"]')
      .first();
    await card.locator('[data-action="restore-group"]').click();
    await searchPage.locator("#search-restore-dialog[open]").waitFor();
    assert.ok(
      (
        await searchPage.locator("#search-plan-existing").textContent()
      ).includes(String(before.length)),
    );
    await searchPage.screenshot({
      path: "evidence/screenshots/08-search-restore-preview.png",
      fullPage: true,
    });
    await searchPage.locator("#search-confirm-restore").click();
    const restored = await eventually(async () => {
      const s = await d.call({ type: "GET_STATE" });
      return s.operation?.status === "COMPLETED" ? s : false;
    });
    assert.equal(restored.operation.createdWindows.length, 1);
    assert.equal(restored.operation.createdTabs.length, 2);
    assert.deepEqual(restored.operation.failures, []);
    const after = await d.page.evaluate(() =>
      chrome.windows.getAll({ populate: true }),
    );
    assert.equal(after.length, before.length + 1);
    for (const original of before)
      assert.deepEqual(
        after
          .find((w) => w.id === original.id)
          .tabs.map((t) => ({ id: t.id, url: t.url })),
        original.tabs.map((t) => ({ id: t.id, url: t.url })),
      );
    await synced(d);
    for (const action of [
      { query: "容量模型参考", key: "search-reference", scope: "tab" },
      { query: "周末骑行路线", key: "search-trip", scope: "window" },
    ]) {
      await searchPage.locator("#search-query").fill(action.query);
      await searchPage.locator("#search-submit").click();
      const result = searchPage
        .locator(`.search-result[data-tab-key="${action.key}"]`)
        .first();
      await result.waitFor();
      await result.locator(`[data-action="restore-${action.scope}"]`).click();
      await searchPage.locator("#search-restore-dialog[open]").waitFor();
      const priorOperation = (await d.call({ type: "GET_STATE" })).operation.id;
      await searchPage.locator("#search-confirm-restore").click();
      const additional = await eventually(async () => {
        const state = await d.call({ type: "GET_STATE" });
        return state.operation?.id !== priorOperation &&
          state.operation?.status === "COMPLETED"
          ? state
          : false;
      });
      assert.equal(additional.operation.createdWindows.length, 1);
      assert.equal(additional.operation.createdTabs.length, 1);
      assert.deepEqual(additional.operation.failures, []);
      await synced(d);
    }
    const finalWindows = await d.page.evaluate(() =>
      chrome.windows.getAll({ populate: true }),
    );
    assert.equal(finalWindows.length, before.length + 3);
    for (const original of before)
      assert.deepEqual(
        finalWindows
          .find((w) => w.id === original.id)
          .tabs.map((t) => ({ id: t.id, url: t.url })),
        original.tabs.map((t) => ({ id: t.id, url: t.url })),
      );
    const settings = (await d.call({ type: "GET_STATE" })).settings;
    await d.call({
      type: "SAVE_SETTINGS",
      settings: { ...settings, enabled: false },
    });
  });
  await test("Search local locate verifies current identity and rejects a stale navigated result", async () => {
    await d.call({ type: "SEARCH_LOAD", includeHistory: true });
    await waitSearch();
    const local = await querySearch("search-local", {
      deviceId: sd.deviceId,
      kind: "current",
    });
    assert.equal(
      local.total,
      1,
      "Expected one verified local current occurrence: " +
        JSON.stringify(local),
    );
    const located = await d.call({
      type: "SEARCH_LOCATE",
      resultId: local.results[0].id,
    });
    const active = await d.page.evaluate(
      async (id) => chrome.tabs.get(id),
      located.tabId,
    );
    assert.equal(active.active, true);
    assert.ok(active.url.endsWith("/search-local"));
    await localSearchPage.goto(dav.origin + "/fixture/search-local-navigated");
    await assert.rejects(() =>
      d.call({ type: "SEARCH_LOCATE", resultId: local.results[0].id }),
    );
  });
  await test("Clearing local search pauses automatic reload across popup reopen until rebuild", async () => {
    await searchPage.locator("#clear-cache").click();
    await eventually(
      async () =>
        (await d.call({ type: "SEARCH_STATUS" })).sources.length === 0,
    );
    await searchPage.close();
    const requestCount = dav.requests.length;
    searchPage = await d.context.newPage();
    await searchPage.setViewportSize({ width: 600, height: 600 });
    await searchPage.goto(`chrome-extension://${d.id}/popup.html`);
    await searchPage.locator("#search-query").waitFor();
    await delay(500);
    assert.equal((await d.call({ type: "SEARCH_STATUS" })).sources.length, 0);
    assert.equal(
      dav.requests.length,
      requestCount,
      "Paused popup must not implicitly refill from WebDAV",
    );
    await searchPage.locator("#rebuild-cache").click();
    await waitSearch();
    assert.ok((await querySearch("资源成本治理")).total >= 1);
    const beforeClose = await d.call({ type: "SEARCH_STATUS" });
    await searchPage.close();
    searchPage = await d.context.newPage();
    await searchPage.setViewportSize({ width: 600, height: 600 });
    await searchPage.goto(`chrome-extension://${d.id}/popup.html`);
    await searchPage.locator("#search-query").waitFor();
    assert.ok(
      (await d.call({ type: "SEARCH_STATUS" })).sources.length >=
        beforeClose.sources.length,
    );
  });
  await test("Search exposes failed sources and cancellation prevents late writes", async () => {
    const currentKey = searchFixture.devicePath + "current.json";
    const saved = dav.files.get(currentKey);
    dav.files.delete(currentKey);
    await d.call({ type: "SEARCH_LOAD", includeHistory: true });
    const failed = await waitSearch();
    assert.ok(
      failed.sources.some(
        (source) =>
          source.deviceId === searchFixture.deviceId &&
          source.kind === "current" &&
          source.status === "loaded" &&
          source.stale === true &&
          Boolean(source.error),
      ),
      "Expected retained current cache with explicit stale/failure diagnostic: " +
        JSON.stringify(failed),
    );
    assert.ok(
      failed.sources.some(
        (source) =>
          source.deviceId === searchFixture.deviceId &&
          source.kind === "recovery" &&
          source.status === "loaded",
      ),
      "Expected empty recovery loaded despite current source failure: " +
        JSON.stringify(failed),
    );
    assert.ok((await querySearch("资源成本治理")).total >= 1);
    dav.files.set(currentKey, saved);
    dav.faults.delay = 450;
    await d.call({ type: "SEARCH_LOAD", includeHistory: true });
    await d.call({ type: "SEARCH_CANCEL" });
    const cancelled = await d.call({ type: "SEARCH_STATUS" });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.loading, false);
    const preserved = JSON.stringify(cancelled.sources);
    // Two device metadata reads plus the delayed directory read are bounded by 3 × 450 ms.
    await delay(1800);
    assert.equal(
      JSON.stringify((await d.call({ type: "SEARCH_STATUS" })).sources),
      preserved,
    );
    dav.faults.delay = 0;
    await d.call({ type: "SEARCH_LOAD", includeHistory: true });
    await waitSearch();
    assert.ok((await querySearch("资源成本治理")).total >= 1);
    let settings = (await d.call({ type: "GET_STATE" })).settings;
    await d.call({
      type: "SAVE_SETTINGS",
      settings: { ...settings, enabled: false, blacklist: ["127.0.0.1"] },
    });
    const reset = await d.call({ type: "SEARCH_STATUS" });
    assert.equal(reset.sources.length, 0);
    assert.equal((await querySearch("资源成本治理")).total, 0);
    await assert.rejects(() =>
      d.call({
        type: "SEARCH_PLAN",
        sourceId: historicalHit.sourceId,
        tabKey: historicalHit.tabKey,
      }),
    );
  });
  await test("Opt-in body capture excludes private DOM fields and supports Chinese snippet search", async () => {
    const e = await browser("E-body");
    const bodyPage = await e.context.newPage();
    await bodyPage.goto(dav.origin + "/fixture/body-privacy");
    const bodyState = await configured(e, "正文验证设备");
    const findBody = () =>
      current(bodyState.deviceId)
        .windows.flatMap((w) => w.tabs)
        .find((tab) => tab.url.endsWith("/fixture/body-privacy"));
    assert.equal(findBody().content?.status, "disabled");
    assert.equal(findBody().content?.ref, undefined);
    const options = await e.context.newPage();
    await options.goto(`chrome-extension://${e.id}/options.html`);
    await options.locator("#settings-fields:not([disabled])").waitFor();
    await options.locator("#content-settings > summary").click();
    await options.locator("#content-enabled").waitFor();
    assert.equal(await options.locator("#content-enabled").isChecked(), false);
    assert.deepEqual(
      await options
        .locator("#sync-interval option")
        .evaluateAll((nodes) => nodes.map((node) => node.value)),
      ["5", "10", "30", "60", "1440"],
    );
    await options.locator("#content-origins").fill(dav.origin);
    await options.locator("#content-enabled").check();
    await options.screenshot({
      path: "evidence/screenshots/12-body-origin-consent-settings.png",
      fullPage: true,
    });
    await options.locator("#save-settings").click();
    await eventually(
      async () => (await e.call({ type: "GET_STATE" })).settings.contentEnabled,
    );
    await synced(e);
    const captured = findBody();
    assert.equal(current(bodyState.deviceId).schemaVersion, 2);
    assert.equal(
      captured.content.status,
      "available",
      JSON.stringify(captured),
    );
    assert.equal(captured.content.ref.captureUrl, captured.url);
    const objectPath = `/dav/tabrelay/v1/devices/${bodyState.deviceId}/objects/text/${captured.content.ref.objectId}.json`;
    const object = dav.files.get(objectPath);
    assert.ok(
      object,
      "Immutable body ref object must exist before snapshot publication",
    );
    assert.ok(object.includes("量子陀螺导航"));
    assert.ok(object.includes("sapphire-resonator-protocol"));
    assert.equal(
      /SECRET_[A-Z]+_739/.test(object),
      false,
      "Private/hidden/form/script text must not enter stored body object",
    );
    const popup = await e.context.newPage();
    await popup.setViewportSize({ width: 600, height: 600 });
    await popup.goto(`chrome-extension://${e.id}/popup.html`);
    await eventually(async () => {
      const status = await e.call({ type: "SEARCH_STATUS" });
      return status.updatedAt && !status.loading;
    });
    const bodyResults = await e.call({
      type: "SEARCH_QUERY",
      query: "量子陀螺导航",
      filters: { deviceId: bodyState.deviceId },
      limit: 20,
    });
    assert.ok(bodyResults.total >= 1, JSON.stringify(bodyResults));
    assert.ok(
      bodyResults.results.some((result) =>
        result.bodySnippet?.includes("量子陀螺导航"),
      ),
      JSON.stringify(bodyResults),
    );
    assert.equal(
      (
        await e.call({
          type: "SEARCH_QUERY",
          query: "SECRET_INPUT_739",
          limit: 100,
        })
      ).total,
      0,
    );
    await popup.locator("#search-query").fill("量子陀螺导航");
    await popup.locator("#search-submit").click();
    await popup.locator(".search-result").first().waitFor();
    await popup.screenshot({
      path: "evidence/screenshots/10-body-chinese-search.png",
      fullPage: true,
    });
    // Repeated unchanged content is content-addressed, not a new raw body per snapshot.
    const beforeObjects = [...dav.files.keys()].filter((key) =>
      key.includes(`/devices/${bodyState.deviceId}/objects/text/`),
    );
    await synced(e);
    assert.deepEqual(
      [...dav.files.keys()].filter((key) =>
        key.includes(`/devices/${bodyState.deviceId}/objects/text/`),
      ),
      beforeObjects,
    );
    const names = [...dav.files.keys()]
      .filter((key) => key.includes(`/devices/${bodyState.deviceId}/history/`))
      .map((key) => key.split("/").pop());
    assert.ok(
      names.some((name) => /20[0-9]{2}[-_]?[0-9]{2}[-_]?[0-9]{2}/.test(name)),
      "New history identifiers must expose a human-readable date: " +
        JSON.stringify(names),
    );
  });
  await test("Encrypted IndexedDB search retains a genuine six-megabyte Chinese body corpus without duplicate copies", async () => {
    const deviceId = "large-corpus-device",
      rootPath = "/dav/large-corpus/tabrelay/v1/";
    const devicePath = rootPath + `devices/${deviceId}/`;
    for (const dir of [
      "/dav/large-corpus/",
      rootPath,
      rootPath + "devices/",
      devicePath,
      devicePath + "history/",
      devicePath + "objects/",
      devicePath + "objects/text/",
    ])
      dav.dirs.add(dir);
    const lateMarker = "第九十九页独特标记蓝宝石导航";
    const tabs = [];
    let corpusBytes = 0;
    for (let index = 0; index < 100; index++) {
      const text = (
        "中".repeat(19920) +
        `容量语料第${index}页` +
        (index === 99 ? lateMarker : "")
      ).padEnd(20000, "文");
      const canonical = JSON.stringify({
        schemaVersion: 1,
        extractionVersion: 1,
        text,
      });
      const objectId = crypto
        .createHash("sha256")
        .update(canonical)
        .digest("hex");
      const bytes = Buffer.byteLength(text, "utf8");
      corpusBytes += bytes;
      dav.files.set(devicePath + `objects/text/${objectId}.json`, canonical);
      const url = dav.origin + "/fixture/large-corpus-" + index;
      tabs.push({
        tabKey: "large-tab-" + index,
        url,
        title: "容量测试页面 " + index,
        index,
        pinned: false,
        origin: { deviceId, tabKey: "large-tab-" + index },
        content: {
          status: "available",
          ref: {
            ownerDeviceId: deviceId,
            objectId,
            bytes,
            observedAt: "2026-10-31T16:00:00Z",
            captureUrl: url,
          },
        },
      });
    }
    assert.ok(corpusBytes > 3 * 1024 * 1024);
    const snapshot = (revision) => ({
      schemaVersion: 2,
      deviceId,
      revision,
      snapshotId: fixtureSnapshotId(revision),
      capturedAt: "2026-10-31T16:00:00Z",
      windows: [{ windowKey: "large-window", order: 0, groups: [], tabs }],
    });
    dav.files.set(devicePath + "current.json", JSON.stringify(snapshot(2)));
    dav.files.set(devicePath + "recovery.json", JSON.stringify(snapshot(1)));
    dav.files.set(
      devicePath + `history/${fixtureSnapshotId(1)}.json`,
      JSON.stringify(snapshot(1)),
    );
    dav.files.set(
      devicePath + "device.json",
      JSON.stringify({
        deviceId,
        name: "大正文语料验证",
        version: "2.0.0",
        updatedAt: "2026-10-31T16:00:00Z",
        windows: 1,
        tabs: 100,
      }),
    );
    let f = await browser("F-large-corpus");
    await configured(f, "容量验证设备", dav.origin + "/dav/large-corpus/");
    const beforeReads = dav.requests.filter(
      (r) =>
        r.path.includes(`/devices/${deviceId}/objects/text/`) &&
        r.method === "GET",
    ).length;
    await f.call({ type: "SEARCH_LOAD" });
    const status = await eventually(async () => {
      const state = await f.call({ type: "SEARCH_STATUS" });
      return !state.loading && state.updatedAt ? state : false;
    }, 120000);
    assert.equal(status.bodyLoaded, 100, JSON.stringify(status));
    assert.equal(status.bodyMissing, 0, JSON.stringify(status));
    assert.equal(status.bodyTruncated, 0, JSON.stringify(status));
    assert.equal(status.truncated, false, JSON.stringify(status));
    const objectReads =
      dav.requests.filter(
        (r) =>
          r.path.includes(`/devices/${deviceId}/objects/text/`) &&
          r.method === "GET",
      ).length - beforeReads;
    assert.equal(
      objectReads,
      100,
      "Repeated references across three snapshots must load each immutable body only once",
    );
    const late = await f.call({
      type: "SEARCH_QUERY",
      query: lateMarker,
      filters: { deviceId },
      limit: 10,
    });
    assert.equal(late.total, 1, JSON.stringify(late));
    assert.equal(late.occurrenceTotal, 3);
    assert.ok(late.results[0].bodySnippet.includes(lateMarker));
    const inspectDatabase = (page) =>
      page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("tabrelay-search-v2", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const records = await new Promise((resolve, reject) => {
            const request = db
              .transaction("records", "readonly")
              .objectStore("records")
              .getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          return {
            records: records.length,
            bodyRecords: records.filter((record) => record.kind === "body")
              .length,
            ciphertextBytes: records.reduce(
              (sum, record) => sum + record.ciphertext.byteLength,
              0,
            ),
            encryptedOnly: records.every(
              (record) =>
                record.ciphertext instanceof ArrayBuffer &&
                record.ciphertext.byteLength >= 16 &&
                record.iv instanceof ArrayBuffer &&
                record.iv.byteLength === 12 &&
                Object.keys(record).sort().join(",") ===
                  "ciphertext,id,iv,kind",
            ),
          };
        } finally {
          db.close();
        }
      });
    const encryptedDatabase = await inspectDatabase(f.page);
    assert.equal(
      encryptedDatabase.bodyRecords,
      100,
      "IDB must persist exactly one encrypted record per unique body",
    );
    assert.equal(encryptedDatabase.encryptedOnly, true);
    assert.ok(encryptedDatabase.ciphertextBytes > 3 * 1024 * 1024);
    const session = await f.page.evaluate(() =>
      chrome.storage.session.get(null),
    );
    const sessionJson = JSON.stringify(session);
    assert.equal(
      sessionJson.includes(lateMarker),
      false,
      "Session storage must not retain plaintext body cache",
    );
    assert.ok(
      Buffer.byteLength(sessionJson) < 1024 * 1024,
      "Bulk corpus belongs in encrypted IndexedDB, not Chrome session quota",
    );
    await fs.writeFile(
      "evidence/large-corpus.json",
      JSON.stringify(
        {
          objects: 100,
          encryptedDatabase,
          utf8BodyBytes: corpusBytes,
          bodyLoaded: status.bodyLoaded,
          bodyMissing: status.bodyMissing,
          bodyTruncated: status.bodyTruncated,
          cacheTruncated: status.truncated,
          objectGets: objectReads,
          retainedOccurrences: late.occurrenceTotal,
          lateMarkerHit: true,
          sessionStorageBytes: Buffer.byteLength(sessionJson),
          browser:
            "Actual Chromium extension search pipeline; loopback synthetic fixtures only",
        },
        null,
        2,
      ),
    );
    const requestsBeforeRestart = dav.requests.length;
    await f.context.close();
    f = await browser("F-large-corpus");
    const afterRestart = await f.call({ type: "SEARCH_STATUS" });
    assert.equal(
      afterRestart.sources.length,
      0,
      "Browser-session key loss must discard old encrypted local search cache",
    );
    assert.equal(
      (await f.call({ type: "SEARCH_QUERY", query: lateMarker })).total,
      0,
    );
    assert.equal(
      (await inspectDatabase(f.page)).records,
      0,
      "Unreadable old-key ciphertext must be purged on browser restart",
    );
    assert.equal(
      dav.requests.length,
      requestsBeforeRestart,
      "Cache restart inspection must not silently fetch the corpus",
    );
  });
  await test("Closing popup during restore preserves the background journal and reopened progress", async () => {
    const g = await browser("G-popup-restore");
    const originalPage = await g.context.newPage();
    await originalPage.goto(dav.origin + "/fixture/popup-original");
    const originalTabs = await g.page.evaluate(() => chrome.tabs.query({}));
    const fixture = {
      schemaVersion: 2,
      deviceId: "popup-source",
      revision: 1,
      snapshotId: fixtureSnapshotId(1),
      capturedAt: "2026-10-31T16:00:00Z",
      windows: [
        {
          windowKey: "popup-source-window",
          order: 0,
          groups: [],
          tabs: Array.from({ length: 10 }, (_, index) => ({
            tabKey: "popup-restore-" + index,
            url: dav.origin + "/fixture/popup-restore-" + index,
            title: "Popup restore " + index,
            index,
            pinned: false,
            origin: {
              deviceId: "popup-source",
              tabKey: "popup-restore-" + index,
            },
          })),
        },
      ],
    };
    let popup = await g.context.newPage();
    await popup.setViewportSize({ width: 600, height: 600 });
    await popup.goto(`chrome-extension://${g.id}/popup.html`);
    await popup.locator("#search-query").waitFor();
    const plan = await g.call({ type: "PLAN_RESTORE", snapshot: fixture });
    const response = await popup.evaluate(
      (message) => chrome.runtime.sendMessage(message),
      { type: "START_RESTORE", planId: plan.id },
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    const running = await eventually(async () => {
      const state = await g.call({ type: "GET_STATE" });
      return state.operation?.status === "RUNNING" &&
        state.operation.createdTabs.length > 0
        ? state
        : false;
    });
    assert.ok(
      running.operation.createdTabs.length < 10,
      "Popup must close while work actually remains",
    );
    await popup.close();
    const completed = await eventually(async () => {
      const state = await g.call({ type: "GET_STATE" });
      return state.operation?.status === "COMPLETED" ? state : false;
    });
    assert.equal(completed.operation.id, running.operation.id);
    assert.equal(completed.operation.createdTabs.length, 10);
    assert.deepEqual(completed.operation.failures, []);
    popup = await g.context.newPage();
    await popup.setViewportSize({ width: 600, height: 600 });
    await popup.goto(`chrome-extension://${g.id}/popup.html`);
    await eventually(
      async () =>
        (await popup.locator("#workbench-operation-title").textContent()) ===
        "恢复完成",
    );
    assert.equal(await popup.locator("#workbench-operation").isVisible(), true);
    const after = await g.page.evaluate(() => chrome.tabs.query({}));
    for (const original of originalTabs)
      assert.equal(
        after.find((tab) => tab.id === original.id)?.url,
        original.url,
      );
    await popup.screenshot({
      path: "evidence/screenshots/11-popup-restored-journal.png",
      fullPage: true,
    });
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
        transport:
          "loopback HTTP fixture with explicit per-origin consent; no TLS warning bypass",
        browser: "Playwright Chromium persistent profiles",
        results,
      },
      null,
      2,
    ),
  );
  await fs.rm(root, { recursive: true, force: true });
}
