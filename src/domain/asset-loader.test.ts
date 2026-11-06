// 结果图和抠图的下载器测试：缓存命中、卡死检测、重试、进度、内容校验。
//
// 背景（2026-11-06，产品负责人在第一个真实窗口里的遭遇）：后端 62 秒就把场景图做好了，页面却一直没显示，刷新后才有图；而且页面每次打开都很慢。
// 原因（推断，和后端数据完全吻合）：旧的下载没有超时、没有重试、没有进度，每次打开都用 cache: "no-store" 把 3 张图重新下一遍，
// 下载中途卡住时页面既不报错也不重试。这里用假的网络、假的缓存、假的时钟把这些行为逐条钉住。
import assert from "node:assert/strict";
import test from "node:test";
import { AssetLoadError, DEFAULT_LOADER_OPTIONS, assetKey, loadAsset, type AssetDescriptor, type BlobStore, type LoaderDeps } from "./asset-loader";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const hex = async (data: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)), n => n.toString(16).padStart(2, "0")).join("");
async function descriptor(content: Uint8Array, overrides: Partial<AssetDescriptor> = {}): Promise<AssetDescriptor> {
  return { assetId: "11111111-1111-4111-8111-111111111111", url: "https://r2.example/asset?sig=abc", bytes: content.length, sha256: await hex(content), ...overrides };
}
const okResponse = (content: Uint8Array, chunk = 4) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { for (let i = 0; i < content.length; i += chunk) controller.enqueue(content.slice(i, i + chunk)); controller.close(); },
}), { status: 200 });
const neverResponse = () => new Response(new ReadableStream<Uint8Array>({ start() { /* never yields a byte */ } }), { status: 200 });
const memoryStore = (initial: Record<string, Blob> = {}) => {
  const map = new Map<string, Blob>(Object.entries(initial)), puts: string[] = [];
  const store: BlobStore = { async get(key) { return map.get(key); }, async put(key, blob) { puts.push(key); map.set(key, blob); } };
  return { store, map, puts };
};
const baseDeps = (fetchAsset: LoaderDeps["fetchAsset"], extra: Partial<LoaderDeps> = {}): LoaderDeps => ({
  fetchAsset, sha256Hex: hex, sleep: async () => {}, options: { stallMs: 25, retries: 2, backoffMs: [0, 0] }, ...extra });

test("a download is verified against the size and SHA-256 the server announced, reported as progress, and then stored", async () => {
  const content = bytesOf("the scene image bytes, long enough to arrive in several chunks");
  const asset = await descriptor(content), { store, puts } = memoryStore(), progress: Array<[number, number]> = [];
  const result = await loadAsset(asset, baseDeps(async () => okResponse(content), { store }), { onProgress: (loaded, total) => progress.push([loaded, total]) });
  assert.equal(result.fromCache, false);
  assert.equal(result.blob.size, content.length);
  assert.deepEqual(puts, [assetKey(asset)], "stored under the asset id and its content fingerprint");
  assert.ok(progress.length >= 3, "several chunks give several progress steps");
  assert.ok(progress.every(([, total]) => total === content.length));
  assert.deepEqual(progress.map(([loaded]) => loaded), [...progress.map(([loaded]) => loaded)].sort((a, b) => a - b), "progress never goes backwards");
  assert.equal(progress.at(-1)![0], content.length);
});

test("an image that was downloaded before is served from the store without any request", async () => {
  const content = bytesOf("already downloaded");
  const asset = await descriptor(content), { store } = memoryStore({ [assetKey(asset)]: new Blob([content]) });
  let requests = 0;
  const progress: Array<[number, number]> = [];
  const result = await loadAsset(asset, baseDeps(async () => { requests++; return okResponse(content); }, { store }), { onProgress: (loaded, total) => progress.push([loaded, total]) });
  assert.equal(requests, 0);
  assert.equal(result.fromCache, true);
  assert.equal(result.blob.size, content.length);
  assert.deepEqual(progress.at(-1), [content.length, content.length], "a cache hit reports completion at once");
});

test("a stored copy of the wrong size is ignored and downloaded again; a different fingerprint is a different entry", async () => {
  const content = bytesOf("the real bytes");
  const asset = await descriptor(content), { store, map } = memoryStore({ [assetKey(asset)]: new Blob([bytesOf("truncated")]) });
  let requests = 0;
  const result = await loadAsset(asset, baseDeps(async () => { requests++; return okResponse(content); }, { store }), {});
  assert.equal(requests, 1);
  assert.equal(result.fromCache, false);
  assert.equal(map.get(assetKey(asset))!.size, content.length, "the bad entry is replaced");
  assert.notEqual(assetKey(asset), assetKey({ ...asset, sha256: "0".repeat(64) }));
});

test("a server error is retried with a pause and then succeeds; the pauses follow the configured backoff", async () => {
  const content = bytesOf("second time lucky");
  const asset = await descriptor(content), pauses: number[] = [];
  let requests = 0;
  const deps = baseDeps(async () => (++requests < 3 ? new Response("busy", { status: 503 }) : okResponse(content)),
    { sleep: async ms => { pauses.push(ms); }, options: { stallMs: 25, retries: 2, backoffMs: [1000, 3000] } });
  const result = await loadAsset(asset, deps, {});
  assert.equal(requests, 3);
  assert.deepEqual(pauses, [1000, 3000]);
  assert.equal(result.blob.size, content.length);
});

