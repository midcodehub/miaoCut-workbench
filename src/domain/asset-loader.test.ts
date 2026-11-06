// 结果图和抠图的下载器测试：缓存命中、卡死检测、重试、进度、内容校验。
//
// 背景（2026-11-06，产品负责人在第一个真实窗口里的遭遇）：后端 62 秒就把场景图做好了，页面却一直没显示，刷新后才有图；而且页面每次打开都很慢。
// 原因（推断，和后端数据完全吻合）：旧的下载没有超时、没有重试、没有进度，每次打开都用 cache: "no-store" 把 3 张图重新下一遍，
// 下载中途卡住时页面既不报错也不重试。这里用假的网络、假的缓存、假的时钟把这些行为逐条钉住。
import assert from "node:assert/strict";
import test from "node:test";
import { AssetLoadError, DEFAULT_LOADER_OPTIONS, assetKey, createSharedLoader, loadAsset, type AssetDescriptor, type BlobStore, type LoaderDeps } from "./asset-loader";

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

// —— 同一张图的并发下载共用一次 ——
// 2026-11-06 产品负责人的实测：打开页面时下载了 3 次，浏览器里却只存了 2 张图（结果图 1115 KB、抠图 2700 KB）。
// 页面一挂载就同时启动三个下载（显示用的抠图、结果图、对比用的抠图），后两个“抠图”其实是同一张，被同时下了两遍（4.1 秒和 3.7 秒，在抢带宽）。
// 缓存帮不上：第二个请求发出时第一个还没下完，缓存里还没有。所以要让“同一张图正在下载”这件事被共用。
const gated = (content: Uint8Array) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    async start(controller) { controller.enqueue(content.slice(0, 4)); await gate; controller.enqueue(content.slice(4)); controller.close(); },
  }));
  return { response, release };
};
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

test("two callers asking for the same asset at the same time share one download and both get the bytes and the progress", async () => {
  const content = bytesOf("shared between the display effect and the comparison effect");
  const asset = await descriptor(content), { response, release } = gated(content);
  let requests = 0;
  const load = createSharedLoader(() => baseDeps(async () => { requests++; return response; }));
  const first: number[] = [], second: number[] = [];
  const a = load(asset, { onProgress: (loaded) => first.push(loaded) }), b = load(asset, { onProgress: (loaded) => second.push(loaded) });
  await tick(); release();
  const [one, two] = await Promise.all([a, b]);
  assert.equal(requests, 1, "one request for two callers");
  assert.equal(one.blob.size, content.length);
  assert.equal(two.blob, one.blob, "both get the very same blob");
  assert.equal(first.at(-1), content.length);
  assert.equal(second.at(-1), content.length, "the second caller sees the progress too");
});

test("a caller that joins late is told how far the download already is, instead of seeing nothing until the next chunk", async () => {
  const content = bytesOf("late joiner gets the current progress");
  const asset = await descriptor(content), { response, release } = gated(content);
  const load = createSharedLoader(() => baseDeps(async () => response));
  const early = load(asset, {});
  await tick();                                                    // 前 4 个字节已经到了
  const seen: Array<[number, number]> = [];
  const late = load(asset, { onProgress: (loaded, total) => seen.push([loaded, total]) });
  assert.deepEqual(seen[0], [4, content.length], "replayed at once");
  release(); await Promise.all([early, late]);
});

