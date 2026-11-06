// 浏览器缓存（Cache Storage）适配器的测试：用一个按插入顺序记账的假缓存，验证读写、容量上限和清空。
import assert from "node:assert/strict";
import test from "node:test";
import { cacheBlobStore, type CacheLike } from "./asset-cache";

function fakeCache() {
  const entries = new Map<string, Response>();
  const cache: CacheLike = {
    async match(url) { const found = entries.get(url); return found ? found.clone() : undefined; },
    async put(url, response) { entries.delete(url); entries.set(url, response); },
    async delete(url) { return entries.delete(url); },
    async keys() { return [...entries.keys()].map(url => ({ url })); },
  };
  return { cache, entries };
}
const blobOf = (text: string) => new Blob([text], { type: "image/png" });

test("a blob written under a key comes back with the same bytes and type; an unknown key is simply missing", async () => {
  const { cache, entries } = fakeCache();
  const store = cacheBlobStore(async () => cache, { origin: "https://miaocut.app" });
  assert.equal(await store.get("a/b"), undefined);
  await store.put("a/b", blobOf("pixels"));
  const back = await store.get("a/b");
  assert.equal(await back!.text(), "pixels");
  assert.equal(back!.type, "image/png");
  assert.deepEqual([...entries.keys()], ["https://miaocut.app/workbench/_asset-cache/a/b"], "entries live under a private path of this site and can never be requested as a page");
});

test("the store keeps only the newest entries: the oldest go first once the limit is passed", async () => {
  const { cache, entries } = fakeCache();
  const store = cacheBlobStore(async () => cache, { origin: "https://x.test", maxEntries: 3 });
  for (const key of ["k1/h", "k2/h", "k3/h", "k4/h", "k5/h"]) await store.put(key, blobOf(key));
  assert.deepEqual([...entries.keys()].map(url => url.split("_asset-cache/")[1]), ["k3/h", "k4/h", "k5/h"]);
  assert.equal(await store.get("k1/h"), undefined);
  assert.equal(await (await store.get("k5/h"))!.text(), "k5/h");
});

test("writing the same key again replaces it instead of counting twice", async () => {
  const { cache, entries } = fakeCache();
  const store = cacheBlobStore(async () => cache, { origin: "https://x.test", maxEntries: 2 });
  await store.put("a/h", blobOf("one")); await store.put("b/h", blobOf("two")); await store.put("a/h", blobOf("three"));
  assert.equal(entries.size, 2);
  assert.equal(await (await store.get("a/h"))!.text(), "three");
});

test("clear() removes every entry this store wrote and nothing else", async () => {
  const { cache, entries } = fakeCache();
  entries.set("https://x.test/workbench/somebody-elses-entry", new Response("keep"));
  const store = cacheBlobStore(async () => cache, { origin: "https://x.test" });
  await store.put("a/h", blobOf("one")); await store.put("b/h", blobOf("two"));
  await store.clear();
  assert.deepEqual([...entries.keys()], ["https://x.test/workbench/somebody-elses-entry"]);
});

test("the default limit is small enough for a phone and large enough for one working session", async () => {
  const { cache, entries } = fakeCache();
  const store = cacheBlobStore(async () => cache, { origin: "https://x.test" });
  for (let i = 0; i < 100; i++) await store.put(`k${i}/h`, blobOf("x"));
  assert.ok(entries.size >= 20 && entries.size <= 60, `kept ${entries.size} entries`);
});
