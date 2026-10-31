import type {
  AppState,
  Plan,
  Device,
  RestoreOperation,
  Snapshot,
} from "./types";
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
  stale?: boolean;
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
  paused?: boolean;
  bodyLoaded?: number;
  bodyMissing?: number;
  bodyTruncated?: number;
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
  occurrences?: SearchResult[];
  bodySnippet?: string;
  contentStatus?: string;
  contentReason?: string;
};
type QueryResponse = {
  results: SearchResult[];
  total: number;
  occurrenceTotal?: number;
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
let automaticPending = false;
let statePending = false;
let actionEpoch = 0;
let contentCaptureSummary = "";
let localState: AppState | undefined;
const occurrenceSelections = new Map<string, string>();
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
  $("search-notice").dataset.kind = error ? "error" : "action";
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
  occurrenceSelections.clear();
  plan = undefined;
  planGeneration = undefined;
  $<HTMLDialogElement>("search-restore-dialog").close();
  text("result-count", "");
  renderEmpty(
    "索引已更新",
    "请以当前已加载范围重新查询。旧结果与恢复预览已失效。",
  );
  if (reason) {
    notice(reason);
    $("search-notice").dataset.kind =
      reason === "搜索索引已更新，旧结果和恢复预览已清除。"
        ? "index-update"
        : "action";
  }
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
  if (
    typeof status?.generation === "number" &&
    typeof value.generation === "number" &&
    value.generation < status.generation
  )
    return;
  const previousGeneration = status?.generation;
  if (
    previousGeneration !== undefined &&
    previousGeneration !== value.generation
  )
    invalidateView("搜索索引已更新，旧结果和恢复预览已清除。");
  status = value;
  const loaded = value.sources.filter((source) => source.status === "loaded");
  const failed = value.sources.filter((source) => source.status === "failed");
  const retainedErrors = value.sources.filter(
    (source) => source.status === "loaded" && Boolean(source.error),
  );
  const notLoaded = value.sources.filter(
    (source) => source.status === "not-loaded",
  );
  const label = value.paused
    ? "已暂停自动构建"
    : value.loading
      ? "加载中"
      : value.cancelled
        ? "已停止 · 部分范围"
        : value.truncated
          ? "达到加载上限"
          : value.error
            ? "加载失败 · 范围不完整"
            : failed.length || notLoaded.length || retainedErrors.length
              ? "部分范围"
              : loaded.length
                ? "已加载"
                : "未加载";
  text("coverage-badge", label);
  $("coverage-badge").classList.toggle(
    "complete",
    !value.paused &&
      !value.loading &&
      !value.cancelled &&
      !value.truncated &&
      !value.error &&
      !failed.length &&
      !retainedErrors.length &&
      !notLoaded.length &&
      loaded.length > 0,
  );
  $("coverage-badge").classList.toggle(
    "partial",
    Boolean(value.error) ||
      Boolean(value.paused) ||
      value.cancelled ||
      value.truncated ||
      failed.length > 0 ||
      retainedErrors.length > 0 ||
      notLoaded.length > 0,
  );
  text(
    "coverage-summary",
    loaded.length || value.total || value.loading
      ? `已读取 ${value.devicesLoaded}/${value.devicesTotal} 台设备 · ${loaded.length} 个快照已加载 · ${failed.length} 个失败 · ${retainedErrors.length} 个沿用缓存 · ${notLoaded.length} 个来源未加载（可能含数量未知的历史范围）。${value.includeHistory ? "范围包含已保留的恢复点与历史版本。" : "本次范围仅包含当前快照。"}`
      : value.error
        ? "加载未完成，当前没有可搜索的来源。请处理连接错误后重试；不能据此判断远端没有结果。"
        : value.paused
          ? "本机搜索缓存已清空或暂停，远端文件与标签保持不变。请明确点击重建后继续。"
          : "正在自动读取当前快照、恢复点与历史版本；只有成功加载的来源进入搜索。",
  );
  if (document.body.classList.contains("popup-workbench")) {
    text(
      "coverage-summary",
      `${value.devicesLoaded}/${value.devicesTotal} 台设备 · ${loaded.length} 快照${failed.length ? ` · ${failed.length} 失败` : ""}${retainedErrors.length ? ` · ${retainedErrors.length} 旧缓存` : ""}${notLoaded.length ? ` · ${notLoaded.length} 未加载` : ""}`,
    );
  }
  busy("load-snapshots", value.loading || loadRequested || actionPending);
  busy("clear-cache", actionPending);
  show("load-snapshots", !value.paused);
  show("rebuild-cache", Boolean(value.paused));
  busy("rebuild-cache", value.loading || loadRequested || actionPending);
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
    value.paused
      ? "自动构建已暂停。输入搜索或重新打开弹窗不会重建；请点击“重建搜索缓存”。"
      : undefined,
    value.cancelled ? "加载已停止，尚未加载的范围不会被搜索。" : undefined,
    value.truncated ? "达到安全加载上限，结果不覆盖全部远端快照。" : undefined,
    failed.length ? "部分快照读取失败，可展开下方范围查看原因。" : undefined,
    retainedErrors.length
      ? "部分来源刷新失败，保留了此前已加载的缓存；这些内容可能过时。"
      : undefined,
  ].filter(Boolean);
  const popupWarnings = [
    value.error,
    value.paused ? "自动构建已暂停；点击“重建搜索缓存”继续。" : undefined,
    value.truncated ? "已达加载上限，覆盖不完整。" : undefined,
    failed.length || retainedErrors.length
      ? "部分来源失败或沿用旧缓存，详见范围详情。"
      : undefined,
  ].filter(Boolean);
  text(
    "coverage-warning",
    document.body.classList.contains("popup-workbench")
      ? popupWarnings.join(" ")
      : warnings.join(" "),
  );
  show(
    "coverage-warning",
    document.body.classList.contains("popup-workbench")
      ? popupWarnings.length > 0
      : warnings.length > 0,
  );
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
        ? source.error
          ? `缓存可用 · ${failureLabel(source.errorCode)}`
          : "已加载"
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
        source.stale ||
        (source.kind === "current" &&
          Date.now() - Date.parse(source.capturedAt) > 5 * 60_000)
      ) {
        row.append(
          node(
            "span",
            "result-tag stale",
            source.stale
              ? "旧缓存 · 来源未刷新"
              : "快照可能过时 · 已超过 5 分钟",
          ),
        );
      }
    }
    if (source.error) row.append(node("span", "source-error", source.error));
    sourceList.append(row);
  }
  text(
    "body-coverage",
    `正文覆盖：已加载 ${value.bodyLoaded || 0} · 不可用 ${value.bodyMissing || 0} · 已截断 ${value.bodyTruncated || 0}。${contentCaptureSummary} 正文未采集不影响标题、网址或标签恢复。`,
  );
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
    value.paused,
    value.bodyLoaded,
    value.bodyMissing,
    value.bodyTruncated,
    retainedErrors.length,
  ]);
  if (refreshKey !== key) {
    refreshKey = key;
    if (loaded.length) void runQuery();
    else if (!value.loading) {
      shownResults = [];
      text("result-count", "");
      renderEmpty(
        "还没有可搜索的快照",
        value.paused
          ? "自动构建已暂停。请点击“重建搜索缓存”；这不会删除远端数据。"
          : "正在自动补充当前快照、恢复点和历史版本。未加载、失败和暂停的范围不计入搜索。",
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
        : status?.paused
          ? "缓存自动构建已暂停，请点击“重建搜索缓存”。未加载不代表远端没有结果。"
          : "正在自动读取快照；未加载不代表远端没有结果。",
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
    void automaticSearch();
    void runQuery();
  }, 180);
}
function contentLabel(value?: string): string {
  const labels: Record<string, string> = {
    available: "正文可搜索",
    disabled: "正文采集未开启",
    "permission-denied": "正文站点未授权",
    unavailable: "正文不可用",
    truncated: "正文已截断",
    missing: "正文对象未加载",
    "not-loaded": "正文尚未加载",
    "not-captured": "未采集正文",
    encrypted: "正文需解密",
    "decryption-failed": "正文解密失败",
  };
  return value ? labels[value] || value : "没有已加载正文";
}
function renderResults(response: QueryResponse, query: string) {
  if ($("search-notice").dataset.kind === "index-update")
    show("search-notice", false);
  const loaded = response.coverage.sources.filter(
    (source) => source.status === "loaded",
  ).length;
  text(
    "result-count",
    `显示 ${response.results.length}/${response.total} 个网址${response.occurrenceTotal !== undefined ? ` · ${response.occurrenceTotal} 处来源` : ""}`,
  );
  text(
    "result-explanation",
    `在 ${loaded} 个已加载快照中匹配，相同网址已聚合。先筛选再限量；定位或恢复使用下方选中的具体来源。${response.coverage.loading || response.coverage.cancelled || response.coverage.truncated || response.coverage.sources.some((source) => source.status !== "loaded") ? " 当前覆盖不完整。" : " 结果不是设备的实时标签状态。"}`,
  );
  if (document.body.classList.contains("popup-workbench")) {
    text(
      "result-explanation",
      response.coverage.loading ||
        response.coverage.cancelled ||
        response.coverage.truncated ||
        response.coverage.sources.some((source) => source.status !== "loaded")
        ? "仅搜索已加载范围；定位或恢复前选择具体来源。"
        : "同网址已聚合；定位或恢复前选择具体来源。",
    );
  }
  const list = $("search-results");
  list.replaceChildren();
  if (!response.results.length) {
    renderEmpty(
      "已加载范围内暂无匹配",
      "可调整关键词或筛选。未加载、未授权正文、读取失败和加载上限之外的内容不计入搜索。",
    );
    return;
  }
  for (const aggregate of response.results) {
    const occurrences = aggregate.occurrences?.length
      ? aggregate.occurrences
      : [aggregate];
    const card = node("article", "search-result");
    card.dataset.aggregateId = aggregate.id;
    const heading = node("div", "result-heading");
    const icon = node(
      "span",
      "result-site-icon",
      aggregate.domain.slice(0, 1).toUpperCase() || "↗",
    );
    icon.setAttribute("aria-hidden", "true");
    const content = node("div", "result-text");
    const title = node("h3", "result-title");
    highlight(title, aggregate.title || aggregate.url, query);
    const url = node("p", "result-url");
    highlight(url, aggregate.url, query);
    content.append(title, url);
    heading.append(
      icon,
      content,
      node("span", "occurrence-count", `${occurrences.length} 处来源`),
    );
    card.append(heading);
    const snippetSlot = node("div", "result-snippet-slot");
    card.append(snippetSlot);
    const choice = node(
      "label",
      "occurrence-selector",
      "操作来源：设备 · 快照 · 观察时间",
    );
    const select = node("select");
    select.dataset.action = "select-source";
    select.setAttribute("aria-label", "选择具体快照来源");
    for (const item of occurrences) {
      select.append(
        new Option(
          `${item.deviceName} · ${kindName(item.kind)} · ${date(item.capturedAt)} · ${item.groupTitle || "未分组"} · ${item.tabKey.slice(-8)}`,
          item.id,
        ),
      );
    }
    const previous = occurrenceSelections.get(aggregate.id);
    select.value = occurrences.some((item) => item.id === previous)
      ? previous!
      : occurrences[0].id;
    choice.append(select);
    card.append(choice);
    const details = node("div", "occurrence-details");
    card.append(details);
    const renderOccurrence = () => {
      const result =
        occurrences.find((item) => item.id === select.value) || occurrences[0];
      occurrenceSelections.set(aggregate.id, result.id);
      card.dataset.resultId = result.id;
      card.dataset.sourceId = result.sourceId;
      card.dataset.tabKey = result.tabKey;
      card.dataset.windowKey = result.windowKey;
      details.replaceChildren();
      snippetSlot.replaceChildren();
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
        meta.append(node("span", "result-tag stale", "可能过时"));
      details.append(meta);
      if (result.bodySnippet) {
        const snippet = node("p", "result-snippet");
        highlight(snippet, result.bodySnippet, query);
        snippetSlot.append(snippet);
      }
      details.append(
        node(
          "p",
          "content-state",
          `正文：${contentLabel(result.contentStatus)}${result.contentReason ? ` · ${result.contentReason}` : ""}`,
        ),
      );
      const provenance = node(
        "p",
        "result-observation",
        `快照观察：${date(result.capturedAt)} · 窗口 ${result.windowKey} · 标签 ${result.tabKey}`,
      );
      provenance.title = `来源快照 ${result.sourceId}`;
      details.append(provenance);
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
        ["tab", "恢复标签"],
        ["group", "恢复标签组"],
        ["window", "恢复窗口"],
      ] as const) {
        if (scope === "group" && !result.groupKey) continue;
        const button = node("button", undefined, label);
        button.dataset.action = `restore-${scope}`;
        button.addEventListener("click", () => {
          void previewResult(result, scope);
        });
        actions.append(button);
      }
      details.append(actions);
    };
    select.addEventListener("change", renderOccurrence);
    renderOccurrence();
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
    presentPlan(
      response,
      `${result.deviceName} · ${kindName(result.kind)}`,
      generation,
    );
  } catch (error) {
    notice(message(error), true);
  } finally {
    planning = false;
    disableResultActions(false);
  }
}
function presentPlan(
  response: Plan,
  sourceLabel: string,
  generation: number | string | undefined,
) {
  plan = response;
  planGeneration = generation;
  text(
    "search-plan-source",
    `${sourceLabel} · 快照版本 ${response.snapshot.revision}`,
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
    void refreshWorkbenchState();
    notice(
      "恢复任务已开始。下方可查看进度并停止后续创建；关闭弹窗不影响后台任务，重开后可继续查看。",
    );
  } catch (error) {
    notice(message(error), true);
  } finally {
    starting = false;
    busy("search-confirm-restore", false);
  }
}
async function automaticSearch() {
  if (automaticPending || status?.paused || actionPending) return;
  automaticPending = true;
  const epoch = actionEpoch;
  try {
    const value = await request<Coverage>({ type: "SEARCH_AUTO" });
    if (epoch === actionEpoch && value?.sources) renderCoverage(value);
  } catch (error) {
    if (epoch === actionEpoch) notice(message(error), true);
  } finally {
    automaticPending = false;
  }
}
async function loadSnapshots(rebuild = false) {
  if (loadRequested || status?.loading || (!rebuild && status?.paused)) return;
  loadRequested = true;
  busy("load-snapshots", true);
  busy("rebuild-cache", true);
  ++actionEpoch;
  try {
    await request({
      type: rebuild ? "SEARCH_REBUILD" : "SEARCH_LOAD",
      includeHistory: true,
    });
  } catch (error) {
    notice(message(error), true);
  } finally {
    loadRequested = false;
    await refreshStatus();
    busy("load-snapshots", Boolean(status?.loading));
    busy("rebuild-cache", Boolean(status?.loading));
  }
}
async function cacheAction(type: "SEARCH_CANCEL" | "SEARCH_CLEAR") {
  if (actionPending) return;
  actionPending = true;
  ++actionEpoch;
  busy("clear-cache", true);
  busy("cancel-load", true);
  try {
    await request({ type });
    if (type === "SEARCH_CLEAR")
      invalidateView(
        "本机搜索缓存已清空并暂停自动构建。远端正文、快照和浏览器标签均未删除；请明确点击重建后继续。",
      );
    else notice("自动构建已暂停，已加载的部分仍可搜索。点击重建后继续。");
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
type WorkbenchState = AppState & {
  contentCapture?: {
    sampled: number;
    eligible: number;
    skipped: number;
    failed: number;
    remaining: number;
    objectCount?: number;
    limit: number;
    updatedAt?: string;
  };
  sync: AppState["sync"] & { nextDueAt?: number };
};
let syncBusy = false;
async function refreshWorkbenchState() {
  if (statePending) return;
  statePending = true;
  try {
    const value = await request<WorkbenchState>({ type: "GET_STATE" });
    localState = value;
    const changed = deviceId !== value.deviceId;
    deviceId = value.deviceId;
    const sync = value.sync;
    const settings = value.settings;
    const syncLabel = sync.error
      ? `同步异常：${sync.error}`
      : !settings.endpoint
        ? "尚未配置 WebDAV，请打开设置"
        : !settings.enabled
          ? "自动同步已暂停"
          : sync.dirty || sync.pending
            ? "本机工作区等待同步"
            : sync.lastSuccess
              ? `最近同步 ${date(sync.lastSuccess)}`
              : "等待首次同步";
    text("workbench-sync-status", syncLabel);
    $("workbench-sync-status").parentElement?.classList.toggle(
      "error",
      Boolean(sync.error),
    );
    text(
      "workbench-next-sync",
      settings.enabled && sync.nextDueAt
        ? `下次 ${date(new Date(sync.nextDueAt).toISOString())}`
        : "",
    );
    busy(
      "workbench-sync",
      syncBusy || !settings.endpoint || Boolean(sync.pausedConflict),
    );
    const syncAlert = document.getElementById("workbench-sync-alert");
    if (syncAlert) {
      syncAlert.hidden = !sync.error && !sync.pausedConflict;
      syncAlert.textContent =
        sync.error ||
        (sync.pausedConflict
          ? "设备身份冲突，同步已暂停，请在设置中检查。"
          : "");
    }
    const capture = value.contentCapture;
    contentCaptureSummary = capture
      ? `本机采样 ${capture.sampled} · 跳过 ${capture.skipped} · 失败 ${capture.failed} · 待采样 ${capture.remaining}；此设备远端正文对象（上次同步观察）${capture.objectCount ?? "未知"}/${capture.limit || 1000}。${(capture.objectCount ?? 0) >= 900 ? "已接近上限；清空本机缓存不会释放 WebDAV 空间。" : ""}`
      : "正文采集默认关闭，只有明确授权的站点才可采集。";
    const capacityWarning = document.getElementById("body-limit-warning");
    if (capacityWarning) {
      capacityWarning.hidden = (capture?.objectCount ?? 0) < 900;
      capacityWarning.textContent =
        "远端正文接近 1000 个上限；清空本机缓存不会释放 WebDAV 空间。";
    }
    if (status)
      text(
        "body-coverage",
        `正文覆盖：已加载 ${status.bodyLoaded || 0} · 不可用 ${status.bodyMissing || 0} · 已截断 ${status.bodyTruncated || 0}。${contentCaptureSummary}`,
      );
    renderWorkbenchOperation(value.operation);
    if (changed && shownResults.length) void runQuery();
  } catch (error) {
    notice(message(error), true);
  } finally {
    statePending = false;
  }
}
function renderWorkbenchOperation(operation?: RestoreOperation) {
  show("workbench-operation", Boolean(operation));
  if (!operation) return;
  const labels: Record<RestoreOperation["status"], string> = {
    PREPARED: "准备恢复",
    RUNNING: "正在恢复",
    INTERRUPTED: "恢复已中断",
    CANCELLED: "已停止后续创建",
    COMPLETED: "恢复完成",
    ROLLED_BACK: "已撤销恢复",
  };
  text("workbench-operation-title", labels[operation.status]);
  text(
    "workbench-operation-status",
    operation.syncStatus === "synced" ? "合并已同步" : "远端待同步",
  );
  $("workbench-operation-status").classList.toggle(
    "pending",
    operation.syncStatus !== "synced",
  );
  const total = operation.plan.windows.reduce(
    (sum, window) => sum + window.tabs.length,
    0,
  );
  const processed = operation.createdTabs.length + operation.failures.length;
  $("workbench-operation-fill").style.width =
    `${total ? Math.min(100, (processed / total) * 100) : 100}%`;
  text(
    "workbench-operation-detail",
    `已创建 ${operation.createdWindows.length} 个窗口、${operation.createdTabs.length}/${total} 个标签${operation.failures.length ? `，失败 ${operation.failures.length} 项` : ""}。${operation.status === "CANCELLED" ? "已创建窗口保留。" : "关闭弹窗后任务仍由后台管理，重开可查看。"}`,
  );
  const uncertain = operation.uncertain
    ? "上次创建结果不确定，不能自动继续；可停止任务并保留当前窗口。"
    : "";
  const error = [
    uncertain,
    operation.error,
    ...operation.failures.slice(0, 2).map((item) => item.reason),
  ]
    .filter(Boolean)
    .join(" ");
  text("workbench-operation-error", error);
  show("workbench-operation-error", Boolean(error));
  show(
    "workbench-cancel-restore",
    ["PREPARED", "RUNNING", "INTERRUPTED"].includes(operation.status),
  );
  show(
    "workbench-resume-restore",
    operation.status === "INTERRUPTED" && !operation.uncertain,
  );
}
async function refreshDevices() {
  const container = $("workbench-device-list");
  container.replaceChildren(node("p", "muted", "正在读取设备…"));
  try {
    const devices = await request<Device[]>({ type: "LIST_DEVICES" });
    text("workbench-device-count", `· ${devices.length} 台`);
    container.replaceChildren();
    if (!devices.length)
      container.append(node("p", "muted", "尚无可用设备快照。"));
    for (const device of devices) {
      const row = node("div", "workbench-device");
      row.dataset.deviceId = device.deviceId;
      const information = node("div");
      information.append(
        node(
          "strong",
          undefined,
          `${device.name}${device.deviceId === deviceId ? " · 本机" : ""}`,
        ),
        node(
          "p",
          undefined,
          `${device.windows} 个窗口 · ${device.tabs} 个标签 · ${date(device.updatedAt)}`,
        ),
      );
      const button = node("button", "secondary", "预览全部窗口");
      button.dataset.action = "restore-device";
      button.addEventListener("click", () => {
        void previewDevice(device, button);
      });
      row.append(information, button);
      container.append(row);
    }
  } catch (error) {
    container.replaceChildren(node("p", "inline-error", message(error)));
  }
}
async function previewDevice(device: Device, button: HTMLButtonElement) {
  if (planning || starting) return;
  planning = true;
  button.disabled = true;
  const generation = status?.generation;
  try {
    const snapshot = await request<Snapshot>({
      type: "GET_SNAPSHOT",
      deviceId: device.deviceId,
      kind: "current",
    });
    const response = await request<Plan>({
      type: "PLAN_RESTORE",
      snapshot,
      selection: {},
    });
    if (status?.generation !== generation)
      throw new Error("索引已变化，请重新预览。 ");
    presentPlan(response, `${device.name} · 全部当前窗口`, generation);
  } catch (error) {
    notice(message(error), true);
  } finally {
    planning = false;
    button.disabled = false;
  }
}
$("workbench-settings").addEventListener("click", () => {
  void chrome.runtime
    .openOptionsPage()
    .catch((error) => notice(message(error), true));
});
$("workbench-sync").addEventListener("click", async () => {
  if (syncBusy) return;
  syncBusy = true;
  busy("workbench-sync", true);
  try {
    await request({ type: "SYNC_NOW" });
    await refreshWorkbenchState();
    notice("同步已执行，请查看本机状态。");
  } catch (error) {
    notice(message(error), true);
  } finally {
    syncBusy = false;
    busy("workbench-sync", !localState?.settings.endpoint);
  }
});
$("device-workspaces").addEventListener("toggle", () => {
  if ($<HTMLDetailsElement>("device-workspaces").open) void refreshDevices();
});
for (const [id, type] of [
  ["workbench-cancel-restore", "CANCEL_RESTORE"],
  ["workbench-resume-restore", "RESUME_RESTORE"],
])
  $(id).addEventListener("click", async () => {
    busy(id, true);
    try {
      await request({ type });
      await refreshWorkbenchState();
    } catch (error) {
      notice(message(error), true);
    } finally {
      busy(id, false);
    }
  });
$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(debounce);
  void automaticSearch();
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
$("rebuild-cache").addEventListener("click", () => {
  void loadSnapshots(true);
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
void refreshWorkbenchState();
void refreshStatus().then(() => automaticSearch());
setInterval(() => {
  if (document.visibilityState === "visible") {
    void refreshStatus();
    void refreshWorkbenchState();
  }
}, 1500);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshStatus();
    void refreshWorkbenchState();
  }
});