test("an expired or missing URL (403, 404, 410) is not retried: the caller has to ask the server for a fresh link", async () => {
  const asset = await descriptor(bytesOf("x"));
  for (const status of [403, 404, 410]) {
    let requests = 0;
    await assert.rejects(loadAsset(asset, baseDeps(async () => { requests++; return new Response("no", { status }); }), {}),
      (error: unknown) => error instanceof AssetLoadError && error.code === "asset_download_failed" && error.status === status, String(status));
    assert.equal(requests, 1, `${status} is final`);
  }
});

test("a connection that stops sending bytes is cut after the stall time and retried, instead of hanging forever", async () => {
  const content = bytesOf("arrives on the second try");
  const asset = await descriptor(content);
  let requests = 0;
  const started = Date.now();
  const result = await loadAsset(asset, baseDeps(async () => (++requests === 1 ? neverResponse() : okResponse(content))), {});
  assert.equal(requests, 2);
  assert.equal(result.blob.size, content.length);
  assert.ok(Date.now() - started < 2000, "the stall was noticed within the stall time, not after a long timeout");
});

test("when every attempt stalls the error says so, after exactly retries + 1 attempts", async () => {
  const asset = await descriptor(bytesOf("never arrives"));
  let requests = 0;
  await assert.rejects(loadAsset(asset, baseDeps(async () => { requests++; return neverResponse(); }), {}),
    (error: unknown) => error instanceof AssetLoadError && error.code === "asset_timeout");
  assert.equal(requests, 3);
});

test("a network failure is retried and finally reported as a failed download", async () => {
  const asset = await descriptor(bytesOf("offline"));
  let requests = 0;
  await assert.rejects(loadAsset(asset, baseDeps(async () => { requests++; throw new TypeError("Failed to fetch"); }), {}),
    (error: unknown) => error instanceof AssetLoadError && error.code === "asset_download_failed" && error.status === 0);
  assert.equal(requests, 3);
});

test("bytes that do not match the announced SHA-256 are never kept, never stored, and end as a mismatch", async () => {
  const content = bytesOf("the genuine content"), tampered = bytesOf("the genuine c0ntent");
  const asset = await descriptor(content), { store, puts } = memoryStore();
  let requests = 0;
  await assert.rejects(loadAsset(asset, baseDeps(async () => { requests++; return okResponse(tampered); }, { store }), {}),
    (error: unknown) => error instanceof AssetLoadError && error.code === "asset_mismatch");
  assert.equal(requests, 3, "a corrupted transfer gets the same retries");
  assert.deepEqual(puts, []);
});

test("a truncated transfer is a size mismatch and is retried", async () => {
  const content = bytesOf("0123456789abcdef");
  const asset = await descriptor(content);
  let requests = 0;
  const result = await loadAsset(asset, baseDeps(async () => (++requests === 1 ? okResponse(content.slice(0, 8)) : okResponse(content))), {});
  assert.equal(requests, 2);
  assert.equal(result.blob.size, content.length);
});

test("an announced size of zero or above the limit is refused before any request is made", async () => {
  const content = bytesOf("x");
  for (const bytes of [0, DEFAULT_LOADER_OPTIONS.maxBytes + 1, -5, Number.NaN]) {
    let requests = 0;
    await assert.rejects(loadAsset(await descriptor(content, { bytes }), baseDeps(async () => { requests++; return okResponse(content); }), {}),
      (error: unknown) => error instanceof AssetLoadError && error.code === "asset_mismatch", String(bytes));
    assert.equal(requests, 0);
  }
});

test("the caller leaving (abort) stops the download at once: no retry, no further request, no store write", async () => {
  const content = bytesOf("abandoned");
  const asset = await descriptor(content), { store, puts } = memoryStore(), controller = new AbortController();
  let requests = 0;
  const pending = loadAsset(asset, baseDeps(async () => { requests++; return neverResponse(); }, { store, options: { stallMs: 5000, retries: 2, backoffMs: [0, 0] } }), { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(requests, 1);
  assert.deepEqual(puts, []);
});

test("a store that fails to read or write never breaks a download that itself worked", async () => {
  const content = bytesOf("fine without a cache");
  const asset = await descriptor(content);
  const brokenStore: BlobStore = { async get() { throw new Error("storage unavailable"); }, async put() { throw new Error("quota exceeded"); } };
  const result = await loadAsset(asset, baseDeps(async () => okResponse(content), { store: brokenStore }), {});
  assert.equal(result.blob.size, content.length);
  assert.equal(result.fromCache, false);
});

test("the defaults are the numbers the page relies on", () => {
  assert.equal(DEFAULT_LOADER_OPTIONS.maxBytes, 32 * 1024 * 1024, "the same cap the old downloader had");
  assert.ok(DEFAULT_LOADER_OPTIONS.stallMs >= 10_000 && DEFAULT_LOADER_OPTIONS.stallMs <= 30_000, "long enough for a slow link, short enough to notice a stall");
  assert.equal(DEFAULT_LOADER_OPTIONS.retries, 2);
  assert.equal(DEFAULT_LOADER_OPTIONS.backoffMs.length, DEFAULT_LOADER_OPTIONS.retries);
});
