import type { AppState, Settings } from "./types";
type ConnectionSettings = Settings & {
  httpAcknowledgedOrigin?: string;
  syncIntervalMinutes?: number;
  contentEnabled?: boolean;
  contentOrigins?: string[];
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};
const input = (id: string) => $<HTMLInputElement>(id);
let busy = false;
let loaded = false;
async function request<T>(message: Record<string, unknown>): Promise<T> {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.ok !== true)
    throw new Error(result?.error || "操作未完成，请稍后重试。");
  return result.data as T;
}
function feedback(message: string, error = false) {
  const target = $("settings-error");
  target.textContent = message;
  target.classList.toggle("error", error);
  target.hidden = false;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
function endpointUrl(): URL | undefined {
  try {
    return new URL(input("endpoint").value.trim());
  } catch {
    return undefined;
  }
}
function updateHttpWarning(resetConsent: boolean) {
  if (resetConsent) input("http-acknowledged").checked = false;
  const endpoint = endpointUrl();
  const isHttp = endpoint?.protocol === "http:";
  $("http-risk").hidden = !isHttp;
  $("http-origin").textContent = isHttp ? endpoint.origin : "";
  if (!isHttp) input("http-acknowledged").checked = false;
}
function readSettings(): ConnectionSettings {
  const endpoint = input("endpoint").value.trim();
  const parsed = endpointUrl();
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search
  ) {
    throw new Error(
      "请使用不含用户名、密码、查询参数或片段的 HTTP 或 HTTPS WebDAV 地址。",
    );
  }
  if (parsed.protocol === "http:" && !input("http-acknowledged").checked) {
    throw new Error("使用 HTTP 前，请阅读并明确勾选此配置的明文传输风险确认。");
  }
  const deviceName = input("device-name").value.trim();
  if (!deviceName) throw new Error("请输入设备名称。");
  const historyLimit = Number(input("history-limit").value);
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 100)
    throw new Error("历史快照保留数应为 1–100。");
  const syncIntervalMinutes = Number(
    $<HTMLSelectElement>("sync-interval").value,
  );
  if (![5, 10, 30, 60, 1440].includes(syncIntervalMinutes))
    throw new Error("请选择受支持的自动同步频率。");
  const contentEnabled = input("content-enabled").checked;
  const contentOrigins = [
    ...new Set(
      $<HTMLTextAreaElement>("content-origins")
        .value.split(/\n/)
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
          let origin: URL;
          try {
            origin = new URL(value);
          } catch {
            throw new Error("正文采集站点必须是完整的 HTTP 或 HTTPS 源。");
          }
          if (
            !["http:", "https:"].includes(origin.protocol) ||
            origin.hostname.includes("*") ||
            origin.username ||
            origin.password ||
            origin.search ||
            origin.hash ||
            !["", "/"].includes(origin.pathname)
          )
            throw new Error(
              "正文采集仅接受明确的 HTTP / HTTPS 源，不允许通配符、路径或账户信息。",
            );
          return origin.origin;
        }),
    ),
  ];
  if (contentEnabled && !contentOrigins.length)
    throw new Error("启用正文采集前，请填写至少一个允许采集的站点。");
  return {
    endpoint,
    syncIntervalMinutes: syncIntervalMinutes as 5 | 10 | 30 | 60 | 1440,
    contentEnabled,
    contentOrigins,
    username: input("username").value,
    password: input("password").value,
    deviceName,
    enabled: input("enabled").checked,
    blacklist: $<HTMLTextAreaElement>("blacklist")
      .value.split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
    stripParams: input("strip-params")
      .value.split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
    historyLimit,
    encryptionPassphrase: input("encryption-passphrase").value,
    ...(parsed.protocol === "http:"
      ? { httpAcknowledgedOrigin: parsed.origin }
      : {}),
  };
}
function setBusy(value: boolean) {
  busy = value;
  $<HTMLButtonElement>("test-connection").disabled = value || !loaded;
  $<HTMLButtonElement>("save-settings").disabled = value || !loaded;
  $<HTMLFieldSetElement>("settings-fields").disabled = value || !loaded;
}
async function applySettings(testOnly: boolean) {
  if (busy || !loaded) return;
  try {
    const settings = readSettings();
    // Exact selected scheme + host, requested directly from a user gesture.
    const permission = chrome.permissions.request({
      origins: [
        ...new Set([
          new URL(settings.endpoint).origin + "/*",
          ...(!testOnly && settings.contentEnabled
            ? (settings.contentOrigins || []).map((origin) => origin + "/*")
            : []),
        ]),
      ],
      ...(!testOnly && settings.contentEnabled
        ? { permissions: ["scripting" as chrome.runtime.ManifestPermissions] }
        : {}),
    });
    setBusy(true);
    feedback(testOnly ? "正在测试 WebDAV 连接…" : "正在保存设置…");
    if (!(await permission))
      throw new Error("未授予所选 WebDAV 主机权限。设置未保存。");
    await request({
      type: testOnly ? "TEST_CONNECTION" : "SAVE_SETTINGS",
      settings,
    });
    feedback(
      testOnly
        ? "连接成功。确认配置后，点击保存设置。"
        : "设置已保存。可以关闭此标签页，点击工具栏图标继续接力。",
    );
  } catch (error) {
    feedback(errorMessage(error), true);
  } finally {
    setBusy(false);
  }
}
async function loadSettings() {
  try {
    const state = await request<AppState>({ type: "GET_STATE" });
    const settings = state.settings as ConnectionSettings;
    input("device-name").value = settings.deviceName;
    input("endpoint").value = settings.endpoint;
    input("username").value = settings.username;
    input("password").value = settings.password;
    input("enabled").checked = settings.enabled;
    $<HTMLSelectElement>("sync-interval").value = String(
      settings.syncIntervalMinutes || 10,
    );
    input("content-enabled").checked = settings.contentEnabled === true;
    $<HTMLTextAreaElement>("content-origins").value = (
      settings.contentOrigins || []
    ).join("\n");
    $<HTMLTextAreaElement>("blacklist").value = settings.blacklist.join("\n");
    input("strip-params").value = settings.stripParams.join(", ");
    input("history-limit").value = String(settings.historyLimit);
    input("encryption-passphrase").value = settings.encryptionPassphrase;
    updateHttpWarning(false);
    input("http-acknowledged").checked =
      endpointUrl()?.protocol === "http:" &&
      settings.httpAcknowledgedOrigin === endpointUrl()?.origin;
    loaded = true;
  } catch (error) {
    feedback(errorMessage(error), true);
  } finally {
    setBusy(false);
  }
}
input("endpoint").addEventListener("input", () => updateHttpWarning(true));
input("endpoint").addEventListener("change", () => updateHttpWarning(true));
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void applySettings(false);
});
$("test-connection").addEventListener("click", () => {
  void applySettings(true);
});
void loadSettings();
