// 结果图和抠图的下载器：缓存命中、卡死检测、有限次重试、进度、内容校验。
//
// 为什么要有它（2026-11-06，产品负责人在第一个真实窗口里的遭遇）：后端 62 秒就把场景图做好了，页面却一直没显示，刷新后才有图；
// 而且页面每次打开都很慢。旧的 ServiceClient.image() 没有超时、没有重试、没有进度，还用 cache: "no-store" 强制每次重新下载，
// 一次打开要重下 3 张图；下载中途卡住时既不报错也不重试，页面就一直空着。在这台机器上实测到站点的下载速度只有约 120～250 KB/s，
// 一张 1～2 MB 的 PNG 就要几秒到十几秒，所以“卡住”和“慢”都很常见。
//
// 这个文件只放逻辑，不碰浏览器全局：网络、缓存、哈希、等待都由调用方注入，所以可以在 Node 里用假的网络和假的缓存逐条测试。
//
// 规则：
//   1. 先看本地缓存。键是“资产编号 + 内容指纹（SHA-256）”：资产内容永远不变，所以命中就不用再下；大小对不上的缓存当作没有。
//   2. 下载时盯着“多久没有收到新字节”（stallMs），而不是总时长：慢链路上一张大图可能要几十秒，但只要字节还在来就不该被掐掉；
//      字节一停就掐掉这次下载并重试，而不是永远等下去。
//   3. 有限次重试（默认 2 次，间隔 1 秒、3 秒）：网络错误、5xx、408、429、卡死、大小或指纹对不上都重试。
//      403、404、410 不重试——预签名链接过期或资产不存在，要由调用方回去向服务端要新的链接。
//   4. 字节对不上服务端公布的大小或 SHA-256 的一律不要，也不写缓存。
//   5. 调用方离开（abort）就立刻停：不重试、不再发请求、不写缓存。
//   6. 缓存读写失败（存储不可用、配额满）不能让一次本来成功的下载失败。
//   7. 同一张图同时被多处要（createSharedLoader）：只下一次，大家共用；进度广播给所有人，晚加入的立刻补上当前进度；
//      有人离开不影响还在等的人，只有所有人都离开了才真正掐断连接。
//      为什么需要：缓存帮不上“同时”——第二个请求发出时第一个还没下完，缓存里还没有。2026-11-06 产品负责人的实测：打开页面下载了 3 次，
//      浏览器里却只存了 2 张图：页面一挂载就同时启动三个下载（显示用的抠图、结果图、对比用的抠图），后两个“抠图”是同一张（2.7 MB），被同时下了两遍。

export type AssetDescriptor = { assetId: string; url: string; bytes: number; sha256: string };
export type BlobStore = { get(key: string): Promise<Blob | undefined>; put(key: string, blob: Blob): Promise<void> };
export type LoaderOptions = {
  /** 公布的大小上限（和旧下载器一样：32 MB）。 */
  maxBytes: number;
  /** 多久没有收到新字节就算卡死（毫秒）。 */
  stallMs: number;
  /** 失败后最多再试几次。 */
  retries: number;
  /** 每次重试前等多久（毫秒），长度等于 retries。 */
  backoffMs: number[];
};
export type LoaderDeps = {
  fetchAsset: (url: string, signal: AbortSignal) => Promise<Response>;
  sha256Hex: (data: ArrayBuffer) => Promise<string>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  store?: BlobStore;
  options?: Partial<LoaderOptions>;
};
export type LoadCall = { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void };

export const DEFAULT_LOADER_OPTIONS: LoaderOptions = { maxBytes: 32 * 1024 * 1024, stallMs: 20_000, retries: 2, backoffMs: [1000, 3000] };

export class AssetLoadError extends Error {
  constructor(readonly code: "asset_download_failed" | "asset_mismatch" | "asset_timeout", readonly status = 0) { super(code); }
}

export const assetKey = (asset: Pick<AssetDescriptor, "assetId" | "sha256">) => `${asset.assetId}/${asset.sha256}`;

const NOT_RETRYABLE = new Set([403, 404, 410]);
const aborted = (signal?: AbortSignal) => signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");

class Stalled extends Error {}

/** 读完整个响应体；每来一块字节就重新计时，stallMs 内没有新字节就抛 Stalled。 */
async function readBody(response: Response, total: number, stallMs: number, onProgress: LoadCall["onProgress"], outer: AbortSignal | undefined): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  const waitStall = () => {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Stalled()), stallMs); });
    return { promise, cancel: () => clearTimeout(timer) };
  };
  if (!reader) {                                              // 没有流式读取的环境：整体读，一次计时
    const guard = waitStall();
    try { return new Uint8Array(await Promise.race([response.arrayBuffer(), guard.promise])); } finally { guard.cancel(); }
  }
  const chunks: Uint8Array[] = []; let loaded = 0;
  try {
    for (;;) {
      if (outer?.aborted) throw aborted(outer);
      const guard = waitStall();
      let step: ReadableStreamReadResult<Uint8Array>;
      try { step = await Promise.race([reader.read(), guard.promise]); } finally { guard.cancel(); }
      if (step.done) break;
      chunks.push(step.value); loaded += step.value.length;
      onProgress?.(Math.min(loaded, total), total);
    }
  } catch (error) {
    reader.cancel().catch(() => {});                          // 掐掉这次连接，别让它在后台继续占带宽
    throw error;
  }
  const all = new Uint8Array(loaded); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}

