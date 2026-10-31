import type { Plan, RestoreOperation, CreatedTab } from "./types";
import { load, update, dirty } from "./state";
import { safeUrl } from "./model";
let running = false,
  cancelRequested = false;
const now = () => new Date().toISOString();
export async function prepare(plan: Plan): Promise<RestoreOperation> {
  return update((s) => {
    if (
      s.operation &&
      ["PREPARED", "RUNNING", "INTERRUPTED"].includes(s.operation.status)
    )
      throw Error("已有恢复任务，请先继续或取消");
    const op: RestoreOperation = {
      browserSession: s.identities.browserSession,
      id: plan.id,
      plan,
      status: "PREPARED",
      createdWindows: [],
      createdTabs: [],
      failures: [],
      nextIndex: 0,
      startedAt: now(),
      updatedAt: now(),
      syncStatus: "pending",
    };
    s.operation = op;
    return op;
  });
}
async function mutate(id: string, fn: (op: RestoreOperation) => void) {
  return update((s) => {
    if (s.operation?.id !== id) throw Error("恢复任务已变更");
    fn(s.operation);
    s.operation.updatedAt = now();
    return s.operation;
  });
}
export async function interruptOnBoot() {
  await update((s) => {
    if (s.operation?.status === "RUNNING") {
      s.operation.status = "INTERRUPTED";
      s.operation.error = s.operation.uncertain
        ? "上次创建结果尚未确认。请保留当前窗口并取消任务，检查后重新选择。"
        : "恢复被中断，可核对已创建标签后继续。";
    }
  });
}
export async function cancel() {
  cancelRequested = true;
  const s = await load();
  if (
    s.operation &&
    ["PREPARED", "RUNNING", "INTERRUPTED"].includes(s.operation.status)
  )
    await mutate(s.operation.id, (o) => {
      o.status = "CANCELLED";
      o.error = "已停止后续创建；已新增窗口保留。";
    });
  await dirty();
}
export async function execute(): Promise<void> {
  if (running) throw Error("恢复任务正在运行");
  running = true;
  try {
    await executeInternal();
  } finally {
    running = false;
  }
}
async function executeInternal(): Promise<void> {
  let op = (await load()).operation;
  if (!op) throw Error("没有恢复任务");
  if (op.browserSession !== (await load()).identities.browserSession)
    throw Error(
      "浏览器已重启，运行时窗口身份失效。请保留当前结果并取消任务后重新预检。",
    );
  if (!["PREPARED", "INTERRUPTED"].includes(op.status))
    throw Error("此任务不能继续");
  if (op.uncertain)
    throw Error(
      "上次创建结果不确定，不能自动重做。请保留当前窗口并取消任务后检查。",
    );
  running = true;
  cancelRequested = false;
  const id = op.id;
  try {
    // Verify recorded objects still exist; never recreate a tab the user removed after a partial restore.
    for (const c of op.createdTabs) {
      try {
        const t = await chrome.tabs.get(c.tabId);
        if (t.windowId !== c.windowId) throw Error("标签已移动");
      } catch {
        await mutate(id, (o) => {
          if (!o.failures.some((f) => f.tabKey === c.sourceTabKey))
            o.failures.push({
              tabKey: c.sourceTabKey,
              reason: "已创建标签被关闭或移动，不自动复活",
            });
        });
      }
    }
    await mutate(id, (o) => {
      o.status = "RUNNING";
      delete o.error;
    });
    let index = 0;
    for (const w of op.plan.windows) {
      for (const t of w.tabs) {
        if (index++ < op.nextIndex) continue;
        if (cancelRequested || (await load()).operation?.status === "CANCELLED")
          break;
        const live = (await load()).operation!;
        let windowId = live.createdWindows.find(
          (x) => x.sourceWindowKey === w.windowKey,
        )?.windowId;
        if (windowId !== undefined) {
          try {
            await chrome.windows.get(windowId);
          } catch {
            await mutate(id, (o) => {
              o.failures.push({
                tabKey: t.tabKey,
                reason: "新增窗口已关闭；不自动重新打开",
              });
              o.nextIndex = index;
            });
            continue;
          }
        }
        if (!safeUrl(t.url)) {
          await mutate(id, (o) => {
            o.failures.push({ tabKey: t.tabKey, reason: "URL 不安全" });
            o.nextIndex = index;
          });
          continue;
        }
        const beforeIds =
          windowId === undefined
            ? (await chrome.windows.getAll())
                .map((x) => x.id!)
                .filter(Number.isInteger)
            : (await chrome.tabs.query({ windowId }))
                .map((x) => x.id!)
                .filter(Number.isInteger);
        await mutate(id, (o) => {
          o.uncertain = {
            kind: windowId === undefined ? "window" : "tab",
            sourceWindowKey: w.windowKey,
            sourceTabKey: t.tabKey,
            url: t.url,
            beforeIds,
          };
        });
        let tab: chrome.tabs.Tab | undefined;
        try {
          if (windowId === undefined) {
            const created = await chrome.windows.create({
              url: t.url,
              focused: false,
              type: "normal",
            });
            if (created?.id === undefined || !created.tabs?.[0]?.id)
              throw Error("浏览器未返回新增窗口");
            windowId = created.id;
            tab = created.tabs[0];
          } else
            tab = await chrome.tabs.create({
              windowId,
              url: t.url,
              active: false,
              pinned: t.pinned,
            });
        } catch {
          await mutate(id, (o) => {
            o.failures.push({
              tabKey: t.tabKey,
              reason: "浏览器拒绝创建此标签",
            });
            delete o.uncertain;
            o.nextIndex = index;
          });
          continue;
        }
        const localTabKey = crypto.randomUUID();
        const c: CreatedTab = {
          sourceTabKey: t.tabKey,
          tabId: tab.id!,
          windowId: windowId!,
          expectedUrl: t.url,
          localTabKey,
          origin: t.origin,
        };
        await update((s) => {
          const o = s.operation!;
          if (o.id !== id) throw Error("恢复任务发生冲突");
          if (!o.createdWindows.some((x) => x.sourceWindowKey === w.windowKey))
            o.createdWindows.push({
              sourceWindowKey: w.windowKey,
              windowId: windowId!,
            });
          o.createdTabs.push(c);
          o.nextIndex = index;
          delete o.uncertain;
          o.updatedAt = now();
          const key =
            s.identities.windows[String(windowId)] || crypto.randomUUID();
          s.identities.windows[String(windowId)] = key;
          s.identities.tabs[String(tab!.id)] = {
            key: localTabKey,
            origin: t.origin,
            url: t.url,
            windowKey: key,
            index: t.index,
          };
        });
        if (t.pinned)
          await chrome.tabs.update(tab.id!, { pinned: true }).catch(() => {});
        // Yield between creations so Cancel can be handled and hundreds of tabs do not monopolize the worker.
        await new Promise((r) => setTimeout(r, 40));
      }
      if (cancelRequested || (await load()).operation?.status === "CANCELLED")
        break;
      const live = (await load()).operation!;
      const windowId = live.createdWindows.find(
        (x) => x.sourceWindowKey === w.windowKey,
      )?.windowId;
      if (windowId === undefined) continue;
      for (const g of w.groups) {
        const tabIds: number[] = live.createdTabs
          .filter(
            (c) =>
              c.windowId === windowId &&
              w.tabs.some(
                (t) => t.tabKey === c.sourceTabKey && t.groupKey === g.groupKey,
              ),
          )
          .map((c) => c.tabId);
        const valid: number[] = [];
        for (const tid of tabIds) {
          try {
            const t: chrome.tabs.Tab = await chrome.tabs.get(tid);
            if (t.windowId === windowId && !t.pinned) valid.push(tid);
          } catch {}
        }
        if (valid.length) {
          try {
            const groupId = await chrome.tabs.group({
              tabIds: valid as [number, ...number[]],
              createProperties: { windowId },
            });
            await chrome.tabGroups.update(groupId, {
              title: g.title,
              color: g.color,
              collapsed: g.collapsed,
            });
          } catch {
            await mutate(id, (o) => {
              o.failures.push({
                tabKey: g.groupKey,
                reason: "标签组重建失败或已被用户修改",
              });
            });
          }
        }
      }
      const active = live.createdTabs.find(
        (c) => c.sourceTabKey === w.activeTabKey,
      );
      if (active)
        await chrome.tabs
          .update(active.tabId, { active: true })
          .catch(() => {});
    }
    // Read actual browser state, and report missing created tabs without touching originals.
    op = (await load()).operation!;
    for (const c of op.createdTabs) {
      try {
        const t = await chrome.tabs.get(c.tabId);
        if (t.windowId !== c.windowId) throw Error();
      } catch {
        await mutate(id, (o) => {
          if (!o.failures.some((f) => f.tabKey === c.sourceTabKey))
            o.failures.push({
              tabKey: c.sourceTabKey,
              reason: "最终核验：标签不存在或已移动",
            });
        });
      }
    }
    for (const w of op.plan.windows) {
      const created = op.createdWindows.find(
        (x) => x.sourceWindowKey === w.windowKey,
      );
      if (!created) continue;
      let actual: chrome.tabs.Tab[];
      try {
        actual = await chrome.tabs.query({ windowId: created.windowId });
      } catch {
        continue;
      }
      const expected = w.tabs.filter((t) =>
        op!.createdTabs.some((c) => c.sourceTabKey === t.tabKey),
      );
      const actualOwned = actual
        .filter((t) => op!.createdTabs.some((c) => c.tabId === t.id))
        .sort((a, b) => a.index - b.index);
      let mismatch = actualOwned.length !== expected.length;
      for (let i = 0; i < actualOwned.length; i++) {
        const source = expected[i],
          live = actualOwned[i];
        if (!source || live.url !== source.url || live.pinned !== source.pinned)
          mismatch = true;
      }
      if (mismatch)
        await mutate(id, (o) => {
          o.failures.push({
            tabKey: w.windowKey,
            reason:
              "最终核验：URL、置顶或顺序与快照不同（可能已导航或被用户修改）",
          });
        });
    }
    await mutate(id, (o) => {
      if (o.status !== "CANCELLED") o.status = "COMPLETED";
    });
    await dirty();
  } catch (e) {
    await mutate(id, (o) => {
      if (o.status !== "CANCELLED") o.status = "INTERRUPTED";
      o.error = e instanceof Error ? e.message : "恢复中断";
    });
    await dirty();
  } finally {
    running = false;
  }
}
export function isRestoring() {
  return running;
}
export async function undo(confirmed: boolean) {
  if (!confirmed) throw Error("请明确确认撤销");
  if (running) throw Error("请先取消正在进行的恢复");
  const op = (await load()).operation;
  if (!op) throw Error("没有可撤销任务");
  if (op.browserSession !== (await load()).identities.browserSession)
    throw Error("浏览器已重启，不能自动关闭未经确认的窗口。");
  if (op.uncertain) throw Error("存在未确认创建结果，不自动关闭任何窗口");
  // Validate ALL windows before closing ANY: only exact tab membership and unchanged URLs qualify.
  for (const w of op.createdWindows) {
    let actual: chrome.tabs.Tab[];
    try {
      actual = await chrome.tabs.query({ windowId: w.windowId });
    } catch {
      throw Error("窗口状态改变，不能安全撤销");
    }
    const expected = op.createdTabs.filter((t) => t.windowId === w.windowId);
    if (
      actual.length !== expected.length ||
      actual.some(
        (t) =>
          !expected.some(
            (e) =>
              e.tabId === t.id && e.expectedUrl === (t.url || t.pendingUrl),
          ),
      )
    )
      throw Error("新增窗口已被修改，已拒绝自动关闭。请手动检查。");
  }
  for (const w of op.createdWindows) {
    const actual = await chrome.tabs.query({ windowId: w.windowId });
    const expected = op.createdTabs.filter((t) => t.windowId === w.windowId);
    if (
      actual.length !== expected.length ||
      actual.some(
        (t) =>
          !expected.some(
            (e) =>
              e.tabId === t.id && e.expectedUrl === (t.url || t.pendingUrl),
          ),
      )
    )
      throw Error("窗口刚被修改，已停止撤销剩余窗口。");
    await chrome.windows.remove(w.windowId);
  }
  await mutate(op.id, (o) => {
    o.status = "ROLLED_BACK";
  });
  await dirty();
}