test("one caller leaving does not cancel the download the other one still needs", async () => {
  const content = bytesOf("the other caller is still waiting for this");
  const asset = await descriptor(content), { response, release } = gated(content), leaving = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  const load = createSharedLoader(() => baseDeps(async (_url, signal) => { fetchSignal = signal; return response; }));
  const staying = load(asset, {}), leaver = load(asset, { signal: leaving.signal });
  await tick(); leaving.abort();
  await assert.rejects(leaver, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(fetchSignal!.aborted, false, "the shared request keeps running");
  release();
  assert.equal((await staying).blob.size, content.length);
});

test("when every caller has left, the shared download is really cancelled, and the next caller starts a fresh one", async () => {
  const content = bytesOf("nobody wants this any more");
  const asset = await descriptor(content), first = gated(content), second = gated(content), a = new AbortController(), b = new AbortController();
  const signals: AbortSignal[] = []; let requests = 0;
  const load = createSharedLoader(() => baseDeps(async (_url, signal) => { signals.push(signal); return ++requests === 1 ? first.response : second.response; }));
  const one = load(asset, { signal: a.signal }), two = load(asset, { signal: b.signal });
  await tick(); a.abort(); assert.equal(signals[0].aborted, false); b.abort();
  await assert.rejects(one); await assert.rejects(two);
  assert.equal(signals[0].aborted, true, "the connection is cut once nobody is waiting");
  const again = load(asset, {});
  await tick(); second.release();
  assert.equal((await again).blob.size, content.length);
  assert.equal(requests, 2, "a new caller after everyone left starts a new download instead of inheriting the cancelled one");
});

test("different assets never share a download", async () => {
  const content = bytesOf("same bytes, different asset");
  const one = await descriptor(content), two = await descriptor(content, { assetId: "22222222-2222-4222-8222-222222222222" });
  let requests = 0;
  const load = createSharedLoader(() => baseDeps(async () => { requests++; return okResponse(content); }));
  await Promise.all([load(one, {}), load(two, {})]);
  assert.equal(requests, 2);
});

test("a failed shared download fails every waiting caller with the same error, and the next call tries again", async () => {
  const content = bytesOf("fails once, then works");
  const asset = await descriptor(content);
  let requests = 0; let failing = true;
  const load = createSharedLoader(() => baseDeps(async () => { requests++; return failing ? new Response("gone", { status: 404 }) : okResponse(content); }));
  const results = await Promise.allSettled([load(asset, {}), load(asset, {})]);
  assert.ok(results.every(result => result.status === "rejected" && (result.reason as AssetLoadError).code === "asset_download_failed"));
  assert.equal(requests, 1, "one request failed for both callers");
  failing = false;
  assert.equal((await load(asset, {})).blob.size, content.length);
  assert.equal(requests, 2);
});

test("once a shared download has finished, the next caller is served by the store and the shared entry is gone", async () => {
  const content = bytesOf("served from the store the second time");
  const asset = await descriptor(content), { store } = memoryStore();
  let requests = 0;
  const load = createSharedLoader(() => baseDeps(async () => { requests++; return okResponse(content); }, { store }));
  await Promise.all([load(asset, {}), load(asset, {})]);
  const later = await load(asset, {});
  assert.equal(requests, 1);
  assert.equal(later.fromCache, true);
});

test("the downloaded blob carries the image type the server announced (WebP previews are not mislabelled as PNG), and PNG stays the default", async () => {
  const content = bytesOf("pretend webp bytes");
  const webp = await descriptor(content, { mime: "image/webp" }), png = await descriptor(content);
  const { store, map } = memoryStore();
  const a = await loadAsset(webp, baseDeps(async () => okResponse(content), { store }), {});
  const b = await loadAsset({ ...png, assetId: "22222222-2222-4222-8222-222222222222" }, baseDeps(async () => okResponse(content), { store }), {});
  assert.equal(a.blob.type, "image/webp"); assert.equal(map.get(assetKey(webp))!.type, "image/webp", "and it is stored with that type");
  assert.equal(b.blob.type, "image/png");
});

test("a preview and its original are different cache entries (same asset id, different fingerprint) and never serve each other", async () => {
  const original = bytesOf("the big original png bytes"), small = bytesOf("small preview");
  const big = await descriptor(original), preview = await descriptor(small, { mime: "image/webp", url: "https://r2.example/preview.webp" });
  assert.notEqual(assetKey(big), assetKey(preview));
  const { store } = memoryStore(); let requests = 0;
  const deps = baseDeps(async url => { requests++; return okResponse(url.includes("preview") ? small : original); }, { store });
  const first = await loadAsset(preview, deps, {}), second = await loadAsset(big, deps, {});
  assert.equal(first.blob.size, small.length); assert.equal(second.blob.size, original.length);
  assert.equal(requests, 2, "the original is still fetched when it is asked for (download), even after the preview was cached");
  assert.equal((await loadAsset(preview, deps, {})).fromCache, true); assert.equal(requests, 2);
});
