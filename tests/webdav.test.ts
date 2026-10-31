import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeEndpoint,
  parseDavChildren,
  WebDAVError,
  WebDAVRepository,
} from "../src/webdav";
import type { Device, Settings, Snapshot } from "../src/types";

const settings: Settings = {
  endpoint: "https://dav.example/base/",
  username: "user",
  password: "secret-password",
  deviceName: "Laptop",
  enabled: true,
  blacklist: [],
  stripParams: [],
  historyLimit: 2,
  encryptionPassphrase: "",
};
const snapshot = (revision = 1): Snapshot => ({
  schemaVersion: 1,
  deviceId: "device-A",
  snapshotId: `snap-${revision}`,
  revision,
  capturedAt: "2026-10-31T10:00:00Z",
  windows: [
    {
      windowKey: "window-A",
      order: 0,
      groups: [],
      tabs: [
        {
          tabKey: "tab-A",
          url: "https://example.org/",
          title: "Example",
          index: 0,
          pinned: false,
          origin: { deviceId: "device-A", tabKey: "tab-A" },
        },
      ],
    },
  ],
});
const device: Device = {
  deviceId: "device-A",
  name: "Laptop",
  version: "1.0.0",
  updatedAt: "2026-10-31T10:00:00Z",
  windows: 1,
  tabs: 1,
};
function dav() {
  const files = new Map<string, { body: string; etag: string }>();
  let sequence = 0;
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input),
      method = init.method ?? "GET",
      headers = new Headers(init.headers),
      body = String(init.body ?? "");
    calls.push({ url, method, headers, body });
    const file = files.get(url);
    if (method === "MKCOL") return new Response(null, { status: 201 });
    if (method === "PROPFIND") {
      const names = new Set(
        [...files.keys()]
          .filter((key) => key.startsWith(url))
          .map((key) => key.slice(url.length).split("/")[0]),
      );
      const xml =
        '<d:multistatus xmlns:d="DAV:">' +
        [...names]
          .map(
            (name) =>
              `<d:response><d:href>${new URL(url).pathname}${name}${[...files.keys()].some((key) => key.startsWith(url + name + "/")) ? "/" : ""}</d:href></d:response>`,
          )
          .join("") +
        "</d:multistatus>";
      return new Response(xml, { status: 207 });
    }
    if (method === "GET")
      return file
        ? new Response(file.body, { status: 200, headers: { etag: file.etag } })
        : new Response(null, { status: 404 });
    if (method === "PUT") {
      if (
        (headers.get("if-none-match") === "*" && file) ||
        (headers.has("if-match") && headers.get("if-match") !== file?.etag)
      )
        return new Response(null, { status: 412 });
      const etag = `"etag-${++sequence}"`;
      files.set(url, { body, etag });
      return new Response(null, { status: 201, headers: { etag } });
    }
    if (method === "DELETE") {
      if (headers.has("if-match") && headers.get("if-match") !== file?.etag)
        return new Response(null, { status: 412 });
      files.delete(url);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { files, calls, fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("endpoint and directory security", () => {
  it("normalizes HTTPS endpoint without path ambiguity", () =>
    expect(normalizeEndpoint("https://dav.example/base")).toBe(
      "https://dav.example/base/",
    ));
  it.each([
    "http://dav.example/",
    "https://user:pass@dav.example/",
    "https://dav.example/?token=secret",
    "https://dav.example/#fragment",
    "https://dav.example/a%2Fb/",
  ])("rejects unsafe endpoint %s", (value) =>
    expect(() => normalizeEndpoint(value)).toThrow(WebDAVError),
  );
  it("ignores cross-origin, traversal, nested, credential and encoded-separator hrefs", () => {
    const xml =
      '<d:multistatus xmlns:d="DAV:">' +
      [
        "/base/tabrelay/v1/devices/device-A/",
        "https://evil.example/device-B/",
        "../../../../secrets/",
        "/base/tabrelay/v1/devices/device-A/nested/",
        "https://u:p@dav.example/base/tabrelay/v1/devices/device-C/",
        "/base/tabrelay/v1/devices/device%2FD/",
      ]
        .map((href) => `<d:response><d:href>${href}</d:href></d:response>`)
        .join("") +
      "</d:multistatus>";
    expect(
      parseDavChildren(
        xml,
        "https://dav.example/base/tabrelay/v1/devices/",
      ).map((url) => url.pathname),
    ).toEqual(["/base/tabrelay/v1/devices/device-A/"]);
  });
  it("rejects DTD and entity declarations without expansion", () =>
    expect(() =>
      parseDavChildren(
        '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><multistatus><href>&x;</href></multistatus>',
        "https://dav.example/",
      ),
    ).toThrow());
  it("rejects arbitrary non-DAV response", () =>
    expect(() =>
      parseDavChildren("<html>login</html>", "https://dav.example/"),
    ).toThrow());
});

describe("WebDAV publication and failure behavior", () => {
  it("publishes independently and verifies conditional writes", async () => {
    const server = dav(),
      repo = new WebDAVRepository(settings),
      result = await repo.publish(snapshot(), device);
    expect(result.etag).toMatch(/^"etag-/);
    const writes = server.calls.filter((call) => call.method === "PUT");
    expect(writes.map((call) => call.url.split("/").pop())).toEqual([
      "000000000001-snap-1.json",
      "current.json",
      "recovery.json",
      "device.json",
    ]);
    expect(
      writes.every((call) => call.headers.get("if-none-match") === "*"),
    ).toBe(true);
    expect(server.calls.some((call) => call.method === "MOVE")).toBe(false);
    expect(await repo.readSnapshot("device-A")).toEqual(snapshot());
    expect(await repo.listDevices()).toEqual([device]);
    expect(await repo.listHistory("device-A")).toEqual([
      "000000000001-snap-1.json",
    ]);
  });
  it("never follows redirects or sends browser cookies", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      throw new TypeError("https://evil.example/secret-password");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new WebDAVRepository(settings).connectionTest(),
    ).rejects.toMatchObject({ code: "network" });
    try {
      await new WebDAVRepository(settings).connectionTest();
    } catch (error) {
      expect(String(error)).not.toContain("secret-password");
      expect(String(error)).not.toContain("evil.example");
    }
  });
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [412, "conflict"],
    [500, "http"],
  ])("reports HTTP %s without leaking response body", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("secret-password", { status: Number(status) }),
      ),
    );
    await expect(
      new WebDAVRepository(settings).connectionTest(),
    ).rejects.toMatchObject({ code });
  });
  it("first writer refuses an existing device identity", async () => {
    const server = dav(),
      repo = new WebDAVRepository(settings);
    await repo.publish(snapshot(), device);
    const before = server.files.get(
      settings.endpoint + "tabrelay/v1/devices/device-A/current.json",
    );
    await expect(repo.publish(snapshot(2), device)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      server.files.get(
        settings.endpoint + "tabrelay/v1/devices/device-A/current.json",
      ),
    ).toEqual(before);
  });
  it("updates current only with expected ETag and rejects stale writers", async () => {
    dav();
    const repo = new WebDAVRepository(settings),
      first = await repo.publish(snapshot(), device);
    const second = await repo.publish(snapshot(2), device, first.etag);
    expect(second.etag).not.toBe(first.etag);
    await expect(
      repo.publish(snapshot(3), device, first.etag),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("conditional PUT rejects a writer that races after preflight", async () => {
    const server = dav(),
      repo = new WebDAVRepository(settings),
      first = await repo.publish(snapshot(), device);
    const original = server.fetchMock.getMockImplementation()!;
    server.fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/current.json") && init?.method === "PUT")
        server.files.set(String(url), {
          body: JSON.stringify(snapshot(8)),
          etag: '\"racer\"',
        });
      return original(url, init);
    });
    await expect(
      repo.publish(snapshot(2), device, first.etag),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      JSON.parse(
        server.files.get(
          settings.endpoint + "tabrelay/v1/devices/device-A/current.json",
        )!.body,
      ).revision,
    ).toBe(8);
  });
  it("safely retries a previously committed identical pending snapshot", async () => {
    dav();
    const repo = new WebDAVRepository(settings);
    const first = await repo.publish(snapshot(), device);
    const again = await repo.publish(snapshot(), device);
    expect(again.etag).toBe(first.etag);
    expect((await repo.listHistory("device-A")).length).toBe(1);
  });
  it("does not overwrite last nonempty recovery when current is empty", async () => {
    dav();
    const repo = new WebDAVRepository(settings),
      first = await repo.publish(snapshot(), device);
    const empty = { ...snapshot(2), windows: [] };
    await repo.publish(empty, { ...device, windows: 0, tabs: 0 }, first.etag);
    expect((await repo.readSnapshot("device-A")).windows).toEqual([]);
    expect(await repo.readSnapshot("device-A", "recovery")).toEqual(snapshot());
  });
  it("keeps a bounded immutable history and never deletes recovery", async () => {
    const server = dav(),
      repo = new WebDAVRepository(settings);
    let etag: string | null | undefined;
    for (let revision = 1; revision <= 4; revision++)
      etag = (await repo.publish(snapshot(revision), device, etag)).etag;
    expect(await repo.listHistory("device-A")).toEqual([
      "000000000004-snap-4.json",
      "000000000003-snap-3.json",
    ]);
    expect(
      server.calls
        .filter((call) => call.method === "DELETE")
        .every(
          (call) =>
            call.url.includes("/history/") && call.headers.has("if-match"),
        ),
    ).toBe(true);
    expect(
      await repo.readSnapshot(
        "device-A",
        "history",
        "000000000003-snap-3.json",
      ),
    ).toEqual(snapshot(3));
  });
  it("refuses path injection for device and history identifiers", async () => {
    const server = dav(),
      repo = new WebDAVRepository(settings);
    await expect(repo.readSnapshot("../secret")).rejects.toMatchObject({
      code: "invalid-data",
    });
    await expect(
      repo.readSnapshot("device-A", "history", "../../secret"),
    ).rejects.toMatchObject({ code: "invalid-data" });
    expect(server.calls.length).toBe(0);
  });
  it("fails closed if server does not provide strong ETags", async () => {
    const server = dav();
    const original = server.fetchMock.getMockImplementation()!;
    server.fetchMock.mockImplementation(async (...args) => {
      const result = await original(...args);
      result.headers.delete("etag");
      return result;
    });
    await expect(
      new WebDAVRepository(settings).publish(snapshot(), device),
    ).rejects.toMatchObject({ code: "etag-required" });
  });
  it("bounds the response before JSON decoding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(6 * 1024 * 1024) },
          }),
      ),
    );
    await expect(
      new WebDAVRepository(settings).readSnapshot("device-A"),
    ).rejects.toMatchObject({ code: "limit" });
  });
  it("times out an interrupted network request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      ),
    );
    await expect(
      new WebDAVRepository(settings, { timeoutMs: 10 }).connectionTest(),
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it("stops credentialed metadata enumeration after cancellation", async () => {
    let enabled = true;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push(String(url));
        if (init.method === "PROPFIND")
          return new Response(
            '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/base/tabrelay/v1/devices/device-A/</d:href></d:response><d:response><d:href>/base/tabrelay/v1/devices/device-B/</d:href></d:response></d:multistatus>',
            { status: 207 },
          );
        enabled = false;
        return new Response(JSON.stringify(device), { status: 200 });
      }),
    );
    await expect(
      new WebDAVRepository(settings, {
        shouldContinue: () => enabled,
      }).listDevices(() => {}),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(requests).toHaveLength(2);
    expect(requests.some((url) => url.includes("device-B"))).toBe(false);
  });
  it("reports corrupt device metadata and enumeration cap for search coverage", async () => {
    const issues: { deviceId: string; code: string; message: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "PROPFIND")
          return new Response(
            '<d:multistatus xmlns:d="DAV:">' +
              Array.from(
                { length: 201 },
                (_, i) =>
                  `<d:response><d:href>/base/tabrelay/v1/devices/device-${i}/</d:href></d:response>`,
              ).join("") +
              "</d:multistatus>",
            { status: 207 },
          );
        return new Response("invalid-json", { status: 200 });
      }),
    );
    expect(
      await new WebDAVRepository(settings).listDevices((issue) =>
        issues.push(issue),
      ),
    ).toEqual([]);
    expect(issues.filter((issue) => issue.code === "limit")).toHaveLength(1);
    expect(
      issues.filter((issue) => issue.code === "invalid-data"),
    ).toHaveLength(200);
    expect(JSON.stringify(issues)).not.toContain(settings.password);
  });
  it("handles missing device directory as no devices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await new WebDAVRepository(settings).listDevices()).toEqual([]);
  });
  it("rejects snapshot identity mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...snapshot(), deviceId: "device-B" })),
      ),
    );
    await expect(
      new WebDAVRepository(settings).readSnapshot("device-A"),
    ).rejects.toMatchObject({ code: "invalid-data" });
  });
  it("authenticates encrypts snapshots without exposing URLs and rejects wrong passphrase", async () => {
    const server = dav(),
      repo = new WebDAVRepository({
        ...settings,
        encryptionPassphrase: "correct horse battery staple",
      });
    await repo.publish(snapshot(), device);
    const raw = server.files.get(
      settings.endpoint + "tabrelay/v1/devices/device-A/current.json",
    )!.body;
    expect(raw).not.toContain("example.org");
    expect(raw).toContain("tabrelay-encrypted-v1");
    expect(await repo.readSnapshot("device-A")).toEqual(snapshot());
    await expect(
      new WebDAVRepository({
        ...settings,
        encryptionPassphrase: "wrong",
      }).readSnapshot("device-A"),
    ).rejects.toMatchObject({ code: "encryption" });
    await expect(
      new WebDAVRepository(settings).readSnapshot("device-A"),
    ).rejects.toMatchObject({ code: "encryption" });
  });
  it.each(["recovery.json", "device.json"])(
    "does not overwrite a newer writer's %s after auxiliary GET",
    async (target) => {
      const server = dav();
      const repo = new WebDAVRepository(settings);
      const first = await repo.publish(snapshot(), device);
      const original = server.fetchMock.getMockImplementation()!;
      const base = settings.endpoint + "tabrelay/v1/devices/device-A/";
      let injected = false;
      server.fetchMock.mockImplementation(async (url, init) => {
        if (
          !injected &&
          String(url) === base + target &&
          init?.method === "GET"
        ) {
          injected = true;
          server.files.set(base + "current.json", {
            body: JSON.stringify(snapshot(3)),
            etag: '\"new-current\"',
          });
          server.files.set(base + target, {
            body: JSON.stringify(
              target === "recovery.json"
                ? snapshot(3)
                : {
                    ...device,
                    name: "New writer",
                    updatedAt: "2026-10-31T11:00:00Z",
                  },
            ),
            etag: '\"new-auxiliary\"',
          });
        }
        return original(url, init);
      });
      await expect(
        repo.publish(snapshot(2), device, first.etag),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(injected).toBe(true);
      expect(server.files.get(base + target)?.etag).toBe('\"new-auxiliary\"');
      expect(
        JSON.parse(server.files.get(base + "current.json")!.body).revision,
      ).toBe(3);
    },
  );
  it("rejects a newer recovery revision even if current was externally rolled back", async () => {
    const server = dav();
    const repo = new WebDAVRepository(settings);
    const first = await repo.publish(snapshot(), device);
    const path =
      settings.endpoint + "tabrelay/v1/devices/device-A/recovery.json";
    server.files.set(path, {
      body: JSON.stringify(snapshot(9)),
      etag: '\"new-recovery\"',
    });
    await expect(
      repo.publish(snapshot(2), device, first.etag),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(JSON.parse(server.files.get(path)!.body).revision).toBe(9);
  });
  it("accepts arbitrary HTTP only with exact origin consent", async () => {
    const server = dav();
    const httpSettings = {
      ...settings,
      endpoint: "http://dav.office.example:8080/base/",
      httpAcknowledgedOrigin: "http://dav.office.example:8080",
    };
    const repo = new WebDAVRepository(httpSettings);
    await repo.connectionTest();
    expect(server.calls[0].url).toBe(httpSettings.endpoint);
    expect(server.calls[0].headers.get("authorization")).toMatch(/^Basic /);
    expect(
      normalizeEndpoint(
        httpSettings.endpoint,
        httpSettings.httpAcknowledgedOrigin,
      ),
    ).toBe(httpSettings.endpoint);
  });
  it.each([
    undefined,
    "http://other.example:8080",
    "http://dav.office.example",
    "https://dav.office.example:8080",
    "http://dav.office.example:8080/base/",
  ])(
    "rejects HTTP before fetch with absent or mismatched consent %s",
    (consent) => {
      const server = dav();
      expect(
        () =>
          new WebDAVRepository({
            ...settings,
            endpoint: "http://dav.office.example:8080/base/",
            httpAcknowledgedOrigin: consent,
          }),
      ).toThrowError(
        expect.objectContaining({ code: "http-consent-required" }),
      );
      expect(server.calls).toHaveLength(0);
    },
  );
  it("rechecks HTTP consent before network access after revocation", async () => {
    const server = dav();
    const httpSettings = {
      ...settings,
      endpoint: "http://dav.office.example/base/",
      httpAcknowledgedOrigin: "http://dav.office.example",
    };
    const repo = new WebDAVRepository(httpSettings);
    httpSettings.httpAcknowledgedOrigin = "";
    await expect(repo.connectionTest()).rejects.toMatchObject({
      code: "http-consent-required",
    });
    expect(server.calls).toHaveLength(0);
  });
  it("does not follow HTTP redirects or transfer acknowledged consent to another host", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return new Response(null, {
        status: 307,
        headers: { location: "http://evil.example/stolen" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = new WebDAVRepository({
      ...settings,
      endpoint: "http://dav.office.example/base/",
      httpAcknowledgedOrigin: "http://dav.office.example",
    });
    await expect(repo.connectionTest()).rejects.toMatchObject({
      code: "redirect",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://dav.office.example/base/");
  });
});
