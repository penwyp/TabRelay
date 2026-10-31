import type {
  AppState,
  Device,
  Plan,
  RestoreOperation,
  Snapshot,
  Tab,
  WorkspaceWindow,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};
const input = (id: string) => $<HTMLInputElement>(id);
const dialog = (id: string) => $<HTMLDialogElement>(id);
const show = (id: string, visible: boolean) => {
  $(id).hidden = !visible;
};
const text = (id: string, value: string) => {
  $(id).textContent = value;
};
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string,
) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
};
let state: AppState | undefined;
let devices: Device[] = [];
let selectedDevice: Device | undefined;
let snapshot: Snapshot | undefined;
let plan: Plan | undefined;
let selectedTabs = new Set<string>();
let loadSequence = 0;
let polling = false;
let planning = false;
let starting = false;
let deviceLoadSequence = 0;
let confirmResolver: ((value: boolean) => void) | undefined;

async function request<T>(message: Record<string, unknown>): Promise<T> {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.ok !== true)
    throw new Error(result?.error || "操作未完成，请稍后重试。");
  return result.data as T;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
function notice(message: string, error = false) {
  text("notice", message);
  $("notice").classList.toggle("error", error);
  show("notice", true);
}
function date(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚未同步";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
function totalTabs(value: Snapshot | undefined): number {
  return (
    value?.windows.reduce((sum, window) => sum + window.tabs.length, 0) ?? 0
  );
}
function readableHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "不可恢复的地址";
  }
}
function setBusy(id: string, busy: boolean) {
  $<HTMLButtonElement>(id).disabled = busy;
}
function activeOperation(operation?: RestoreOperation): boolean {
  return operation?.status === "RUNNING" || operation?.status === "PREPARED";
}

