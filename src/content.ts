import { safeUrl, validTextRef } from "./model";
import { load, update } from "./state";
import { WebDAVRepository } from "./webdav";
import type { Snapshot, TabContent } from "./types";

/** Self-contained: passed by Chrome to an isolated world; never reads form values. */
export function extractVisibleText(): {
  text: string;
  truncated: boolean;
  url: string;
} {
  const forbidden =
    "script,style,noscript,template,form,input,textarea,select,option,button,[contenteditable],[role=textbox],[hidden],[aria-hidden=true]";
  const walker = document.createTreeWalker(
    document.body || document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  const chunks: string[] = [];
  let size = 0,
    visited = 0,
    truncated = false;
  const deadline = performance.now() + 200;
  while (walker.nextNode()) {
    if (++visited > 20000 || performance.now() > deadline) {
      truncated = true;
      break;
    }
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest(forbidden)) continue;
    let visible = true,
      depth = 0;
    for (let el: Element | null = parent; el; el = el.parentElement) {
      if (++depth > 100 || performance.now() > deadline) {
        visible = false;
        truncated = true;
        break;
      }
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      ) {
        visible = false;
        break;
      }
    }
    if (!visible || !parent.getClientRects().length) continue;
    const value = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    const remaining = 20000 - size;
    if (value.length + 1 > remaining) {
      chunks.push(value.slice(0, Math.max(0, remaining - 1)));
      truncated = true;
      break;
    }
    chunks.push(value);
    size += value.length + 1;
  }
  return {
    text: chunks.join("\n").slice(0, 20000),
    truncated,
    url: location.href,
  };
}

export async function captureSnapshotText(
  snapshot: Snapshot,
): Promise<Snapshot> {
  const state = await load(),
    settings = state.settings;
  const copy = structuredClone(snapshot);
  const all = copy.windows.flatMap((w) => w.tabs);
  if (!settings.contentEnabled) {
    for (const tab of all)
      if (!validTextRef(tab.content?.ref, tab.url))
        tab.content = { status: "disabled", reason: "正文采集未启用" };
    return copy;
  }
  const allowed = new Set(settings.contentOrigins || []);
  const eligible = all.filter(
    (t) => safeUrl(t.url, settings) && allowed.has(new URL(t.url).origin),
  );
  for (const tab of all)
    if (!eligible.includes(tab) && !validTextRef(tab.content?.ref, tab.url))
      tab.content = {
        status: "permission-denied",
        reason: "此站点未获正文采集授权",
      };
  const start =
    (state.contentCaptureCursor || 0) % Math.max(1, eligible.length);
  const chosen = Array.from(
    { length: Math.min(100, eligible.length) },
    (_, i) => eligible[(start + i) % eligible.length],
  );
  for (const tab of eligible)
    if (!chosen.includes(tab) && !validTextRef(tab.content?.ref, tab.url))
      tab.content = {
        status: "unavailable",
        reason: "本轮采样上限100页，后续周期轮转采集",
      };
  const repo = new WebDAVRepository(settings);
  let sampled = 0,
    failed = 0,
    objectCount: number | undefined;
  for (const tab of chosen) {
    let content: TabContent;
    try {
      const origin = new URL(tab.url).origin;
      if (
        !(await chrome.permissions.contains({
          permissions: ["scripting"],
          origins: [origin + "/*"],
        }))
      ) {
        tab.content = {
          status: "permission-denied",
          reason: "浏览器尚未授予此站点的正文读取权限",
        };
        failed++;
        continue;
      }
      const candidates = Object.entries(state.identities.tabs).filter(
        ([, value]) => value.key === tab.tabKey && value.url === tab.url,
      );
      if (candidates.length !== 1) throw Error("runtime-identity");
      const id = Number(candidates[0][0]);
      const before = await chrome.tabs.get(id);
      const browserWindow = await chrome.windows.get(before.windowId);
      if (browserWindow.incognito || browserWindow.type !== "normal")
        throw Error("page-changed");
      if (
        before.incognito ||
        !before.url ||
        new URL(before.url).username ||
        new URL(before.url).password ||
        safeUrl(before.url, settings) !== tab.url
      )
        throw Error("page-changed");
      if (before.status === "loading") {
        tab.content = {
          status: "unavailable",
          reason: "页面仍在加载，下个同步周期重试",
        };
        failed++;
        continue;
      }
      const response = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: extractVisibleText,
      });
      const result = response[0]?.result;
      const after = await chrome.tabs.get(id);
      if (
        after.incognito ||
        after.url !== before.url ||
        result?.url !== before.url ||
        safeUrl(after.url, settings) !== tab.url
      )
        throw Error("page-changed");
      if (
        !result ||
        typeof result.text !== "string" ||
        result.text.length > 20000 ||
        !result.text.trim()
      )
        throw Error("empty-text");
      if (
        !(await chrome.permissions.contains({
          permissions: ["scripting"],
          origins: [origin + "/*"],
        }))
      )
        throw Error("permission-revoked");
      await update((s) => {
        s.contentObjectEndpoint = settings.endpoint;
      });
      const written = await repo.writeText(state.deviceId, result.text);
      objectCount = written.objectCount;
      sampled++;
      const prior = tab.content?.ref;
      content = {
        status: result.truncated ? "truncated" : "available",
        ref: {
          ownerDeviceId: state.deviceId,
          objectId: written.objectId,
          bytes: written.bytes,
          observedAt:
            prior?.objectId === written.objectId
              ? prior.observedAt
              : new Date().toISOString(),
          captureUrl: tab.url,
        },
        ...(result.truncated
          ? { reason: "受20000字符/200ms预算限制，仅保存部分可见正文" }
          : {}),
      };
    } catch (error) {
      failed++;
      const code = (error as { code?: string })?.code;
      if (code === "text-limit") objectCount = 1000;
      content = {
        status: "unavailable",
        reason:
          code === "text-limit"
            ? "远端正文对象已达1000个上限；本轮未保存正文"
            : code === "limit"
              ? "正文对象或服务器响应超过安全大小限制"
              : error instanceof Error && error.message === "permission-revoked"
                ? "采集授权已撤销，正文未上传"
                : error instanceof Error && error.message === "page-changed"
                  ? "采集时页面已导航，未绑定旧页面正文"
                  : "正文不可读取、为空或上传失败；标题和URL仍可搜索",
      };
    }
    tab.content = content;
  }
  await update((s) => {
    s.contentCaptureCursor = eligible.length
      ? (start + chosen.length) % eligible.length
      : 0;
    s.contentCapture = {
      sampled,
      eligible: eligible.length,
      skipped: all.length - chosen.length,
      failed,
      remaining: Math.max(0, eligible.length - chosen.length),
      objectCount,
      limit: 1000,
      updatedAt: new Date().toISOString(),
    };
    for (const tab of all)
      for (const identity of Object.values(s.identities.tabs))
        if (identity.key === tab.tabKey && identity.url === tab.url)
          identity.content = tab.content;
    s.current = copy;
  });
  return copy;
}
