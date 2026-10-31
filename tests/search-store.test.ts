import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSearchStore,
  readSearchStore,
  writeSearchStore,
  SEARCH_DB_NAME,
  SEARCH_DB_STORE,
} from "../src/search-store";
let session: Record<string, any>;
const cache = (text = "私密正文 Secret body", generation = 1) => ({
  generation,
  sources: [
    {
      id: "source-A",
      deviceId: "device-A",
      kind: "current",
      snapshot: {
        schemaVersion: 2,
        snapshotId: "snapshot-1",
        windows: [
          {
            tabs: [
              {
                url: "https://private.example/research",
                title: "Sensitive title",
              },
            ],
          },
        ],
      },
    },
  ],
  bodies: {
    "device-A:object-A": { text, identity: "digest-A", status: "loaded" },
  },
});
async function records(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SEARCH_DB_NAME, 1);
    request.onsuccess = () => {
      const db = request.result;
      const get = db
        .transaction(SEARCH_DB_STORE, "readonly")
        .objectStore(SEARCH_DB_STORE)
        .getAll();
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
      get.onerror = () => reject(get.error);
    };
    request.onerror = () => reject(request.error);
  });
}
beforeEach(async () => {
  session = {};
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: structuredClone(session[key]),
        })),
        set: vi.fn(async (values: Record<string, any>) => {
          Object.assign(session, structuredClone(values));
        }),
      },
    },
  });
  await clearSearchStore();
});
describe("encrypted scalable search store", () => {
  it("persists only ciphertext, random record IDs and small session refs", async () => {
    const input = cache();
    const result = await writeSearchStore(input);
    expect(result.records).toBe(2);
    const saved = await records();
    expect(saved).toHaveLength(2);
    for (const item of saved) {
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(item.ciphertext).toBeInstanceOf(ArrayBuffer);
      expect(new TextDecoder().decode(item.ciphertext)).not.toContain(
        "Secret body",
      );
      expect(JSON.stringify(item)).not.toContain("private.example");
    }
    const manifest = JSON.stringify(session.searchCache);
    expect(manifest).not.toContain("Sensitive title");
    expect(manifest).not.toContain("Secret body");
    expect(manifest).not.toContain("private.example");
    expect(manifest.length).toBeLessThan(2000);
    expect(await readSearchStore()).toEqual(input);
  });
  it("reuses identical canonical snapshots and bodies across versions and only writes changed records", async () => {
    const first = cache();
    await writeSearchStore(first);
    const ids = (await records()).map((item) => item.id).sort();
    const second = {
      ...first,
      generation: 2,
      sources: [
        ...first.sources,
        {
          ...first.sources[0],
          id: "new-source",
          kind: "history",
          snapshot: structuredClone(first.sources[0].snapshot),
        },
      ],
      bodies: {
        ...first.bodies,
        "other-owner:same-body": structuredClone(
          first.bodies["device-A:object-A"],
        ),
      },
    };
    const result = await writeSearchStore(second);
    expect(result.records).toBe(2);
    expect((await records()).map((item) => item.id).sort()).toEqual(ids);
    second.bodies["other-owner:same-body"] = {
      text: "Changed body",
      identity: "digest-B",
      status: "loaded",
    };
    const changed = await writeSearchStore(second);
    expect(changed.records).toBe(3);
    expect(
      (await records()).filter((item) => ids.includes(item.id)),
    ).toHaveLength(2);
  });
  it("stores 100 distinct maximum Chinese bodies beyond the old 3MiB budget", async () => {
    const base = cache();
    base.bodies = {};
    for (let index = 0; index < 100; index++) {
      const text = "中".repeat(19990) + String(index).padStart(10, "0");
      base.bodies[`owner:${index}`] = {
        text,
        identity: `digest-${index}`,
        status: "loaded",
      };
    }
    const result = await writeSearchStore(base);
    expect(result.bytes).toBeGreaterThan(6_000_000);
    expect(result.records).toBe(101);
    const restored = await readSearchStore<typeof base>();
    expect(restored?.bodies["owner:99"].text).toContain("0000000099");
    expect(JSON.stringify(session.searchCache).length).toBeLessThan(100_000);
  });
  it("clear destroys ciphertext and key and cannot be undone by an already queued write", async () => {
    await writeSearchStore(cache());
    const pending = writeSearchStore(cache("Pending"));
    const cleared = clearSearchStore();
    await expect(pending).rejects.toThrow("取消");
    await cleared;
    expect(await records()).toEqual([]);
    expect(session.searchIndexKey).toBeNull();
    expect(await readSearchStore()).toBeUndefined();
  });
  it("a full browser session loss purges old ciphertext before serving empty state", async () => {
    await writeSearchStore(cache());
    expect((await records()).length).toBe(2);
    session = {};
    expect(await readSearchStore()).toBeUndefined();
    expect(await records()).toEqual([]);
  });
  it("session manifest failure never reports success or corrupts the previous readable cache", async () => {
    const first = cache();
    await writeSearchStore(first);
    const original = chrome.storage.session.set as any;
    original.mockImplementationOnce(async () => {
      throw Error("simulated quota failure");
    });
    await expect(writeSearchStore(cache("new body", 2))).rejects.toMatchObject({
      code: "storage",
    });
    expect(await readSearchStore()).toEqual(first);
  });
  it("same-session worker restart decrypts encrypted records with the ephemeral key", async () => {
    const first = cache();
    await writeSearchStore(first);
    vi.resetModules();
    const restarted = await import("../src/search-store");
    expect(await restarted.readSearchStore()).toEqual(first);
    await restarted.clearSearchStore();
  });
  it("repeated failed manifest commits clean staging orphans and preserve old records", async () => {
    const first = cache();
    await writeSearchStore(first);
    const set = chrome.storage.session.set as any;
    set.mockImplementation(async (values: Record<string, any>) => {
      if (values.searchCache?.control?.generation > 1) throw Error("quota");
      Object.assign(session, structuredClone(values));
    });
    for (let n = 0; n < 5; n++) {
      await expect(
        writeSearchStore(cache(`failed-${n}`, 2 + n)),
      ).rejects.toMatchObject({ code: "storage" });
      expect(await records()).toHaveLength(2);
      expect(await readSearchStore()).toEqual(first);
    }
  });
  it("rejects an oversized control manifest with a typed limit while preserving prior data", async () => {
    const first = cache();
    await writeSearchStore(first);
    await expect(
      writeSearchStore({
        ...cache("small", 2),
        hugeControl: "x".repeat(2 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({ code: "limit" });
    expect(await records()).toHaveLength(2);
    expect(await readSearchStore()).toEqual(first);
  });
});
