import { build } from "esbuild";
import fs from "node:fs/promises";
const testing = process.argv.includes("--test");
const out = testing ? "dist-test" : "dist";
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
await build({
  entryPoints: [
    "src/background.ts",
    "src/sidepanel.ts",
    "src/popup.ts",
    "src/options.ts",
    "src/search-ui.ts",
  ],
  bundle: true,
  outdir: out,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
});
await fs.cp("public", out, { recursive: true });
const manifest = {
  manifest_version: 3,
  name: "TabRelay",
  version: "2.0.0",
  description:
    "通过 WebDAV 接力多设备标签与标签组，保留本机窗口，安全合并恢复。",
  minimum_chrome_version: "120",
  permissions: [
    "tabs",
    "tabGroups",
    "storage",
    "alarms",
    ...(testing ? ["scripting"] : []),
  ],
  optional_permissions: testing ? [] : ["scripting"],
  optional_host_permissions: ["https://*/*", "http://*/*"],
  ...(testing
    ? { host_permissions: ["http://127.0.0.1/*", "https://127.0.0.1/*"] }
    : {}),
  background: { service_worker: "background.js", type: "module" },
  options_ui: { page: "options.html", open_in_tab: true },
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  action: {
    default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" },
    default_title: "打开 TabRelay",
    default_popup: "popup.html",
  },
  incognito: "not_allowed",
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
  },
};
await fs.writeFile(out + "/manifest.json", JSON.stringify(manifest, null, 2));
console.log("Built dist/ (Chrome 120+)");
