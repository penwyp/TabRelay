import { validateSnapshot } from "./model";
import type { Device, Settings, Snapshot, TextRef } from "./types";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT = 15_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LEGACY_HISTORY_FILE = /^\d{12}-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/;
const HUMAN_SNAPSHOT_ID =
  /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z-r(\d{6,12})$/;
const HISTORY_FILE =
  /^(?:\d{12}-[A-Za-z0-9][A-Za-z0-9_-]{0,127}|\d{8}-\d{6}Z-r\d{6,12})\.json$/;
const TEXT_FILE = /^[a-f0-9]{64}\.json$/;
const TEXT_ID = /^[a-f0-9]{64}$/;
const TEXT_MAX_CHARS = 20_000;
const TEXT_MAX_BYTES = 60_000;
const TEXT_ENVELOPE_BYTES = 200_000;
const TEXT_OBJECT_LIMIT = 1000;
type TextObject = { schemaVersion: 1; extractionVersion: 1; text: string };
function historyRevision(filename: string): number {
  return LEGACY_HISTORY_FILE.test(filename)
    ? Number(filename.slice(0, 12))
    : Number(filename.match(/-r(\d{6,12})\.json$/)?.[1] ?? -1);
}
function validHumanSnapshotId(snapshotId: string, revision: number): boolean {
  const match = HUMAN_SNAPSHOT_ID.exec(snapshotId);
  if (!match || Number(match[7]) !== revision) return false;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const date = new Date(iso);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().replace(".000Z", "Z") === iso
  );
}
function textObject(text: string): TextObject {
  if (
    typeof text !== "string" ||
    text.length > TEXT_MAX_CHARS ||
    encoder.encode(text).length > TEXT_MAX_BYTES
  )
    fail("limit", "正文对象超过 20,000 字符或 60,000 字节上限。");
  return { schemaVersion: 1, extractionVersion: 1, text };
}
function validateTextRef(ref: TextRef): void {
  if (
    !ref ||
    typeof ref !== "object" ||
    typeof ref.ownerDeviceId !== "string" ||
    !SAFE_ID.test(ref.ownerDeviceId) ||
    !TEXT_ID.test(ref.objectId) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0 ||
    ref.bytes > TEXT_MAX_BYTES ||
    typeof ref.observedAt !== "string" ||
    !Number.isFinite(Date.parse(ref.observedAt))
  )
    fail("invalid-data", "正文引用结构无效。");
  let url: URL;
  try {
    url = new URL(ref.captureUrl);
  } catch {
    return fail("invalid-data", "正文来源 URL 无效。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    ref.captureUrl.length > 16000
  )
    fail("invalid-data", "正文来源 URL 无效。");
}
function validateContentRefs(snapshot: Snapshot): void {
  for (const window of snapshot.windows) {
    if (!window || !Array.isArray(window.tabs))
      fail("invalid-data", "快照窗口结构无效。");
    for (const tab of window.tabs) {
      if (!tab || typeof tab !== "object")
        fail("invalid-data", "快照标签结构无效。");
      if (tab.content === undefined) continue;
      if (
        snapshot.schemaVersion !== 2 ||
        !tab.content ||
        typeof tab.content !== "object" ||
        ![
          "available",
          "disabled",
          "permission-denied",
          "unavailable",
          "truncated",
        ].includes(tab.content.status) ||
        (tab.content.reason !== undefined &&
          (typeof tab.content.reason !== "string" ||
            tab.content.reason.length > 1000))
      )
        fail("invalid-data", "正文状态或快照版本无效。");
      if (tab.content.ref !== undefined) {
        if (!["available", "truncated"].includes(tab.content.status))
          fail("invalid-data", "此正文状态不能包含引用。");
        validateTextRef(tab.content.ref);
        if (tab.content.ref.captureUrl !== tab.url)
          fail("invalid-data", "正文来源URL与标签不匹配。");
      } else if (
        tab.content.status === "available" ||
        tab.content.status === "truncated"
      )
        fail("invalid-data", "可用正文缺少引用。");
    }
  }
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class WebDAVError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebDAVError";
  }
}