function renderState(value: AppState) {
  const endpointChanged = Boolean(
    state && state.settings.endpoint !== value.settings.endpoint,
  );
  state = value;
  if (endpointChanged) {
    ++loadSequence;
    ++deviceLoadSequence;
    selectedDevice = undefined;
    snapshot = undefined;
    plan = undefined;
    devices = [];
    selectedTabs.clear();
    show("snapshot-section", false);
    renderDevices();
    if (value.settings.endpoint) void refreshDevices(true);
  }
  text("local-name", value.settings.deviceName || "当前设备");
  text(
    "local-count",
    `${value.current?.windows.length ?? 0} 个窗口 · ${totalTabs(value.current)} 个标签 · 本机`,
  );
  const sync = value.sync;
  const status = sync.pausedConflict
    ? "设备冲突"
    : sync.error
      ? "同步异常"
      : !value.settings.enabled
        ? "已暂停"
        : sync.dirty || sync.pending
          ? "待同步"
          : sync.lastSuccess
            ? "已同步"
            : "待配置";
  text("sync-pill", status);
  $("sync-pill").classList.toggle(
    "error",
    Boolean(sync.error || sync.pausedConflict),
  );
  $("sync-pill").classList.toggle(
    "pending",
    !sync.error && (sync.dirty || !value.settings.enabled),
  );
  text(
    "sync-time",
    sync.lastSuccess ? `最后同步 ${date(sync.lastSuccess)}` : "尚未成功同步",
  );
  text("sync-error", sync.error || "");
  show("sync-error", Boolean(sync.error));
  show("reset-id", Boolean(sync.pausedConflict));
  show("onboarding", !value.settings.endpoint);
  show("workspace", Boolean(value.settings.endpoint));
  setBusy("sync-now", !value.settings.endpoint || Boolean(sync.pausedConflict));
  renderOperation(value.operation);
  updateSelection();
}
function renderOperation(operation?: RestoreOperation) {
  show("operation-card", Boolean(operation));
  if (!operation) return;
  const statuses: Record<RestoreOperation["status"], string> = {
    PREPARED: "等待开始",
    RUNNING: "正在恢复",
    INTERRUPTED: "等待继续",
    CANCELLED: "已停止",
    COMPLETED: "恢复完成",
    ROLLED_BACK: "已撤销",
  };
  const total = operation.plan.windows.reduce(
    (sum, window) => sum + window.tabs.length,
    0,
  );
  const processed = operation.createdTabs.length + operation.failures.length;
  const completion = total
    ? Math.min(100, Math.round((processed / total) * 100))
    : 100;
  text("operation-title", statuses[operation.status]);
  text(
    "operation-status",
    operation.syncStatus === "synced" ? "合并结果已同步" : "远端待同步",
  );
  $("operation-status").classList.toggle(
    "pending",
    operation.syncStatus !== "synced",
  );
  $("operation-progress").style.width = `${completion}%`;
  text(
    "operation-detail",
    `新增 ${operation.createdWindows.length} 个窗口 · 已创建 ${operation.createdTabs.length}/${total} 个标签${operation.failures.length ? ` · 失败 ${operation.failures.length} 项` : ""}。${operation.status === "CANCELLED" ? "已创建窗口保留。" : operation.status === "COMPLETED" && operation.syncStatus !== "synced" ? "本机已恢复，正在等待远端同步。" : ""}`,
  );
  const failures = operation.failures
    .slice(0, 3)
    .map((item) => item.reason)
    .join("；");
  const uncertainty =
    operation.status === "INTERRUPTED" && operation.uncertain
      ? "上一次创建结果无法可靠确认。为避免重复创建，不能自动继续；请保留当前窗口，并停止本次任务。"
      : "";
  text(
    "operation-error",
    [uncertainty, operation.error, failures].filter(Boolean).join("；"),
  );
  show("operation-error", Boolean(uncertainty || operation.error || failures));
  show(
    "cancel-restore",
    activeOperation(operation) || operation.status === "INTERRUPTED",
  );
  show(
    "resume-restore",
    operation.status === "INTERRUPTED" && !operation.uncertain,
  );
  show(
    "undo-restore",
    !activeOperation(operation) &&
      operation.status !== "ROLLED_BACK" &&
      operation.createdWindows.length > 0,
  );
}
async function refreshState() {
  if (polling) return;
  polling = true;
  try {
    renderState(await request<AppState>({ type: "GET_STATE" }));
  } catch (error) {
    notice(errorMessage(error), true);
  } finally {
    polling = false;
  }
}
function renderDevices() {
  const list = $("device-list");
  list.replaceChildren();
  text("device-count", String(devices.length));
  show("empty-devices", devices.length === 0);
  for (const device of devices) {
    const button = node(
      "button",
      `device-card${device.deviceId === selectedDevice?.deviceId ? " selected" : ""}`,
    );
    button.type = "button";
    button.dataset.deviceId = device.deviceId;
    button.setAttribute(
      "aria-pressed",
      String(device.deviceId === selectedDevice?.deviceId),
    );
    const icon = node(
      "span",
      "device-symbol",
      device.deviceId === state?.deviceId ? "▰" : "▱",
    );
    icon.setAttribute("aria-hidden", "true");
    const content = node("span", "grow");
    content.append(
      node(
        "span",
        "name",
        `${device.name}${device.deviceId === state?.deviceId ? " · 本机" : ""}`,
      ),
      node(
        "span",
        "detail",
        `${device.windows} 个窗口 · ${device.tabs} 个标签`,
      ),
      node("span", "detail", date(device.updatedAt)),
    );
    const chevron = node("span", "chevron", "›");
    chevron.setAttribute("aria-hidden", "true");
    button.append(icon, content, chevron);
    button.addEventListener("click", () => {
      void chooseDevice(device);
    });
    list.append(button);
  }
}
async function refreshDevices(selectDefault = false) {
  if (!state?.settings.endpoint) return;
  const sequence = ++deviceLoadSequence;
  setBusy("refresh", true);
  try {
    const result = await request<Device[]>({ type: "LIST_DEVICES" });
    if (sequence !== deviceLoadSequence) return;
    devices = result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    renderDevices();
    if (selectDefault && !selectedDevice && devices.length)
      await chooseDevice(
        devices.find((device) => device.deviceId !== state?.deviceId) ||
          devices[0],
      );
  } catch (error) {
    if (sequence === deviceLoadSequence) notice(errorMessage(error), true);
  } finally {
    if (sequence === deviceLoadSequence) setBusy("refresh", false);
  }
}
async function chooseDevice(device: Device) {
  selectedDevice = device;
  snapshot = undefined;
  selectedTabs.clear();
  renderDevices();
  text("snapshot-name", device.name);
  show("snapshot-section", true);
  $("window-list").replaceChildren(node("p", "muted", "正在读取快照…"));
  const select = $<HTMLSelectElement>("snapshot-kind");
  select.replaceChildren(
    new Option("最新快照", "current"),
    new Option("最近有效恢复点", "recovery"),
  );
  select.value = "current";
  updateSelection();
  const target = device.deviceId;
  await loadSnapshot();
  try {
    const histories = await request<string[]>({
      type: "LIST_HISTORY",
      deviceId: target,
    });
    if (selectedDevice?.deviceId !== target) return;
    for (const history of histories)
      select.append(
        new Option(
          `历史 · ${history.replace(/\.json$/, "")}`,
          `history:${history}`,
        ),
      );
  } catch (error) {
    if (selectedDevice?.deviceId === target)
      notice(`历史记录暂不可用：${errorMessage(error)}`, true);
  }
}
async function loadSnapshot() {
  if (!selectedDevice) return;
  const sequence = ++loadSequence;
  const kindValue = $<HTMLSelectElement>("snapshot-kind").value;
  const kind = kindValue.startsWith("history:") ? "history" : kindValue;
  snapshot = undefined;
  plan = undefined;
  selectedTabs.clear();
  updateSelection();
  text("snapshot-time", "正在读取…");
  text("snapshot-revision", "");
  $("window-list").replaceChildren();
  try {
    const result = await request<Snapshot>({
      type: "GET_SNAPSHOT",
      deviceId: selectedDevice.deviceId,
      kind,
      historyId: kind === "history" ? kindValue.slice(8) : undefined,
    });
    if (sequence !== loadSequence) return;
    snapshot = result;
    selectedTabs = new Set(
      result.windows.flatMap((window) => window.tabs.map((tab) => tab.tabKey)),
    );
    text("snapshot-time", `快照时间 ${date(result.capturedAt)}`);
    text(
      "snapshot-revision",
      `版本 ${result.revision} · ${result.windows.length} 窗口`,
    );
    renderWindows();
    updateSelection();
  } catch (error) {
    if (sequence !== loadSequence) return;
    text("snapshot-time", "读取失败");
    $("window-list").replaceChildren(node("p", "empty", errorMessage(error)));
    notice(errorMessage(error), true);
  }
}
const colors: Record<string, string> = {
  grey: "#8c95a5",
  blue: "#4385e7",
  red: "#df6867",
  yellow: "#d6ab31",
  green: "#5f9f72",
  pink: "#cf80ab",
  purple: "#9c79ce",
  cyan: "#4dabb3",
  orange: "#e49a54",
};
function checkboxFor(tabs: Tab[], description: string): HTMLInputElement {
  const checkbox = node("input");
  checkbox.type = "checkbox";
  checkbox.setAttribute("aria-label", description);
  checkbox.dataset.tabs = JSON.stringify(tabs.map((tab) => tab.tabKey));
  checkbox.checked =
    tabs.length > 0 && tabs.every((tab) => selectedTabs.has(tab.tabKey));
  checkbox.indeterminate =
    tabs.some((tab) => selectedTabs.has(tab.tabKey)) && !checkbox.checked;
  checkbox.addEventListener("change", () => {
    for (const tab of tabs) {
      if (checkbox.checked) selectedTabs.add(tab.tabKey);
      else selectedTabs.delete(tab.tabKey);
    }
    updateSelection();
  });
  return checkbox;
}
function tabRow(tab: Tab): HTMLElement {
  const row = node("label", "tab-row");
  const checkbox = checkboxFor([tab], `选择标签 ${tab.title || tab.url}`);
  checkbox.dataset.tabKey = tab.tabKey;
  const host = readableHost(tab.url);
  const icon = node("span", "tab-icon", host.slice(0, 1).toUpperCase());
  icon.setAttribute("aria-hidden", "true");
  const info = node("span", "tab-info");
  const title = node("span", "tab-title", tab.title || host);
  title.title = tab.title || tab.url;
  const url = node("span", "tab-url", tab.url);
  url.title = tab.url;
  info.append(title, url);
  row.append(checkbox, icon, info);
  if (tab.pinned) row.append(node("span", "pin", "置顶"));
  return row;
}
function renderWindows() {
  const list = $("window-list");
  list.replaceChildren();
  if (!snapshot?.windows.length) {
    list.append(
      node(
        "div",
        "empty",
        "这个快照是空工作区。可以切换到最近有效恢复点或历史快照。",
      ),
    );
    return;
  }
  for (const [index, window] of snapshot.windows.entries()) {
    const card = node("section", "window-card");
    card.dataset.windowKey = window.windowKey;
    const heading = node("div", "window-heading");
    const label = node("label");
    label.append(
      checkboxFor(window.tabs, `选择窗口 ${index + 1}`),
      document.createTextNode(`窗口 ${index + 1}`),
    );
    heading.append(
      label,
      node("span", "muted", `${window.tabs.length} 个标签`),
    );
    card.append(heading);
    appendWindowTabs(card, window);
    list.append(card);
  }
}
function appendWindowTabs(card: HTMLElement, window: WorkspaceWindow) {
  const renderedGroups = new Set<string>();
  for (const tab of window.tabs) {
    const group = window.groups.find((item) => item.groupKey === tab.groupKey);
    if (!group) {
      card.append(tabRow(tab));
      continue;
    }
    if (renderedGroups.has(group.groupKey)) continue;
    renderedGroups.add(group.groupKey);
    const members = window.tabs.filter(
      (item) => item.groupKey === group.groupKey,
    );
    const container = node("section", "tab-group");
    const heading = node("label", "group-heading");
    const dot = node("span", "group-dot");
    dot.style.backgroundColor = colors[group.color] || colors.grey;
    heading.append(
      checkboxFor(members, `选择标签组 ${group.title || "未命名组"}`),
      dot,
      document.createTextNode(
        `${group.title || "未命名组"} · ${members.length}${group.collapsed ? " · 已折叠" : ""}`,
      ),
    );
    container.append(heading);
    for (const member of members) container.append(tabRow(member));
    card.append(container);
  }
}
function updateSelection() {
  const total = totalTabs(snapshot);
  text("selection-count", `已选 ${selectedTabs.size} / ${total} 个标签`);
  input("select-all").checked = total > 0 && selectedTabs.size === total;
  input("select-all").indeterminate =
    selectedTabs.size > 0 && selectedTabs.size < total;
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    "#window-list input[data-tabs]",
  )) {
    const keys: string[] = JSON.parse(checkbox.dataset.tabs || "[]");
    checkbox.checked =
      keys.length > 0 && keys.every((key) => selectedTabs.has(key));
    checkbox.indeterminate =
      keys.some((key) => selectedTabs.has(key)) && !checkbox.checked;
  }
  setBusy(
    "preview-restore",
    !snapshot ||
      selectedTabs.size === 0 ||
      planning ||
      starting ||
      activeOperation(state?.operation),
  );
}
function openSettings() {
  void chrome.runtime
    .openOptionsPage()
    .catch((error: unknown) => notice(errorMessage(error), true));
}
async function previewRestore() {
  if (!snapshot || planning) return;
  planning = true;
  updateSelection();
  try {
    plan = await request<Plan>({
      type: "PLAN_RESTORE",
      snapshot,
      selection: { tabKeys: [...selectedTabs] },
      extraUrlDedup: input("extra-dedup").checked,
    });
    const tabs = plan.windows.reduce(
      (sum, window) => sum + window.tabs.length,
      0,
    );
    const groups = plan.windows.reduce(
      (sum, window) => sum + window.groups.length,
      0,
    );
    text(
      "plan-source",
      `${selectedDevice?.name || "来源设备"} · 快照版本 ${plan.snapshot.revision}`,
    );
    const stats = $("plan-stats");
    stats.replaceChildren();
    for (const [value, label] of [
      [plan.windows.length, "新增窗口"],
      [tabs, "安全标签"],
      [groups, "标签组"],
    ] as const) {
      const item = node("div", "plan-stat");
      item.append(
        node("strong", undefined, String(value)),
        node("span", undefined, label),
      );
      stats.append(item);
    }
    text(
      "plan-existing",
      `本机已有 ${plan.existingWindows} 个窗口将保持不变。`,
    );
    const skipped = $("plan-skipped");
    skipped.replaceChildren();
    if (plan.skipped.length) {
      skipped.append(
        node("strong", undefined, `跳过 ${plan.skipped.length} 项`),
      );
      for (const item of plan.skipped.slice(0, 20))
        skipped.append(
          node("p", undefined, `${item.title || "未命名标签"}：${item.reason}`),
        );
      if (plan.skipped.length > 20)
        skipped.append(node("p", undefined, "仅展示前 20 项。"));
    }
    setBusy("confirm-restore", tabs === 0);
    dialog("restore-dialog").showModal();
  } catch (error) {
    notice(errorMessage(error), true);
  } finally {
    planning = false;
    updateSelection();
  }
}
async function startRestore() {
  if (!plan || starting) return;
  starting = true;
  setBusy("confirm-restore", true);
  updateSelection();
  try {
    await request({ type: "START_RESTORE", planId: plan.id });
    dialog("restore-dialog").close();
    notice("恢复任务已开始。原有窗口不会被关闭。");
    await refreshState();
  } catch (error) {
    notice(errorMessage(error), true);
  } finally {
    starting = false;
    setBusy("confirm-restore", false);
    updateSelection();
  }
}
function confirmAction(title: string, description: string): Promise<boolean> {
  if (confirmResolver) confirmResolver(false);
  text("confirm-title", title);
  text("confirm-description", description);
  dialog("confirm-dialog").showModal();
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}
function resolveConfirmation(value: boolean) {
  confirmResolver?.(value);
  confirmResolver = undefined;
  dialog("confirm-dialog").close();
}
async function operationAction(type: string) {
  try {
    if (
      type === "UNDO_RESTORE" &&
      !(await confirmAction(
        "撤销本次恢复？",
        "仅关闭可核实仍归本次任务管理的新增窗口。若标签已被修改或移入其他内容，撤销会安全拒绝；本机原有窗口不受影响。",
      ))
    )
      return;
    if (
      type === "RESET_ID" &&
      !(await confirmAction(
        "重新生成设备 ID？",
        "本机将作为新的设备发布。原远端设备文件保留；请先确认没有其他实例仍使用本机身份。",
      ))
    )
      return;
    await request({ type, confirmed: true });
    await refreshState();
    notice(
      type === "UNDO_RESTORE"
        ? "撤销操作已完成。原有窗口保持不变。"
        : type === "CANCEL_RESTORE"
          ? "已请求停止后续创建，已创建窗口保留。"
          : type === "RESET_ID"
            ? "已生成新的设备身份。"
            : "已请求继续恢复。",
    );
  } catch (error) {
    notice(errorMessage(error), true);
  }
}