export async function loadAsset(asset: AssetDescriptor, deps: LoaderDeps, call: LoadCall): Promise<{ blob: Blob; fromCache: boolean }> {
  const options = { ...DEFAULT_LOADER_OPTIONS, ...deps.options }, { signal, onProgress } = call;
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > options.maxBytes) throw new AssetLoadError("asset_mismatch");
  if (signal?.aborted) throw aborted(signal);
  const key = assetKey(asset);
  try {
    const cached = await deps.store?.get(key);
    if (cached && cached.size === asset.bytes) { onProgress?.(asset.bytes, asset.bytes); return { blob: cached, fromCache: true }; }
  } catch { /* 缓存读不出来就当没有 */ }

  let failure = new AssetLoadError("asset_download_failed");
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (attempt > 0) await deps.sleep(options.backoffMs[attempt - 1] ?? options.backoffMs.at(-1) ?? 0, signal ?? new AbortController().signal);
    if (signal?.aborted) throw aborted(signal);
    const controller = new AbortController(), leave = () => controller.abort();
    signal?.addEventListener("abort", leave, { once: true });
    try {
      let response: Response;
      try { response = await deps.fetchAsset(asset.url, controller.signal); }
      catch (error) { if (signal?.aborted) throw aborted(signal); failure = new AssetLoadError("asset_download_failed"); void error; continue; }
      if (!response.ok) {
        failure = new AssetLoadError("asset_download_failed", response.status);
        if (NOT_RETRYABLE.has(response.status)) throw failure;
        continue;
      }
      let bytes: Uint8Array;
      try { bytes = await readBody(response, asset.bytes, options.stallMs, onProgress, signal); }
      catch (error) {
        if (signal?.aborted) throw aborted(signal);
        failure = error instanceof Stalled ? new AssetLoadError("asset_timeout") : new AssetLoadError("asset_download_failed");
        continue;
      }
      if (bytes.length !== asset.bytes) { failure = new AssetLoadError("asset_mismatch"); continue; }
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (await deps.sha256Hex(copy) !== asset.sha256) { failure = new AssetLoadError("asset_mismatch"); continue; }
      const blob = new Blob([copy], { type: "image/png" });
      try { await deps.store?.put(key, blob); } catch { /* 写不进缓存不影响这次结果 */ }
      return { blob, fromCache: false };
    } finally {
      controller.abort(); signal?.removeEventListener("abort", leave);
    }
  }
  throw failure;
}

export type LoadResult = { blob: Blob; fromCache: boolean };
export type ProgressFn = (loaded: number, total: number) => void;

type Shared = { promise: Promise<LoadResult>; controller: AbortController; listeners: Set<ProgressFn>; callers: number; last?: [number, number] };

/**
 * 在 loadAsset 外面包一层“同一张图只下一次”：key 是 assetKey（资产编号 + 内容指纹）。
 * deps 用函数给（每次真正下载时才取），因为浏览器缓存对象要到调用时才存在。
 */
export function createSharedLoader(deps: () => LoaderDeps) {
  const inflight = new Map<string, Shared>();
  return function load(asset: AssetDescriptor, call: LoadCall = {}): Promise<LoadResult> {
    const { signal, onProgress } = call;
    if (signal?.aborted) return Promise.reject(aborted(signal));
    const key = assetKey(asset);
    let shared = inflight.get(key);
    if (!shared) {
      const created: Shared = { promise: undefined as unknown as Promise<LoadResult>, controller: new AbortController(), listeners: new Set(), callers: 0 };
      created.promise = loadAsset(asset, deps(), { signal: created.controller.signal, onProgress: (loaded, total) => {
        created.last = [loaded, total];
        for (const listener of [...created.listeners]) listener(loaded, total);
      } }).finally(() => { if (inflight.get(key) === created) inflight.delete(key); });
      created.promise.catch(() => {});                       // 全员离开后它会以 AbortError 结束，这里不让它变成未处理的拒绝
      inflight.set(key, created); shared = created;
    }
    const entry = shared;
    entry.callers++;
    if (onProgress) { entry.listeners.add(onProgress); if (entry.last) onProgress(...entry.last); }
    return new Promise<LoadResult>((resolve, reject) => {
      let done = false;
      const leave = () => {
        if (onProgress) entry.listeners.delete(onProgress);
        signal?.removeEventListener("abort", onAbort);
        if (--entry.callers === 0) {
          if (inflight.get(key) === entry) inflight.delete(key);   // 先摘掉再掐断：之后来的人要开一次新的下载，不能继承一个已经被取消的
          entry.controller.abort();
        }
      };
      const onAbort = () => { if (done) return; done = true; leave(); reject(aborted(signal)); };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        result => { if (done) return; done = true; leave(); resolve(result); },
        error => { if (done) return; done = true; leave(); reject(error); });
    });
  };
}
