import {
  searchStatus,
  loadSearch,
  cancelSearch,
  clearSearch,
  querySearch,
  getSearchSource,
  getSearchResult,
} from "./search";
import { load, update, dirty } from "./state";
import { collect } from "./collector";
import {
  checkSettings,
  hash,
  makePlan,
  validateSnapshot,
  safeUrl,
} from "./model";
import { WebDAVRepository } from "./webdav";
import {
  prepare,
  execute,
  cancel,
  undo,
  isRestoring,
  interruptOnBoot,
} from "./restore";
import type { Plan, Device } from "./types";
let timer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let commandBusy = false;
let startupUntil = Date.now() + 3000;
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await load();
  // storage.session is cleared on a complete browser restart, but survives MV3 worker suspension.
  // Do not rely solely on runtime.onStartup: unpacked/reloaded extension startup can omit that event.
  const session = await chrome.storage.session.get("browserSession");
  const browserSession =
    typeof session.browserSession === "string"
      ? session.browserSession
      : crypto.randomUUID();
  if (!session.browserSession)
    await chrome.storage.session.set({ browserSession });
  await update((s) => {
    if (s.identities.browserSession !== browserSession) {
      s.identities = { browserSession, tabs: {}, windows: {}, groups: {} };
      s.sync.dirty = true;
      s.sync.generation++;
      if (
        s.operation &&
        ["PREPARED", "RUNNING", "INTERRUPTED"].includes(s.operation.status)
      ) {
        s.operation.status = "INTERRUPTED";
        s.operation.error =
          "浏览器会话已变化，无法安全自动续做或撤销旧窗口。请保留当前结果并停止任务。";
      }
      startupUntil = Date.now() + 10_000;
    }
  });
  await interruptOnBoot();
  await chrome.alarms.create("tabrelay-reconcile", { periodInMinutes: 0.5 });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
})();
async function mark() {
  await ready;
  await dirty();
  clearTimeout(timer);
  timer = setTimeout(() => void sync().catch(() => {}), 3000);
}
function safeError(e: unknown) {
  return e instanceof Error ? e.message.slice(0, 400) : "操作失败，请重试";
}
export async function sync(force = false) {
  await ready;
  if (syncing || isRestoring() || commandBusy) return;
  if (Date.now() < startupUntil && !force) return;
  syncing = true;
  try {
    let s = await load();
    if (!s.settings.enabled || !s.settings.endpoint || s.sync.pausedConflict)
      return;
    if (!force && !s.sync.dirty) return;
    const generation = s.sync.generation;
    const retrying = !!s.sync.pending;
    const send = validateSnapshot(s.sync.pending || (await collect()));
    s = await load();
    const digest = await hash({
      windows: send.windows,
      deviceName: s.settings.deviceName,
      blacklist: s.settings.blacklist,
      stripParams: s.settings.stripParams,
      encryption: !!s.settings.encryptionPassphrase,
    });
    if (!force && !retrying && digest === s.sync.lastHash) {
      await update((x) => {
        if (x.sync.generation === generation) {
          x.sync.dirty = false;
          if (
            x.operation &&
            ["COMPLETED", "CANCELLED", "ROLLED_BACK"].includes(
              x.operation.status,
            )
          )
            x.operation.syncStatus = "synced";
        }
      });
      return;
    }
    // Always reconcile the durable pending version first. A newer local capture cannot replace an uncertain commit.
    await update((x) => {
      x.sync.pending = send;
    });
    const repo = new WebDAVRepository(s.settings);
    const device: Device = {
      deviceId: s.deviceId,
      name: s.settings.deviceName,
      version: chrome.runtime.getManifest().version,
      updatedAt: new Date().toISOString(),
      windows: send.windows.length,
      tabs: send.windows.reduce((n, w) => n + w.tabs.length, 0),
    };
    const r = await repo.publish(send, device, s.sync.etag);
    await update((x) => {
      x.sync.revision = send.revision;
      x.sync.etag = r.etag;
      x.sync.lastHash = digest;
      x.sync.lastSuccess = new Date().toISOString();
      x.sync.error = undefined;
      x.sync.errorCode = undefined;
      x.sync.pending = undefined;
      x.sync.retryCount = 0;
      if (x.sync.generation === generation && !retrying) x.sync.dirty = false;
      if (
        !retrying &&
        x.sync.generation === generation &&
        x.operation &&
        ["COMPLETED", "CANCELLED", "ROLLED_BACK"].includes(x.operation.status)
      )
        x.operation.syncStatus = "synced";
    });
  } catch (e) {
    await update((s) => {
      s.sync.error = safeError(e);
      s.sync.errorCode = (e as any)?.code || "network";
      s.sync.retryCount++;
      s.sync.dirty = true;
      if ((e as any)?.code === "conflict") s.sync.pausedConflict = true;
    });
  } finally {
    syncing = false;
  }
}
async function handle(m: any) {
  const exclusive = [
    "SAVE_SETTINGS",
    "START_RESTORE",
    "RESET_ID",
    "UNDO_RESTORE",
    "SEARCH_PLAN",
    "SEARCH_LOAD",
    "SEARCH_CLEAR",
    "SEARCH_CANCEL",
    "SEARCH_LOCATE",
  ].includes(m?.type);
  if (exclusive && commandBusy) throw Error("另一操作正在处理，请稍后重试");
  if (exclusive) commandBusy = true;
  try {
    return await handleInner(m);
  } finally {
    if (exclusive) {
      commandBusy = false;
      setTimeout(() => void sync(), 0);
    }
  }
}
async function handleInner(m: any) {
  await ready;
  switch (m?.type) {
    case "GET_STATE": {
      const s = await load();
      return { ...s, identities: undefined };
    }
    case "SAVE_SETTINGS": {
      if (syncing || isRestoring())
        throw Error("同步或恢复正在进行，请稍后保存配置");
      const settings = checkSettings(m.settings);
      if (
        settings.endpoint &&
        !(await chrome.permissions.contains({
          origins: [new URL(settings.endpoint).origin + "/*"],
        }))
      )
        throw Error("请先授权此 WebDAV 主机");
      await update((s) => {
        if (syncing || isRestoring())
          throw Error("同步或恢复正在进行，请稍后保存配置");
        const changed = s.settings.endpoint !== settings.endpoint;
        if (
          !changed &&
          (s.sync.revision > 0 || s.sync.pending) &&
          s.settings.encryptionPassphrase !== settings.encryptionPassphrase
        )
          throw Error(
            "此设备已有远端快照。更换加密口令请使用新的 WebDAV 目录，避免旧恢复点无法读取。",
          );
        s.settings = settings;
        if (changed) {
          s.sync.etag = undefined;
          s.sync.lastHash = undefined;
          s.sync.pending = undefined;
          s.sync.pausedConflict = false;
          s.sync.revision = 0;
        }
        s.sync.dirty = true;
        s.sync.generation++;
      });
      await clearSearch();
      await chrome.storage.local.remove("restorePlan");
      return true;
    }
    case "TEST_CONNECTION": {
      const settings = checkSettings(m.settings || (await load()).settings);
      await new WebDAVRepository(settings).connectionTest();
      return true;
    }
    case "SYNC_NOW":
      await dirty();
      await sync(true);
      return (await load()).sync;
    case "LIST_DEVICES":
      return new WebDAVRepository((await load()).settings).listDevices();
    case "GET_SNAPSHOT":
      return validateSnapshot(
        await new WebDAVRepository((await load()).settings).readSnapshot(
          m.deviceId,
          m.kind,
          m.historyId,
        ),
      );
    case "LIST_HISTORY":
      return new WebDAVRepository((await load()).settings).listHistory(
        m.deviceId,
      );
    case "SEARCH_STATUS":
      return searchStatus();
    case "SEARCH_QUERY":
      return querySearch(String(m.query || ""), m.filters || {}, m.limit || 50);
    case "SEARCH_LOAD":
      await chrome.storage.local.remove("restorePlan");
      return loadSearch(m.includeHistory === true);
    case "SEARCH_CANCEL":
      await chrome.storage.local.remove("restorePlan");
      return cancelSearch();
    case "SEARCH_CLEAR":
      await chrome.storage.local.remove("restorePlan");
      return clearSearch();
    case "SEARCH_LOCATE": {
      const result = await getSearchResult(String(m.resultId));
      const s = await load();
      if (result.deviceId !== s.deviceId || result.kind !== "current")
        throw Error("只有本机当前快照中的标签可以定位，请使用恢复预览。");
      // Never reconstruct a runtime ID by URL alone. Require an existing current
      // logical identity, then verify the live browser tab immediately before activation.
      const candidates = Object.entries(s.identities.tabs).filter(
        ([, t]) =>
          t.key === result.tabKey &&
          t.windowKey === result.windowKey &&
          t.url === result.url,
      );
      if (candidates.length !== 1)
        throw Error("标签已关闭或身份已变化，请刷新快照或预览恢复。");
      const tabId = Number(candidates[0][0]);
      const tab = await chrome.tabs.get(tabId);
      if (
        tab.incognito ||
        safeUrl(tab.url || tab.pendingUrl, s.settings) !== result.url ||
        s.identities.windows[String(tab.windowId)] !== result.windowKey
      )
        throw Error("标签内容或窗口已变化，未进行定位。请刷新或预览恢复。");
      const latest = await load();
      const identity = latest.identities.tabs[String(tabId)];
      if (
        latest.identities.browserSession !== s.identities.browserSession ||
        identity?.key !== result.tabKey ||
        identity.url !== result.url
      )
        throw Error("标签身份已变化，未进行定位。");
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { tabId, windowId: tab.windowId };
    }
    case "SEARCH_PLAN": {
      const coverage = await searchStatus();
      const source = await getSearchSource(String(m.sourceId));
      if (!source.snapshot) throw Error("快照尚未加载，请先加载搜索范围。");
      const windows = source.snapshot.windows.filter(
        (w) => !m.windowKey || w.windowKey === m.windowKey,
      );
      const tabs = windows
        .flatMap((w) => w.tabs)
        .filter(
          (t) =>
            (!m.tabKey || t.tabKey === m.tabKey) &&
            (!m.groupKey || t.groupKey === m.groupKey),
        );
      if (!tabs.length || (m.tabKey && m.groupKey))
        throw Error("所选标签、组或窗口不在此快照中。");
      const current = await collect();
      const plan = await makePlan(
        source.snapshot,
        current,
        { tabKeys: tabs.map((t) => t.tabKey) },
        false,
        (await load()).settings,
      );
      plan.existingWindows = (
        await chrome.windows.getAll({ windowTypes: ["normal"] })
      ).filter((w) => !w.incognito).length;
      if ((await searchStatus()).generation !== coverage.generation)
        throw Error("搜索范围已变化，请重新选择结果。");
      plan.searchGeneration = coverage.generation;
      await chrome.storage.local.set({ restorePlan: plan });
      return plan;
    }
    case "PLAN_RESTORE": {
      const current = await collect();
      const plan = await makePlan(
        m.snapshot,
        current,
        m.selection,
        m.extraUrlDedup,
        (await load()).settings,
      );
      const ordinary = await chrome.windows.getAll({ windowTypes: ["normal"] });
      plan.existingWindows = ordinary.filter((w) => !w.incognito).length;
      await chrome.storage.local.set({ restorePlan: plan });
      return plan;
    }
    case "START_RESTORE": {
      if (syncing) throw Error("正在发布快照，请稍后开始恢复");
      const { restorePlan } = await chrome.storage.local.get("restorePlan");
      const plan = restorePlan as Plan;
      if (
        !plan ||
        plan.id !== m.planId ||
        Date.now() - Date.parse(plan.createdAt) > 15 * 60_000
      )
        throw Error("恢复预检已过期，请重新预检");
      if (
        plan.searchGeneration !== undefined &&
        plan.searchGeneration !== (await searchStatus()).generation
      )
        throw Error("搜索范围已变化，请重新预检。");
      if (!plan.windows.length) throw Error("没有需要恢复的标签");
      const current = await collect();
      const refreshed = await makePlan(
        plan.snapshot,
        current,
        { tabKeys: plan.windows.flatMap((w) => w.tabs.map((t) => t.tabKey)) },
        false,
        (await load()).settings,
      );
      if ((await hash(refreshed.windows)) !== (await hash(plan.windows)))
        throw Error("本机状态已变化，请重新预检，避免重复导入");
      await chrome.storage.local.remove("restorePlan");
      const op = await prepare(plan);
      void execute().then(() => sync(true));
      return op;
    }
    case "CANCEL_RESTORE":
      await cancel();
      if (!isRestoring()) void sync(true);
      return (await load()).operation;
    case "RESUME_RESTORE": {
      const op = (await load()).operation;
      if (
        !op ||
        op.status !== "INTERRUPTED" ||
        op.uncertain ||
        op.browserSession !== (await load()).identities.browserSession
      )
        throw Error("无法安全继续，请保留当前结果并取消任务后检查。");
      void execute()
        .then(() => sync(true))
        .catch(() => {});
      return op;
    }
    case "UNDO_RESTORE":
      await undo(m.confirmed === true);
      void sync(true);
      return (await load()).operation;
    case "RESET_ID": {
      if (syncing) throw Error("同步正在进行，请稍后重置身份");
      if (!m.confirmed) throw Error("请确认生成新设备 ID");
      if (isRestoring()) throw Error("请先结束恢复");
      await update((s) => {
        s.deviceId = crypto.randomUUID();
        s.sync = {
          dirty: true,
          generation: s.sync.generation + 1,
          revision: 0,
          retryCount: 0,
        };
        s.identities = {
          browserSession: crypto.randomUUID(),
          tabs: {},
          windows: {},
          groups: {},
        };
        s.current = undefined;
      });
      await clearSearch();
      await chrome.storage.local.remove("restorePlan");
      return true;
    }
    default:
      throw Error("未知操作");
  }
}
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(""))
  ) {
    respond({ ok: false, error: "不可信消息来源" });
    return false;
  }
  handle(m)
    .then((data) => respond({ ok: true, data }))
    .catch((e) => respond({ ok: false, error: safeError(e), code: e?.code }));
  return true;
});
for (const event of [
  chrome.tabs.onCreated,
  chrome.tabs.onUpdated,
  chrome.tabs.onRemoved,
  chrome.tabs.onMoved,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabs.onActivated,
  chrome.windows.onCreated,
  chrome.windows.onRemoved,
  chrome.tabGroups.onCreated,
  chrome.tabGroups.onUpdated,
  chrome.tabGroups.onRemoved,
  chrome.tabGroups.onMoved,
])
  event.addListener(() => {
    void mark();
  });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tabrelay-reconcile") void sync();
});
chrome.runtime.onStartup.addListener(() => {
  startupUntil = Date.now() + 10_000;
  void ready.then(() => dirty());
});
chrome.runtime.onInstalled.addListener(() => {
  void mark();
});
void ready.then(() => {
  timer = setTimeout(() => void sync(), 3500);
});
