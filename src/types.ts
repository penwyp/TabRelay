export type Origin = { deviceId: string; tabKey: string };
export type Tab = {
  tabKey: string;
  url: string;
  title: string;
  index: number;
  pinned: boolean;
  groupKey?: string;
  origin: Origin;
};
export type Group = {
  groupKey: string;
  title: string;
  color:
    | "grey"
    | "blue"
    | "red"
    | "yellow"
    | "green"
    | "pink"
    | "purple"
    | "cyan"
    | "orange";
  collapsed: boolean;
};
export type WorkspaceWindow = {
  windowKey: string;
  order: number;
  activeTabKey?: string;
  groups: Group[];
  tabs: Tab[];
};
export type Snapshot = {
  schemaVersion: 1;
  deviceId: string;
  snapshotId: string;
  revision: number;
  capturedAt: string;
  windows: WorkspaceWindow[];
};
export type Settings = {
  /** Explicit HTTP plaintext-risk acknowledgment, bound to configured origin. */
  httpAcknowledgedOrigin?: string;
  endpoint: string;
  username: string;
  password: string;
  deviceName: string;
  enabled: boolean;
  blacklist: string[];
  stripParams: string[];
  historyLimit: number;
  encryptionPassphrase: string;
};
export type Device = {
  deviceId: string;
  name: string;
  version: string;
  updatedAt: string;
  windows: number;
  tabs: number;
};
export type Selection = {
  windowKeys?: string[];
  groupKeys?: string[];
  tabKeys?: string[];
};
export type Plan = {
  id: string;
  snapshot: Snapshot;
  windows: WorkspaceWindow[];
  skipped: { title: string; reason: string }[];
  existingWindows: number;
  fingerprint: string;
  createdAt: string;
};
export type CreatedTab = {
  sourceTabKey: string;
  tabId: number;
  windowId: number;
  expectedUrl: string;
  localTabKey: string;
  origin: Origin;
};
export type RestoreOperation = {
  browserSession?: string;
  id: string;
  plan: Plan;
  status:
    | "PREPARED"
    | "RUNNING"
    | "INTERRUPTED"
    | "CANCELLED"
    | "COMPLETED"
    | "ROLLED_BACK";
  createdWindows: { sourceWindowKey: string; windowId: number }[];
  createdTabs: CreatedTab[];
  failures: { tabKey: string; reason: string }[];
  nextIndex: number;
  uncertain?: {
    kind: "window" | "tab";
    sourceWindowKey: string;
    sourceTabKey: string;
    url: string;
    beforeIds: number[];
  };
  startedAt: string;
  updatedAt: string;
  syncStatus: "pending" | "synced";
  error?: string;
};
export type RuntimeIdentity = {
  browserSession: string;
  tabs: Record<
    string,
    {
      key: string;
      origin: Origin;
      url: string;
      windowKey: string;
      index: number;
    }
  >;
  windows: Record<string, string>;
  groups: Record<string, string>;
};
export type SyncState = {
  dirty: boolean;
  generation: number;
  revision: number;
  lastHash?: string;
  lastSuccess?: string;
  error?: string;
  errorCode?: string;
  pending?: Snapshot;
  etag?: string | null;
  pausedConflict?: boolean;
  retryCount: number;
};
export type AppState = {
  deviceId: string;
  settings: Settings;
  sync: SyncState;
  current?: Snapshot;
  operation?: RestoreOperation;
  identities: RuntimeIdentity;
};