$("settings-open").addEventListener("click", openSettings);
$("onboarding-setup").addEventListener("click", openSettings);
$("refresh").addEventListener("click", () => {
  void refreshState().then(() => refreshDevices(true));
});
$("sync-now").addEventListener("click", async () => {
  setBusy("sync-now", true);
  try {
    await request({ type: "SYNC_NOW" });
    await refreshState();
    await refreshDevices();
    notice("同步请求已完成，请查看本机同步状态。");
  } catch (error) {
    notice(errorMessage(error), true);
  } finally {
    setBusy("sync-now", false);
  }
});
$("snapshot-kind").addEventListener("change", () => {
  void loadSnapshot();
});
$("select-all").addEventListener("change", () => {
  selectedTabs = input("select-all").checked
    ? new Set(
        snapshot?.windows.flatMap((window) =>
          window.tabs.map((tab) => tab.tabKey),
        ) || [],
      )
    : new Set();
  updateSelection();
});
$("preview-restore").addEventListener("click", () => {
  void previewRestore();
});
$("confirm-restore").addEventListener("click", () => {
  void startRestore();
});
for (const id of ["restore-close", "restore-back"])
  $(id).addEventListener("click", () => dialog("restore-dialog").close());
$("cancel-restore").addEventListener("click", () => {
  void operationAction("CANCEL_RESTORE");
});
$("resume-restore").addEventListener("click", () => {
  void operationAction("RESUME_RESTORE");
});
$("undo-restore").addEventListener("click", () => {
  void operationAction("UNDO_RESTORE");
});
$("reset-id").addEventListener("click", () => {
  void operationAction("RESET_ID");
});
$("confirm-no").addEventListener("click", () => resolveConfirmation(false));
$("confirm-yes").addEventListener("click", () => resolveConfirmation(true));
dialog("confirm-dialog").addEventListener("cancel", () => {
  confirmResolver?.(false);
  confirmResolver = undefined;
});
void refreshState().then(() => refreshDevices(true));
setInterval(() => {
  if (document.visibilityState === "visible") void refreshState();
}, 2000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshState();
});

$("search-open").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("search.html") });
});
