import type { AppState, Plan } from "./types";
type Source = {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: "current" | "recovery" | "history";
  historyId?: string;
  status: "loaded" | "failed" | "not-loaded";
  error?: string;
  errorCode?: string;
  loadedAt?: string;
  capturedAt?: string;
};
type Coverage = {
  generation: number | string;
  loading: boolean;
  cancelled: boolean;
  includeHistory: boolean;
  sources: Source[];
  devicesTotal: number;
  devicesLoaded: number;
  completed: number;
  total: number;
  truncated: boolean;
  error?: string;
  updatedAt?: string;
  earliestObservedAt?: string;
};
type SearchResult = {
  id: string;
  sourceId: string;
  deviceId: string;
  deviceName: string;
  kind: "current" | "recovery" | "history";
  capturedAt: string;
  windowKey: string;
  tabKey: string;
  title: string;
  url: string;
  domain: string;
  pinned: boolean;
  groupKey?: string;
  groupTitle?: string;
  stale: boolean;
};
type QueryResponse = {
  results: SearchResult[];
  total: number;
  coverage: Coverage;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const target = document.getElementById(id);
  if (!target) throw new Error(`Missing UI element: ${id}`);
  return target as T;
};
const input = (id: string) => $<HTMLInputElement>(id);
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const text = (id: string, value: string) => {
  $(id).textContent = value;
};
const show = (id: string, value: boolean) => {
  $(id).hidden = !value;
};
const busy = (id: string, value: boolean) => {
  $<HTMLButtonElement>(id).disabled = value;
};
const kindName = (kind: string) =>
  kind === "current" ? "当前快照" : kind === "recovery" ? "恢复点" : "历史版本";
let status: Coverage | undefined;
let deviceId = "";
let querySequence = 0;
let statusPending = false;
let refreshKey = "";
let debounce: ReturnType<typeof setTimeout> | undefined;
let plan: Plan | undefined;
let planGeneration: number | string | undefined;
let planning = false;
let starting = false;
let loadRequested = false;
let actionPending = false;
let historyChoiceInitialized = false;
let shownResults: SearchResult[] = [];
async function request<T>(message: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "操作未完成，请重试。");
  return response.data as T;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
