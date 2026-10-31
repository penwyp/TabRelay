import { safeUrl, readableSnapshotId } from "./model";
import { update } from "./state";
import type { Snapshot, RuntimeIdentity, Tab } from "./types";
export async function collect(): Promise<Snapshot> {
  const windows = await chrome.windows.getAll({
      populate: true,
      windowTypes: ["normal"],
    }),
    groups = await chrome.tabGroups.query({});
  return update((s) => {
    const prior = s.current,
      ids = s.identities;
    const used = new Set<string>();
    const newTabs: RuntimeIdentity["tabs"] = {},
      newWindows: RuntimeIdentity["windows"] = {},
      newGroups: RuntimeIdentity["groups"] = {};
    const ws = windows
      .filter((w) => !w.incognito && w.type === "normal")
      .map((w, order) => {
        const oldCandidates =
          prior?.windows.filter((p) =>
            p.tabs.some((pt) =>
              w.tabs?.some(
                (t) => safeUrl(t.url || t.pendingUrl, s.settings) === pt.url,
              ),
            ),
          ) || [];
        const windowKey =
          ids.windows[String(w.id)] ||
          (oldCandidates.length === 1 &&
          !Object.values(newWindows).includes(oldCandidates[0].windowKey)
            ? oldCandidates[0].windowKey
            : crypto.randomUUID());
        newWindows[String(w.id)] = windowKey;
        const tg = groups.filter((g) => g.windowId === w.id);
        const mappedGroups = tg.map((g) => {
          const old = prior?.windows
            .find((p) => p.windowKey === windowKey)
            ?.groups.filter((p) => p.title === g.title && p.color === g.color);
          const groupKey =
            ids.groups[String(g.id)] ||
            (old?.length === 1 ? old[0].groupKey : crypto.randomUUID());
          newGroups[String(g.id)] = groupKey;
          return {
            groupKey,
            title: (g.title || "").slice(0, 1000),
            color: g.color,
            collapsed: g.collapsed,
          };
        });
        const tabs: Tab[] = [];
        for (const t of w.tabs || []) {
          const url = safeUrl(t.url || t.pendingUrl, s.settings);
          if (!url || t.incognito || t.id === undefined) continue;
          let prev = ids.tabs[String(t.id)];
          if (!prev) {
            const matches = prior?.windows
              .find((p) => p.windowKey === windowKey)
              ?.tabs.filter(
                (p) =>
                  p.url === url && p.index === t.index && !used.has(p.tabKey),
              );
            if (matches?.length === 1)
              prev = {
                content: matches[0].content,
                key: matches[0].tabKey,
                origin: matches[0].origin,
                url,
                windowKey,
                index: t.index,
              };
          }
          const key = prev?.key || crypto.randomUUID();
          used.add(key);
          const origin = prev?.origin || { deviceId: s.deviceId, tabKey: key };
          newTabs[String(t.id)] = {
            key,
            origin,
            url,
            windowKey,
            index: t.index,
            content: prev?.url === url ? prev.content : undefined,
          };
          tabs.push({
            content: prev?.url === url ? prev.content : undefined,
            tabKey: key,
            url,
            title: (t.title || url).slice(0, 1000),
            index: t.index,
            pinned: t.pinned,
            groupKey:
              t.groupId !== -1 && !t.pinned
                ? newGroups[String(t.groupId)]
                : undefined,
            origin,
          });
        }
        const active = w.tabs?.find((t) => t.active);
        return {
          windowKey,
          order,
          activeTabKey:
            active?.id !== undefined
              ? newTabs[String(active.id)]?.key
              : undefined,
          groups: mappedGroups.filter((g) =>
            tabs.some((t) => t.groupKey === g.groupKey),
          ),
          tabs,
        };
      });
    // Keep ordinary windows with no safe URLs out of remote workspace; a true empty capture preserves recovery remotely.
    const snap: Snapshot = {
      schemaVersion: 2,
      deviceId: s.deviceId,
      snapshotId: readableSnapshotId(new Date(), s.sync.revision + 1),
      revision: s.sync.revision + 1,
      capturedAt: new Date().toISOString(),
      windows: ws.filter((w) => w.tabs.length),
    };
    s.identities = {
      ...ids,
      tabs: newTabs,
      windows: newWindows,
      groups: newGroups,
    };
    s.current = snap;
    return snap;
  });
}