function fail(code: string, message: string): never {
  throw new WebDAVError(code, message);
}
function strongETag(value: string | null): value is string {
  return value !== null && /^"[^"\r\n]*"$/.test(value);
}
function id(value: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value))
    fail("invalid-data", "设备或快照标识无效。");
  return value;
}
function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
function base64ToBytes(value: unknown, maximum: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > maximum * 1.4 + 8 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    fail("invalid-data", "加密快照格式无效。");
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return fail("invalid-data", "加密快照编码无效。");
  }
}
async function keyFor(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 210_000,
      hash: "SHA-256",
    },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Endpoint and HTTP consent must come from trusted local settings, never a snapshot. */
export function normalizeEndpoint(
  value: string,
  httpAcknowledgedOrigin?: string,
): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return fail("configuration", "请输入完整的 HTTP 或 HTTPS WebDAV 地址。");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    fail(
      "configuration",
      "WebDAV 仅支持 HTTP 和 HTTPS，地址不能包含凭据、查询参数或片段。",
    );
  if (
    endpoint.protocol === "http:" &&
    endpoint.origin !== httpAcknowledgedOrigin
  )
    fail(
      "http-consent-required",
      "HTTP 会明文传输 WebDAV 凭据和数据；请先明确确认此服务器地址的风险，或改用 HTTPS。",
    );
  if (/%2f|%5c/i.test(endpoint.pathname))
    fail("configuration", "WebDAV 地址不能包含编码路径分隔符。");
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") + "/";
  return endpoint.href;
}

function xmlText(value: string): string {
  if (/<|>|&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value))
    fail("invalid-data", "WebDAV 目录包含不支持的 XML 数据。");
  return value.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g,
    (_, entity: string) => {
      const known: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      if (known[entity]) return known[entity];
      const point = entity.startsWith("#x")
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (
        !Number.isInteger(point) ||
        point < 32 ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff)
      )
        fail("invalid-data", "WebDAV 目录字符无效。");
      return String.fromCodePoint(point);
    },
  );
}

/** A deliberately narrow DAV href parser. It never expands external entities. */
export function parseDavChildren(xml: string, directory: string): URL[] {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml))
    fail("invalid-data", "不支持含 DTD 或实体定义的 WebDAV 目录。");
  if (!/<(?:[\w.-]+:)?multistatus\b/i.test(xml))
    fail("invalid-data", "WebDAV 未返回有效的目录列表。");
  const base = new URL(directory);
  const children = new Map<string, URL>();
  const hrefs = xml.matchAll(/<((?:[\w.-]+:)?href)\b[^>]*>([^<]*)<\/\1\s*>/gi);
  let count = 0;
  for (const match of hrefs) {
    if (++count > 5000) fail("limit", "WebDAV 目录项目超过安全上限。");
    let child: URL;
    try {
      child = new URL(xmlText(match[2].trim()), base);
    } catch (error) {
      if (error instanceof WebDAVError) throw error;
      fail("invalid-data", "WebDAV 目录地址无效。");
    }
    if (
      child.origin !== base.origin ||
      child.username ||
      child.password ||
      child.search ||
      child.hash ||
      /%2f|%5c/i.test(child.pathname)
    )
      continue;
    if (
      !child.pathname.startsWith(base.pathname) ||
      child.pathname === base.pathname
    )
      continue;
    const remainder = child.pathname
      .slice(base.pathname.length)
      .replace(/\/$/, "");
    if (!remainder || remainder.includes("/")) continue;
    // Decode only a direct child. Resource methods rebuild paths from safe names.
    let name: string;
    try {
      name = decodeURIComponent(remainder);
    } catch {
      continue;
    }
    if (
      !SAFE_ID.test(name) &&
      !HISTORY_FILE.test(name) &&
      !TEXT_FILE.test(name)
    )
      continue;
    children.set(name, child);
  }
  return [...children.values()];
}

export class WebDAVRepository {
  readonly endpoint: string;
  private readonly root: string;
  private readonly timeoutMs: number;
  private readonly shouldContinue: () => boolean;
  constructor(
    private readonly settings: Settings,
    options: { timeoutMs?: number; shouldContinue?: () => boolean } = {},
  ) {
    this.endpoint = normalizeEndpoint(
      settings.endpoint,
      settings.httpAcknowledgedOrigin,
    );
    this.root = `${this.endpoint}tabrelay/v1/`;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT;
    this.shouldContinue = options.shouldContinue ?? (() => true);
    if (settings.username.includes(":"))
      fail("configuration", "WebDAV 用户名不能包含冒号。");
  }