function notice(value: string, error = false) {
  text("search-notice", value);
  $("search-notice").classList.toggle("error", error);
  show("search-notice", true);
}
function date(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
function invalidateView(reason?: string) {
  ++querySequence;
  shownResults = [];
  plan = undefined;
  planGeneration = undefined;
  $<HTMLDialogElement>("search-restore-dialog").close();
  text("result-count", "");
  renderEmpty(
    "索引已更新",
    "请以当前已加载范围重新查询。旧结果与恢复预览已失效。",
  );
  if (reason) notice(reason);
}
function renderEmpty(title: string, detail: string) {
  const box = node("div", "search-empty");
  box.append(
    node("span", undefined, "⌕"),
    node("h3", undefined, title),
    node("p", undefined, detail),
  );
  $("search-results").replaceChildren(box);
}
function failureLabel(code?: string): string {
  const labels: Record<string, string> = {
    encryption: "解密失败",
    network: "网络不可达 / 可能离线",
    timeout: "连接超时",
    unauthorized: "认证错误",
    forbidden: "权限错误",
  };
  return code && labels[code] ? labels[code] : "读取失败";
}
function renderCoverage(value: Coverage) {
  const previousGeneration = status?.generation;
  if (
    previousGeneration !== undefined &&
    previousGeneration !== value.generation
  )
    invalidateView("搜索索引已更新，旧结果和恢复预览已清除。");
  status = value;
  if (!historyChoiceInitialized) {
    input("include-history").checked = value.includeHistory;
    historyChoiceInitialized = true;
  }
  const loaded = value.sources.filter((source) => source.status === "loaded");
  const failed = value.sources.filter((source) => source.status === "failed");
  const notLoaded = value.sources.filter(
    (source) => source.status === "not-loaded",
  );
  const label = value.loading
    ? "加载中"
    : value.cancelled
      ? "已停止 · 部分范围"
      : value.truncated
        ? "达到加载上限"
        : value.error
          ? "加载失败 · 范围不完整"
          : failed.length || notLoaded.length
            ? "部分范围"
            : loaded.length
              ? "已加载"
              : "未加载";
  text("coverage-badge", label);
  $("coverage-badge").classList.toggle(
    "complete",
    !value.loading &&
      !value.cancelled &&
      !value.truncated &&
      !value.error &&
      !failed.length &&
      !notLoaded.length &&
      loaded.length > 0,
  );
  $("coverage-badge").classList.toggle(
    "partial",
    Boolean(value.error) ||
      value.cancelled ||
      value.truncated ||
      failed.length > 0 ||
      notLoaded.length > 0,
  );
  text(
    "coverage-summary",
    loaded.length || value.total || value.loading
      ? `已读取 ${value.devicesLoaded}/${value.devicesTotal} 台设备 · ${loaded.length} 个快照已加载 · ${failed.length} 个失败 · ${notLoaded.length} 个来源未加载（可能含数量未知的历史范围）。${value.includeHistory ? "范围包含已保留的恢复点与历史版本。" : "本次范围仅包含当前快照。"}`
      : value.error
        ? "加载未完成，当前没有可搜索的来源。请处理连接错误后重试；不能据此判断远端没有结果。"
        : "尚未读取远端快照。点击加载后，才能判断已加载范围内是否存在结果。",
  );
  busy("load-snapshots", value.loading || loadRequested || actionPending);
  busy("clear-cache", actionPending);
  input("include-history").disabled = value.loading || loadRequested;
  show("cancel-load", value.loading);
  busy("cancel-load", actionPending);
  show("loading-progress", value.loading);
  $("loading-progress-fill").style.width =
    `${value.total ? Math.max(0, Math.min(100, (value.completed / value.total) * 100)) : 0}%`;
  text(
    "coverage-observed",
    value.earliestObservedAt
      ? `最早已加载快照：${date(value.earliestObservedAt)}。这是快照观察时间，不是访问时间。`
      : "快照记录时间不代表网页访问时间。",
  );
  text(
    "coverage-updated",
    value.loading
      ? `加载进度 ${value.completed} / ${value.total}`
      : value.updatedAt
        ? `索引更新 ${date(value.updatedAt)}`
        : "",
  );
  const warnings = [
    value.error,
    value.cancelled ? "加载已停止，尚未加载的范围不会被搜索。" : undefined,
    value.truncated ? "达到安全加载上限，结果不覆盖全部远端快照。" : undefined,
    failed.length ? "部分快照读取失败，可展开下方范围查看原因。" : undefined,
  ].filter(Boolean);
  text("coverage-warning", warnings.join(" "));
  show("coverage-warning", warnings.length > 0);
  const sourceList = $("source-list");
  sourceList.replaceChildren();
  if (!value.sources.length)
    sourceList.append(node("p", "muted", "尚未加载任何来源。"));
  for (const source of value.sources) {
    const row = node("div", "source-row");
    row.dataset.sourceId = source.id;
    row.dataset.status = source.status;
    const stateLabel =
      source.status === "loaded"
        ? "已加载"
        : source.status === "failed"
          ? failureLabel(source.errorCode)
          : "未加载";
    row.append(
      node("span", "source-name", source.deviceName),
      node(
        "span",
        "muted",
        `${kindName(source.kind)}${source.historyId ? ` · ${source.historyId}` : ""}`,
      ),
      node("span", `source-state ${source.status}`, stateLabel),
    );
    if (source.capturedAt) {
      row.append(node("span", "muted", date(source.capturedAt)));
      if (
        source.kind === "current" &&
        Date.now() - Date.parse(source.capturedAt) > 5 * 60_000
      ) {
        row.append(
          node("span", "result-tag stale", "快照可能过时 · 已超过 5 分钟"),
        );
      }
    }
    if (source.error) row.append(node("span", "source-error", source.error));
    sourceList.append(row);
  }
  const deviceFilter = $<HTMLSelectElement>("filter-device");
  const selected = deviceFilter.value;
  const deviceMap = new Map(
    value.sources.map((source) => [source.deviceId, source.deviceName]),
  );
  deviceFilter.replaceChildren(new Option("全部已加载设备", ""));
  for (const [id, name] of deviceMap) deviceFilter.append(new Option(name, id));
  if (deviceMap.has(selected)) deviceFilter.value = selected;
  const key = JSON.stringify([
    value.generation,
    value.completed,
    value.loading,
    loaded.length,
    failed.length,
    value.updatedAt,
  ]);
  if (refreshKey !== key) {
    refreshKey = key;
    if (loaded.length) void runQuery();
    else if (!value.loading) {
      shownResults = [];
      text("result-count", "");
      renderEmpty(
        "还没有可搜索的快照",
        "先点击上方“加载设备快照”。未加载、失败和取消的范围不计入搜索。",
      );
    }
  }
}
async function refreshStatus() {
  if (statusPending) return;
  statusPending = true;
  try {
    renderCoverage(await request<Coverage>({ type: "SEARCH_STATUS" }));
  } catch (error) {
    notice(message(error), true);
  } finally {
    statusPending = false;
  }
}
function getFilters(): Record<string, unknown> {
  const after = input("filter-after").value;
  const before = input("filter-before").value;
  if (after && before && after > before)
    throw new Error("起始日期不能晚于结束日期。");
  const filters: Record<string, unknown> = {};
  for (const [id, key] of [
    ["filter-device", "deviceId"],
    ["filter-domain", "domain"],
    ["filter-kind", "kind"],
    ["filter-group", "group"],
  ]) {
    const value = $<HTMLInputElement | HTMLSelectElement>(id).value.trim();
    if (value) filters[key] = value;
  }
  if (input("filter-pinned").checked) filters.pinned = true;
  if (after) filters.after = new Date(`${after}T00:00:00`).toISOString();
  if (before) filters.before = new Date(`${before}T23:59:59.999`).toISOString();
  return filters;
}
function highlight(target: HTMLElement, value: string, query: string) {
  // Match the index's NFKC/case normalization while mapping highlights back to
  // original text. Untrusted strings only ever become text nodes or <mark> text.
  const terms = [
    ...new Set(
      query
        .normalize("NFKC")
        .toLocaleLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);
  if (!terms.length) {
    target.textContent = value;
    return;
  }
  let normalized = "";
  let rawOffset = 0;
  const positions: { start: number; end: number }[] = [];
  for (const character of value) {
    const part = character.normalize("NFKC").toLocaleLowerCase();
    normalized += part;
    for (let i = 0; i < part.length; i++)
      positions.push({ start: rawOffset, end: rawOffset + character.length });
    rawOffset += character.length;
  }
  const expression = new RegExp(
    terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gu",
  );
  const ranges: { start: number; end: number }[] = [];
  for (const match of normalized.matchAll(expression)) {
    const index = match.index ?? 0;
    const first = positions[index];
    const last = positions[index + match[0].length - 1];
    if (!first || !last) continue;
    const prior = ranges[ranges.length - 1];
    if (prior && first.start <= prior.end)
      prior.end = Math.max(prior.end, last.end);
    else ranges.push({ start: first.start, end: last.end });
  }
  let offset = 0;
  for (const range of ranges) {
    target.append(
      document.createTextNode(value.slice(offset, range.start)),
      node("mark", undefined, value.slice(range.start, range.end)),
    );
    offset = range.end;
  }
  target.append(document.createTextNode(value.slice(offset)));
}
async function runQuery() {
  const sequence = ++querySequence;
  if (!status?.sources.some((source) => source.status === "loaded")) {
    text("result-count", "");
    renderEmpty(
      "当前还没有可搜索的快照",
      status?.loading
        ? "快照正在加载。已完成的来源会逐步加入搜索范围。"
        : "点击“加载设备快照”后再搜索；未加载不代表远端没有结果。",
    );
    return;
  }
  const generation = status.generation;
  const query = input("search-query").value;
  const limit = Number($<HTMLSelectElement>("result-limit").value);
  try {
    const filters = getFilters();
    $("search-results").classList.add("search-busy");
    const response = await request<QueryResponse>({
      type: "SEARCH_QUERY",
      query,
      filters,
      limit,
    });
    if (
      sequence !== querySequence ||
      generation !== status?.generation ||
      response.coverage.generation !== generation
    )
      return;
    shownResults = response.results;
    renderResults(response, query);
  } catch (error) {
    if (sequence === querySequence) {
      shownResults = [];
      text("result-count", "");
      renderEmpty("搜索未完成", message(error));
      notice(message(error), true);
    }
  } finally {
    if (sequence === querySequence)
      $("search-results").classList.remove("search-busy");
  }
}
function scheduleQuery() {
  clearTimeout(debounce);
  ++querySequence;
  debounce = setTimeout(() => {
    void runQuery();
  }, 180);
}
function renderResults(response: QueryResponse, query: string) {
  const loaded = response.coverage.sources.filter(
    (source) => source.status === "loaded",
  ).length;
  text(
    "result-count",
    `显示 ${response.results.length} / ${response.total} 条`,
  );
  text(
    "result-explanation",
    `在 ${loaded} 个已加载快照中匹配。${response.total > response.results.length ? "已先应用全部筛选，再截取显示数量。" : ""}${response.coverage.loading || response.coverage.cancelled || response.coverage.truncated || response.coverage.sources.some((source) => source.status !== "loaded") ? "当前覆盖范围不完整；没有结果不代表其他快照不存在匹配。" : "此结果只反映已加载的快照内容，不代表设备的实时标签状态。"}`,
  );
  const list = $("search-results");
  list.replaceChildren();
  if (!response.results.length) {
    renderEmpty(
      "已加载范围内暂无匹配",
      "可以调整关键词或筛选。未加载、失败及加载上限之外的快照不在本次搜索范围内。",
    );
    return;
  }
  for (const result of response.results) {
    const card = node("article", "search-result");
    card.dataset.resultId = result.id;
    card.dataset.sourceId = result.sourceId;
    card.dataset.tabKey = result.tabKey;
    card.dataset.windowKey = result.windowKey;
    const heading = node("div", "result-heading");
    const icon = node(
      "span",
      "result-site-icon",
      result.domain.slice(0, 1).toUpperCase() || "↗",
    );
    icon.setAttribute("aria-hidden", "true");
    const content = node("div", "result-text");
    const title = node("h3", "result-title");
    highlight(title, result.title || result.url, query);
    const url = node("p", "result-url");
    highlight(url, result.url, query);
    content.append(title, url);
    heading.append(icon, content);
    card.append(heading);
    const meta = node("div", "result-meta");
    meta.append(
      node("span", "result-tag", result.deviceName),
      node(
        "span",
        `result-tag ${result.kind !== "current" ? "history" : ""}`,
        kindName(result.kind),
      ),
    );
    const domain = node("span", "result-tag");
    highlight(domain, result.domain, query);
    meta.append(domain);
    if (result.pinned) meta.append(node("span", "result-tag", "置顶"));
    if (result.groupKey) {
      const group = node("span", "result-tag");
      highlight(group, `组：${result.groupTitle || "未命名"}`, query);
      meta.append(group);
    }
    if (result.stale)
      meta.append(node("span", "result-tag stale", "可能过时 · 恢复前重检"));
    card.append(meta);
    const provenance = node(
      "p",
      "result-observation",
      `观察于 ${date(result.capturedAt)} · 来源窗口 ${result.windowKey} · 标签 ${result.tabKey}`,
    );
    provenance.title = `来源快照 ${result.sourceId}`;
    card.append(provenance);
    const actions = node("div", "result-actions");
    if (result.deviceId === deviceId && result.kind === "current") {
      const locate = node("button", "locate", "定位本机标签");
      locate.dataset.action = "locate";
      locate.addEventListener("click", () => {
        void locateResult(result, locate);
      });
      actions.append(locate);
    }
    for (const [scope, label] of [
      ["tab", "恢复此标签"],
      ["group", "恢复此标签组"],
      ["window", "恢复此窗口"],
    ] as const) {
      if (scope === "group" && !result.groupKey) continue;
      const button = node("button", undefined, label);
      button.dataset.action = `restore-${scope}`;
      button.addEventListener("click", () => {
        void previewResult(result, scope);
      });
      actions.append(button);
    }
    card.append(actions);
    list.append(card);
  }
}
async function locateResult(result: SearchResult, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    await request({ type: "SEARCH_LOCATE", resultId: result.id });
    notice("已定位并激活经过核实的本机标签。");
  } catch (error) {
    notice(
      `${message(error)} 可使用恢复按钮，经预检确认后追加到新窗口。`,
      true,
    );
  } finally {
    button.disabled = false;
  }
}
function disableResultActions(value: boolean) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".result-actions button",
  ))
    button.disabled = value;
}
async function previewResult(
  result: SearchResult,
  scope: "tab" | "group" | "window",
) {
  if (planning || starting || !status) return;
  planning = true;
  disableResultActions(true);
  const generation = status.generation;
  try {
    const response = await request<Plan>({
      type: "SEARCH_PLAN",
      sourceId: result.sourceId,
      windowKey: result.windowKey,
      ...(scope === "tab"
        ? { tabKey: result.tabKey }
        : scope === "group"
          ? { groupKey: result.groupKey }
          : {}),
    });
    if (status?.generation !== generation)
      throw new Error("索引已变化，请重新搜索后预览恢复。");
    plan = response;
    planGeneration = generation;
    text(
      "search-plan-source",
      `${result.deviceName} · ${kindName(result.kind)} · 快照版本 ${response.snapshot.revision}`,
    );
    text(
      "search-plan-time",
      `固定快照时间：${date(response.snapshot.capturedAt)}。这是快照观察时间，不是访问时间。`,
    );
    const stats = $("search-plan-stats");
    stats.replaceChildren();
    const tabs = response.windows.reduce(
      (sum, window) => sum + window.tabs.length,
      0,
    );
    const groups = response.windows.reduce(
      (sum, window) => sum + window.groups.length,
      0,
    );
    for (const [value, label] of [
      [response.windows.length, "新增窗口"],
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
      "search-plan-existing",
      `本机已有 ${response.existingWindows} 个窗口将保持不变。`,
    );
    const skipped = $("search-plan-skipped");
    skipped.replaceChildren();
    if (response.skipped.length) {
      skipped.append(
        node("strong", undefined, `跳过 ${response.skipped.length} 项`),
      );
      for (const item of response.skipped.slice(0, 20))
        skipped.append(
          node("p", undefined, `${item.title || "未命名标签"}：${item.reason}`),
        );
      if (response.skipped.length > 20)
        skipped.append(node("p", undefined, "仅展示前 20 项。"));
    }
    busy("search-confirm-restore", tabs === 0);
    $<HTMLDialogElement>("search-restore-dialog").showModal();
  } catch (error) {
    notice(message(error), true);
  } finally {
    planning = false;
    disableResultActions(false);
  }
}
async function startRestore() {
  if (!plan || starting) return;
  if (status?.generation !== planGeneration) {
    notice("索引已变化，请重新预览后恢复。", true);
    $<HTMLDialogElement>("search-restore-dialog").close();
    return;
  }
  starting = true;
  busy("search-confirm-restore", true);
  try {
    await request({ type: "START_RESTORE", planId: plan.id });
    $<HTMLDialogElement>("search-restore-dialog").close();
    plan = undefined;
    notice(
      "恢复任务已开始。原有窗口不会关闭；请在工作区侧边栏查看进度、取消或同步结果。",
    );
  } catch (error) {
    notice(message(error), true);
  } finally {
    starting = false;
    busy("search-confirm-restore", false);
  }
}
async function loadSnapshots() {
  if (loadRequested || status?.loading) return;
  loadRequested = true;
  busy("load-snapshots", true);
  input("include-history").disabled = true;
  notice("正在按所选范围加载快照。只有已成功加载的来源会进入搜索结果。");
  try {
    await request({
      type: "SEARCH_LOAD",
      includeHistory: input("include-history").checked,
    });
  } catch (error) {
    notice(message(error), true);
  } finally {
    loadRequested = false;
    await refreshStatus();
    busy("load-snapshots", Boolean(status?.loading));
    input("include-history").disabled = Boolean(status?.loading);
  }
}
async function cacheAction(type: "SEARCH_CANCEL" | "SEARCH_CLEAR") {
  if (actionPending) return;
  actionPending = true;
  busy("clear-cache", true);
  busy("cancel-load", true);
  try {
    await request({ type });
    if (type === "SEARCH_CLEAR")
      invalidateView("搜索索引已清空。远端快照和浏览器标签没有被删除。");
    else notice("已请求停止加载，已加载的部分仍可搜索。");
    await refreshStatus();
  } catch (error) {
    notice(message(error), true);
  } finally {
    actionPending = false;
    busy("clear-cache", false);
    busy("cancel-load", false);
    busy("load-snapshots", Boolean(status?.loading) || loadRequested);
  }
}
$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(debounce);
  void runQuery();
});
input("search-query").addEventListener("input", scheduleQuery);
for (const id of ["filter-domain", "filter-group"])
  input(id).addEventListener("input", scheduleQuery);
