import { DEFAULT_SETTINGS } from "./model";
import type { AppState } from "./types";
let queue: Promise<unknown> = Promise.resolve();
export async function load(): Promise<AppState> {
  const result = await chrome.storage.local.get("state");
  if (result.state) {
    const state = result.state as AppState;
    state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
    return state;
  }
  const state: AppState = {
    deviceId: crypto.randomUUID(),
    settings: { ...DEFAULT_SETTINGS },
    sync: { dirty: true, generation: 0, revision: 0, retryCount: 0 },
    identities: {
      browserSession: crypto.randomUUID(),
      tabs: {},
      windows: {},
      groups: {},
    },
  };
  await chrome.storage.local.set({ state });
  return state;
}
export function update<T>(fn: (state: AppState) => T | Promise<T>): Promise<T> {
  const p = queue.then(async () => {
    const s = await load();
    const r = await fn(s);
    await chrome.storage.local.set({ state: s });
    return r;
  });
  queue = p.catch(() => {});
  return p;
}
export async function dirty() {
  await update((s) => {
    s.sync.dirty = true;
    s.sync.generation++;
  });
}