  private async request(
    path: string,
    method = "GET",
    options: {
      body?: string;
      headers?: Record<string, string>;
      allowed?: number[];
      maxBytes?: number;
    } = {},
  ): Promise<{ text: string; etag: string | null; status: number }> {
    if (!this.shouldContinue())
      fail("cancelled", "加载已取消，未发送后续请求。");
    const url = new URL(path, this.endpoint);
    if (
      url.origin !== new URL(this.endpoint).origin ||
      !url.href.startsWith(this.endpoint) ||
      url.username ||
      url.password
    )
      fail("configuration", "拒绝向配置范围以外发送 WebDAV 请求。");
    // Recheck consent before every request, including if settings were revoked
    // while this repository instance was alive. Consent never carries to redirects.
    if (
      url.protocol === "http:" &&
      url.origin !== this.settings.httpAcknowledgedOrigin
    )
      fail(
        "http-consent-required",
        "此 HTTP 服务器尚未确认明文传输风险，已阻止网络请求。",
      );
    if (
      typeof chrome !== "undefined" &&
      chrome.permissions?.contains &&
      !(await chrome.permissions.contains({ origins: [url.origin + "/*"] }))
    )
      fail("permission-denied", "WebDAV主机访问权限已撤销，未发送请求。");
    if (!this.shouldContinue())
      fail("cancelled", "加载已取消，未发送后续请求。");
    const headers: Record<string, string> = { ...options.headers };
    if (this.settings.username || this.settings.password)
      headers.Authorization = `Basic ${bytesToBase64(encoder.encode(`${this.settings.username}:${this.settings.password}`))}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url.href, {
        method,
        headers,
        body: options.body,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      const allowed = options.allowed ?? [200, 201, 204];
      if (!allowed.includes(response.status)) {
        await response.body?.cancel();
        if (response.status === 401)
          fail("unauthorized", "WebDAV 认证失败，请检查用户名及应用专用密码。");
        if (response.status === 403)
          fail("forbidden", "WebDAV 拒绝访问，请检查目录读写权限。");
        if (response.status === 409 || response.status === 412)
          fail(
            "conflict",
            "远端设备快照发生冲突，已暂停发布。请检查是否复制了浏览器 Profile，或生成新的设备身份。",
          );
        if (response.status === 404)
          fail("not-found", "远端快照或目录不存在。");
        if (response.status >= 300 && response.status < 400)
          fail(
            "redirect",
            "WebDAV 重定向被拒绝，请使用最终服务器地址并重新确认 HTTP 风险（如适用）。",
          );
        fail("http", `WebDAV 请求失败（HTTP ${response.status}），可重试。`);
      }
      const maxBytes = options.maxBytes ?? MAX_BYTES;
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxBytes) {
        await response.body?.cancel();
        fail("limit", "WebDAV 响应超过安全大小限制。");
      }
      let size = 0;
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            fail("limit", "WebDAV 响应超过安全大小限制。");
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        return fail("invalid-data", "WebDAV 返回了无效 UTF-8 数据。");
      }
      return {
        text,
        etag: response.headers.get("etag"),
        status: response.status,
      };
    } catch (error) {
      if (error instanceof WebDAVError) throw error;
      if (controller.signal.aborted)
        fail("timeout", "WebDAV 请求超时，待同步快照已保留，可重试。");
      // Browser fetch errors may contain URLs or server text. Never expose them.
      fail(
        "network",
        "WebDAV 连接失败。请检查网络、服务器地址及 HTTPS 证书（如适用）；重定向不会被跟随。",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private devicePath(deviceId: string): string {
    return `${this.root}devices/${id(deviceId)}/`;
  }
  private async directory(path: string): Promise<URL[]> {
    const result = await this.request(path, "PROPFIND", {
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      allowed: [207],
      maxBytes: MAX_DIRECTORY_BYTES,
    });
    return parseDavChildren(result.text, path);
  }
  private async ensureDirectories(deviceId?: string): Promise<void> {
    const directories = [
      `${this.endpoint}tabrelay/`,
      this.root,
      `${this.root}devices/`,
    ];
    if (deviceId)
      directories.push(
        this.devicePath(deviceId),
        `${this.devicePath(deviceId)}history/`,
      );
    for (const path of directories)
      await this.request(path, "MKCOL", { allowed: [201, 204, 405] });
  }
  async connectionTest(): Promise<void> {
    // Read-only check: do not create remote files merely to test credentials.
    await this.directory(this.endpoint);
  }
  async listDevices(
    onIssue?: (issue: {
      deviceId: string;
      code: string;
      message: string;
    }) => void,
  ): Promise<Device[]> {
    let paths: URL[];
    try {
      paths = await this.directory(`${this.root}devices/`);
    } catch (error) {
      if (error instanceof WebDAVError && error.code === "not-found") return [];
      throw error;
    }
    const result: Device[] = [];
    if (paths.length > 200)
      onIssue?.({
        deviceId: "*",
        code: "limit",
        message: "设备目录超过200项，仅检查前200项，覆盖范围不完整。",
      });
    for (const path of paths.slice(0, 200)) {
      if (!this.shouldContinue()) fail("cancelled", "设备枚举已取消。");
      const deviceId = decodeURIComponent(
        path.pathname.replace(/\/$/, "").split("/").pop()!,
      );
      if (!SAFE_ID.test(deviceId)) {
        onIssue?.({
          deviceId: "*",
          code: "invalid-data",
          message: "设备目录含无效标识，已跳过。",
        });
        continue;
      }
      try {
        const response = await this.request(
          `${this.devicePath(deviceId)}device.json`,
          "GET",
          { maxBytes: 32 * 1024 },
        );
        const data = JSON.parse(response.text) as Device;
        if (
          data.deviceId !== deviceId ||
          typeof data.name !== "string" ||
          data.name.length > 200 ||
          typeof data.version !== "string" ||
          data.version.length > 32 ||
          !Number.isFinite(Date.parse(data.updatedAt)) ||
          !Number.isSafeInteger(data.windows) ||
          data.windows < 0 ||
          data.windows > 100 ||
          !Number.isSafeInteger(data.tabs) ||
          data.tabs < 0 ||
          data.tabs > 10_000
        ) {
          onIssue?.({
            deviceId,
            code: "invalid-data",
            message: "设备元数据无效，未加载此设备。",
          });
          continue;
        }
        result.push(data);
      } catch (error) {
        if (onIssue) {
          onIssue({
            deviceId,
            code: error instanceof WebDAVError ? error.code : "invalid-data",
            message: "设备元数据读取失败，未加载此设备。",
          });
          continue;
        }
        if (
          error instanceof WebDAVError &&
          !["not-found", "invalid-data", "limit"].includes(error.code)
        )
          throw error;
        // One corrupt or incomplete device entry must not hide healthy devices.
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async listHistory(deviceId: string): Promise<string[]> {
    const base = `${this.devicePath(deviceId)}history/`;
    let paths: URL[];
    try {
      paths = await this.directory(base);
    } catch (error) {
      if (error instanceof WebDAVError && error.code === "not-found") return [];
      throw error;
    }
    return paths
      .map((path) =>
        decodeURIComponent(path.pathname.slice(new URL(base).pathname.length)),
      )
      .filter((name) => HISTORY_FILE.test(name))
      .sort(
        (a, b) => historyRevision(b) - historyRevision(a) || b.localeCompare(a),
      );
  }
  private textWriteQueue: Promise<unknown> = Promise.resolve();
  private objectIdKeys = new Map<string, Promise<CryptoKey>>();
  private objectIdKeyPassphrase?: string;
  /** Plain stores expose content hashes; encrypted stores use per-device keyed IDs. */
  async textObjectId(deviceId: string, text: string): Promise<string> {
    id(deviceId);
    const canonical = encoder.encode(JSON.stringify(textObject(text)));
    let digest: ArrayBuffer;
    if (!this.settings.encryptionPassphrase) {
      digest = await crypto.subtle.digest("SHA-256", canonical);
    } else {
      if (this.objectIdKeyPassphrase !== this.settings.encryptionPassphrase) {
        this.objectIdKeys.clear();
        this.objectIdKeyPassphrase = this.settings.encryptionPassphrase;
      }
      const domain = `TabRelay/TextObjectId/v1/${deviceId}`;
      let key = this.objectIdKeys.get(domain);
      if (!key) {
        key = (async () => {
          const raw = await crypto.subtle.importKey(
            "raw",
            encoder.encode(this.settings.encryptionPassphrase),
            "PBKDF2",
            false,
            ["deriveKey"],
          );
          return crypto.subtle.deriveKey(
            {
              name: "PBKDF2",
              salt: encoder.encode(domain),
              iterations: 210000,
              hash: "SHA-256",
            },
            raw,
            { name: "HMAC", hash: "SHA-256", length: 256 },
            false,
            ["sign"],
          );
        })();
        this.objectIdKeys.set(domain, key);
      }
      digest = await crypto.subtle.sign("HMAC", await key, canonical);
    }
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  private textPath(deviceId: string, objectId?: string): string {
    const base = `${this.devicePath(deviceId)}objects/text/`;
    if (objectId === undefined) return base;
    if (!TEXT_ID.test(objectId)) fail("invalid-data", "正文对象标识无效。");
    return `${base}${objectId}.json`;
  }
  async inspectTextObjects(
    deviceId: string,
  ): Promise<{ count: number; limit: 1000 }> {
    const path = this.textPath(deviceId);
    let entries: URL[];
    try {
      entries = await this.directory(path);
    } catch (error) {
      if (error instanceof WebDAVError && error.code === "not-found")
        return { count: 0, limit: 1000 };
      throw error;
    }
    const count = entries.filter((entry) =>
      TEXT_FILE.test(
        decodeURIComponent(entry.pathname.slice(new URL(path).pathname.length)),
      ),
    ).length;
    return { count, limit: 1000 };
  }
  private async encodeText(
    deviceId: string,
    objectId: string,
    text: string,
  ): Promise<string> {
    const canonical = JSON.stringify(textObject(text));
    if (!this.settings.encryptionPassphrase) return canonical;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(this.settings.encryptionPassphrase, salt);
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(
          `TabRelay-Text-v1:${deviceId}:${objectId}`,
        ),
      },
      key,
      encoder.encode(canonical),
    );
    return JSON.stringify({
      format: "tabrelay-text-encrypted-v1",
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: 210000,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    });
  }
  private async decodeText(
    body: string,
    deviceId: string,
    objectId: string,
  ): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail("invalid-data", "正文对象不是有效 JSON。");
    }
    if (parsed && typeof parsed === "object" && "format" in parsed) {
      const envelope = parsed as Record<string, unknown>;
      if (
        envelope.format !== "tabrelay-text-encrypted-v1" ||
        envelope.algorithm !== "AES-256-GCM" ||
        envelope.kdf !== "PBKDF2-SHA256" ||
        envelope.iterations !== 210000
      )
        fail("invalid-data", "正文加密格式无效。");
      if (!this.settings.encryptionPassphrase)
        fail("encryption", "正文已加密，请使用相同加密口令。");
      const salt = base64ToBytes(envelope.salt, 16),
        iv = base64ToBytes(envelope.iv, 12),
        ciphertext = base64ToBytes(envelope.ciphertext, TEXT_ENVELOPE_BYTES);
      if (salt.length !== 16 || iv.length !== 12)
        fail("invalid-data", "正文加密参数无效。");
      try {
        const key = await keyFor(this.settings.encryptionPassphrase, salt);
        const plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv as BufferSource,
            additionalData: encoder.encode(
              `TabRelay-Text-v1:${deviceId}:${objectId}`,
            ),
          },
          key,
          ciphertext as BufferSource,
        );
        parsed = JSON.parse(decoder.decode(plain));
      } catch {
        return fail("encryption", "正文解密失败：口令错误或对象已损坏。");
      }
    } else if (this.settings.encryptionPassphrase) {
      fail("encryption", "加密配置下拒绝读取明文正文对象。");
    }
    if (!parsed || typeof parsed !== "object")
      fail("invalid-data", "正文对象结构无效。");
    const data = parsed as TextObject;
    if (
      data.schemaVersion !== 1 ||
      data.extractionVersion !== 1 ||
      typeof data.text !== "string" ||
      Object.keys(data).sort().join(",") !==
        "extractionVersion,schemaVersion,text"
    )
      fail("invalid-data", "正文对象协议或字段无效。");
    textObject(data.text);
    if ((await this.textObjectId(deviceId, data.text)) !== objectId)
      fail("integrity", "正文对象标识校验失败，已拒绝读取。");
    return data.text;
  }
  async readText(ref: TextRef): Promise<string> {
    validateTextRef(ref);
    const response = await this.request(
      this.textPath(ref.ownerDeviceId, ref.objectId),
      "GET",
      { maxBytes: TEXT_ENVELOPE_BYTES },
    );
    const text = await this.decodeText(
      response.text,
      ref.ownerDeviceId,
      ref.objectId,
    );
    if (encoder.encode(text).length !== ref.bytes)
      fail("integrity", "正文引用大小与对象不匹配。");
    return text;
  }
  async writeText(
    deviceId: string,
    text: string,
  ): Promise<{ objectId: string; bytes: number; objectCount: number }> {
    const work = this.textWriteQueue.then(async () => {
      id(deviceId);
      textObject(text);
      const objectId = await this.textObjectId(deviceId, text),
        path = this.textPath(deviceId, objectId);
      await this.ensureDirectories(deviceId);
      for (const directory of [
        `${this.devicePath(deviceId)}objects/`,
        this.textPath(deviceId),
      ])
        await this.request(directory, "MKCOL", { allowed: [201, 204, 405] });
      const existing = await this.request(path, "GET", {
        allowed: [200, 404],
        maxBytes: TEXT_ENVELOPE_BYTES,
      });
      const info = await this.inspectTextObjects(deviceId);
      if (existing.status === 200) {
        if ((await this.decodeText(existing.text, deviceId, objectId)) !== text)
          fail("integrity", "正文对象内容不匹配。");
        return {
          objectId,
          bytes: encoder.encode(text).length,
          objectCount: info.count,
        };
      }
      if (info.count >= TEXT_OBJECT_LIMIT)
        fail(
          "text-limit",
          "此设备已达到 1000 个唯一正文对象上限；不会自动删除历史引用对象。",
        );
      const body = await this.encodeText(deviceId, objectId, text);
      await this.verifiedPut(path, body, { "If-None-Match": "*" });
      const verified = await this.request(path, "GET", {
        maxBytes: TEXT_ENVELOPE_BYTES,
      });
      if ((await this.decodeText(verified.text, deviceId, objectId)) !== text)
        fail("integrity", "正文对象上传校验失败。");
      return {
        objectId,
        bytes: encoder.encode(text).length,
        objectCount: info.count + 1,
      };
    });
    this.textWriteQueue = work.catch(() => {});
    return work;
  }
  private async encode(snapshot: Snapshot): Promise<string> {
    const text = JSON.stringify(snapshot);
    if (encoder.encode(text).length > MAX_BYTES - 1024)
      fail("limit", "快照超过 5 MiB 安全上限。");
    if (!this.settings.encryptionPassphrase) return text;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(this.settings.encryptionPassphrase, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode("TabRelay-v1") },
      key,
      encoder.encode(text),
    );
    const output = JSON.stringify({
      format: "tabrelay-encrypted-v1",
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: 210000,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    });
    if (encoder.encode(output).length > MAX_BYTES)
      fail("limit", "加密后的快照超过 5 MiB 安全上限。");
    return output;
  }
  private async decode(text: string, deviceId: string): Promise<Snapshot> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("invalid-data", "远端快照不是有效 JSON。");
    }
    if (parsed && typeof parsed === "object" && "format" in parsed) {
      const envelope = parsed as Record<string, unknown>;
      if (
        envelope.format !== "tabrelay-encrypted-v1" ||
        envelope.algorithm !== "AES-256-GCM" ||
        envelope.kdf !== "PBKDF2-SHA256" ||
        envelope.iterations !== 210000
      )
        fail("invalid-data", "不支持的加密快照格式。");
      if (!this.settings.encryptionPassphrase)
        fail("encryption", "此快照已加密，请配置相同的加密口令。");
      const salt = base64ToBytes(envelope.salt, 16),
        iv = base64ToBytes(envelope.iv, 12),
        ciphertext = base64ToBytes(envelope.ciphertext, MAX_BYTES);
      if (salt.length !== 16 || iv.length !== 12)
        fail("invalid-data", "加密快照参数无效。");
      try {
        const key = await keyFor(this.settings.encryptionPassphrase, salt);
        const plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv as BufferSource,
            additionalData: encoder.encode("TabRelay-v1"),
          },
          key,
          ciphertext as BufferSource,
        );
        parsed = JSON.parse(decoder.decode(plain));
      } catch {
        fail("encryption", "快照解密失败：口令不一致或远端内容已损坏。");
      }
    }
    if (!parsed || typeof parsed !== "object")
      fail("invalid-data", "远端快照结构无效。");
    const data = parsed as Snapshot;
    if (
      ![1, 2].includes(data.schemaVersion) ||
      data.deviceId !== deviceId ||
      typeof data.snapshotId !== "string" ||
      !SAFE_ID.test(data.snapshotId) ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1 ||
      !Number.isFinite(Date.parse(data.capturedAt)) ||
      !Array.isArray(data.windows) ||
      data.windows.length > 100
    )
      fail("invalid-data", "远端快照版本、身份或结构无效。");
    if (
      data.schemaVersion === 2 &&
      !validHumanSnapshotId(data.snapshotId, data.revision)
    )
      fail("invalid-data", "v2 快照名称与版本不匹配。");
    // A broken body reference must not remove otherwise valid metadata from search/restore.
    return validateSnapshot(data);
  }
  async readSnapshot(
    deviceId: string,
    kind: "current" | "recovery" | "history" = "current",
    historyId?: string,
  ): Promise<Snapshot> {
    let file: string;
    if (kind === "history") {
      if (!historyId || !HISTORY_FILE.test(historyId))
        fail("invalid-data", "历史快照标识无效。");
      file = `history/${historyId}`;
    } else if (kind === "current" || kind === "recovery") file = `${kind}.json`;
    else return fail("invalid-data", "快照类型无效。");
    const response = await this.request(`${this.devicePath(deviceId)}${file}`);
    return this.decode(response.text, deviceId);
  }
  private async current(
    deviceId: string,
  ): Promise<{ snapshot: Snapshot; etag: string | null } | null> {
    const response = await this.request(
      `${this.devicePath(deviceId)}current.json`,
      "GET",
      { allowed: [200, 404] },
    );
    return response.status === 404
      ? null
      : {
          snapshot: await this.decode(response.text, deviceId),
          etag: response.etag,
        };
  }
  private async verifiedPut(
    path: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<string> {
    await this.request(path, "PUT", {
      body,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...headers,
      },
    });
    const result = await this.request(path);
    if (result.text !== body)
      fail("conflict", "发布后校验发现远端内容已变化，已暂停发布。");
    if (!strongETag(result.etag))
      fail(
        "etag-required",
        "服务器必须提供强 ETag 才能安全同步，请选择支持条件写入的 WebDAV 服务。",
      );
    return result.etag;
  }
  async publish(
    snapshot: Snapshot,
    device: Device,
    expectedEtag?: string | null,
  ): Promise<{ etag: string | null }> {
    id(snapshot.deviceId);
    id(snapshot.snapshotId);
    if (
      snapshot.schemaVersion === 2 &&
      !validHumanSnapshotId(snapshot.snapshotId, snapshot.revision)
    )
      fail("invalid-data", "v2 快照名称与版本不匹配。");
    validateContentRefs(snapshot);
    if (
      snapshot.deviceId !== device.deviceId ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 1 ||
      snapshot.revision > 999_999_999_999
    )
      fail("invalid-data", "待发布快照身份或版本无效。");
    const base = this.devicePath(snapshot.deviceId);
    await this.ensureDirectories(snapshot.deviceId);
    const remote = await this.current(snapshot.deviceId);
    const same =
      remote !== null &&
      JSON.stringify(remote.snapshot) === JSON.stringify(snapshot);
    if (remote && !strongETag(remote.etag))
      fail("etag-required", "服务器缺少强 ETag，无法安全更新设备快照。");
    if (
      !same &&
      remote &&
      (expectedEtag === undefined ||
        expectedEtag === null ||
        remote.etag !== expectedEtag)
    )
      fail(
        "conflict",
        "设备身份已被其他实例写入，已暂停同步。请检查 Profile 副本或生成新的设备身份。",
      );
    if (!same && !remote && expectedEtag !== undefined)
      fail("conflict", "远端设备快照已删除，已暂停同步以避免覆盖未知状态。");
    if (!same && remote && snapshot.revision <= remote.snapshot.revision)
      fail("conflict", "待发布版本未递增，已暂停同步。");
    const encoded = await this.encode(snapshot);
    const historyName =
      snapshot.schemaVersion === 2
        ? `${snapshot.snapshotId}.json`
        : `${String(snapshot.revision).padStart(12, "0")}-${snapshot.snapshotId}.json`;
    const historyPath = `${base}history/${historyName}`;
    // Immutable staging doubles as history. Never unsafe MOVE over current.json:
    // If-Match on a MOVE source does not protect the destination against a writer.
    const history = await this.request(historyPath, "GET", {
      allowed: [200, 404],
    });
    let stableBody = encoded;
    if (history.status === 200) {
      const prior = await this.decode(history.text, snapshot.deviceId);
      if (JSON.stringify(prior) !== JSON.stringify(snapshot))
        fail("conflict", "同名历史快照内容不同，已拒绝覆盖。");
      stableBody = history.text;
    } else {
      await this.verifiedPut(historyPath, encoded, { "If-None-Match": "*" });
    }
    let etag = remote?.etag ?? null;
    if (!same)
      etag = await this.verifiedPut(
        `${base}current.json`,
        stableBody,
        remote ? { "If-Match": remote.etag! } : { "If-None-Match": "*" },
      );
    if (!strongETag(etag))
      fail("etag-required", "服务器没有返回可用于安全条件写入的强 ETag。");
    // These files are not a multi-resource transaction. Read auxiliary state first,
    // then recheck the authoritative current pointer before each conditional write.
    // Otherwise a stale writer could GET a newer recovery/device ETag and use that
    // fresh ETag to overwrite the newer data with its own older snapshot.
    const assertCurrentOwnership = async (): Promise<void> => {
      const latest = await this.current(snapshot.deviceId);
      if (
        !latest ||
        latest.etag !== etag ||
        JSON.stringify(latest.snapshot) !== JSON.stringify(snapshot)
      )
        fail("conflict", "发布期间检测到另一写入者，已暂停同步。");
    };
    await assertCurrentOwnership();
    if (snapshot.windows.some((window) => window.tabs.length > 0)) {
      const recovery = await this.request(`${base}recovery.json`, "GET", {
        allowed: [200, 404],
      });
      if (recovery.status === 200) {
        if (!strongETag(recovery.etag))
          fail("etag-required", "恢复点缺少强 ETag，已拒绝不安全覆盖。");
        const priorRecovery = await this.decode(
          recovery.text,
          snapshot.deviceId,
        );
        if (
          priorRecovery.revision > snapshot.revision ||
          (priorRecovery.revision === snapshot.revision &&
            JSON.stringify(priorRecovery) !== JSON.stringify(snapshot))
        )
          fail("conflict", "恢复点包含更新或冲突的版本，已拒绝覆盖。");
      }
      await assertCurrentOwnership();
      await this.verifiedPut(
        `${base}recovery.json`,
        stableBody,
        recovery.status === 404
          ? { "If-None-Match": "*" }
          : { "If-Match": recovery.etag! },
      );
    }
    const metadata = await this.request(`${base}device.json`, "GET", {
      allowed: [200, 404],
      maxBytes: 32 * 1024,
    });
    if (metadata.status === 200 && !strongETag(metadata.etag))
      fail("etag-required", "设备信息缺少强 ETag，已拒绝不安全覆盖。");
    await assertCurrentOwnership();
    await this.verifiedPut(
      `${base}device.json`,
      JSON.stringify(device),
      metadata.status === 404
        ? { "If-None-Match": "*" }
        : { "If-Match": metadata.etag! },
    );
    const historyFiles = await this.listHistory(snapshot.deviceId);
    const limit = Math.max(
      1,
      Math.min(100, Math.trunc(this.settings.historyLimit) || 20),
    );
    // Only delete this device's validated immutable history filenames, never current/recovery.
    for (const file of historyFiles.slice(limit)) {
      const old = await this.request(`${base}history/${file}`, "GET", {
        allowed: [200, 404],
      });
      if (old.status === 200 && strongETag(old.etag))
        await this.request(`${base}history/${file}`, "DELETE", {
          headers: { "If-Match": old.etag },
          allowed: [200, 204, 404],
        });
    }
    await assertCurrentOwnership();
    return { etag };
  }
}