for (const id of [
  "filter-device",
  "filter-kind",
  "filter-pinned",
  "filter-after",
  "filter-before",
  "result-limit",
])
  $(id).addEventListener("change", () => {
    void runQuery();
  });
$("reset-filters").addEventListener("click", () => {
  for (const id of [
    "filter-device",
    "filter-kind",
    "filter-domain",
    "filter-group",
    "filter-after",
    "filter-before",
  ])
    $<HTMLInputElement | HTMLSelectElement>(id).value = "";
  input("filter-pinned").checked = false;
  $<HTMLSelectElement>("result-limit").value = "100";
  void runQuery();
});
$("load-snapshots").addEventListener("click", () => {
  void loadSnapshots();
});
$("cancel-load").addEventListener("click", () => {
  void cacheAction("SEARCH_CANCEL");
});
$("clear-cache").addEventListener("click", () => {
  void cacheAction("SEARCH_CLEAR");
});
for (const id of ["search-restore-close", "search-restore-back"])
  $(id).addEventListener("click", () => {
    $<HTMLDialogElement>("search-restore-dialog").close();
    plan = undefined;
  });
$("search-confirm-restore").addEventListener("click", () => {
  void startRestore();
});
$<HTMLDialogElement>("search-restore-dialog").addEventListener("cancel", () => {
  plan = undefined;
});
void request<AppState>({ type: "GET_STATE" })
  .then((state) => {
    deviceId = state.deviceId;
    if (shownResults.length) void runQuery();
  })
  .catch((error) => notice(message(error), true));
void refreshStatus();
setInterval(() => {
  if (document.visibilityState === "visible") void refreshStatus();
}, 1500);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshStatus();
});
