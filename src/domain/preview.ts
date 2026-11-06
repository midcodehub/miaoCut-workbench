// 服务端预览图（WebP）在页面侧的两条规则：什么时候敢用预览，和用预览画图时怎么换算坐标。
//
// 背景（2026-11-06）：抠图 2700 KB、结果图 1115 KB，在慢链路上每张十几秒。registry 现在会给 foreground 和 final 各生成一份
// 几十～一百多 KB 的 WebP 预览（长边最多 1024，只缩小不放大），页面显示用预览；下载、做海报、换色仍用原始 PNG（有 SHA-256 校验）。
//
// 原则：预览只是显示用的“近似图”，任何不对劲都回退到原图，宁可慢一点也不能显示错位或错误的图。
import { AssetLoadError, type AssetDescriptor } from "./asset-loader";
import type { LocalAsset, Rect } from "./contracts";
import type { ServiceAsset } from "./service-contracts";

/**
 * 这个资产有没有一份页面敢用的预览？有就返回它的下载描述（用法和原图一样，交给 asset-loader），没有或不可信就返回 undefined。
 * 键仍然是 资产编号 + 预览自己的 SHA-256，所以和原图是两个缓存条目，互不冒充。
 */
export function previewDescriptor(asset: ServiceAsset): AssetDescriptor | undefined {
  const p = asset.preview;
  if (!p || p.mime !== "image/webp") return undefined;
  // 指纹必须是 64 位小写十六进制（和原图一样的格式）；大小必须是正整数，并且比原图小——不比原图小就没有意义。
  if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) return undefined;
  if (!Number.isSafeInteger(p.bytes) || p.bytes <= 0 || p.bytes >= asset.bytes) return undefined;
  // 下载链接只认 https（预签名链接是服务端给的，但页面不该因为一个异常字段去请求明文地址）。
  if (typeof p.url !== "string" || !p.url.startsWith("https://")) return undefined;
  // 尺寸：整数、不比原图大、宽高比和原图一致。
  if (!Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 1 || p.height < 1 || p.width > asset.width || p.height > asset.height) return undefined;
  // 宽高比按“长边缩放了多少，短边就该缩放同样多”检查，允许短边有不超过 1 像素的四舍五入误差。
  // （不能按百分比：4000×10 缩成 1024×3 时短边的舍入误差高达 17%，但它是正确的；错位的预览则差得远得多。）
  const horizontalLong = asset.width >= asset.height;
  const scale = horizontalLong ? p.width / asset.width : p.height / asset.height;
  const shortOriginal = horizontalLong ? asset.height : asset.width, shortPreview = horizontalLong ? p.height : p.width;
  if (Math.abs(shortPreview - shortOriginal * scale) > 1) return undefined;
  return { assetId: asset.assetId, url: p.url, bytes: p.bytes, sha256: p.sha256, mime: "image/webp" };
}

/**
 * 从“实际解码出来的图”里取商品的矩形。
 * asset.bounds 是商品在【原图】像素坐标里的位置；如果实际解码的是缩小后的预览，就要按每个方向的缩放比例换算过去，
 * 否则抠图会错位、边缘会被切掉。没有缩放（原图，或本地上传的图）时逐字返回 bounds，旧路径完全不受影响。
 */
export function sourceRect(asset: Pick<LocalAsset, "width" | "height" | "bounds">, image: { naturalWidth: number; naturalHeight: number }): Rect {
  if (!(image.naturalWidth > 0 && image.naturalHeight > 0 && asset.width > 0 && asset.height > 0)) throw new RangeError("preview_geometry");
  const b = asset.bounds;
  if (image.naturalWidth === asset.width && image.naturalHeight === asset.height) return { x: b.x, y: b.y, width: b.width, height: b.height };
  // 先乘后除：整幅商品（bounds 等于整张图）时结果正好等于预览的宽高，不带浮点误差。
  const w = image.naturalWidth, h = image.naturalHeight;
  return { x: b.x * w / asset.width, y: b.y * h / asset.height, width: b.width * w / asset.width, height: b.height * h / asset.height };
}

/**
 * 预览下载失败时，要不要改下原图？
 * 要：预览对象本身坏了——大小或指纹对不上（asset_mismatch）、对象不存在（404 / 410）。原图是独立的对象，很可能没问题。
 * 不要：网络问题（超时、断线、5xx）——原图走同一条链路，只会让用户多等一轮；403（链接过期）——原图的链接同时过期，
 *      该由调用方重新向服务端要新链接；取消（离开页面）——绝不能因此再发起新的下载。
 */
export function shouldFallBackToOriginal(error: unknown): boolean {
  if (!(error instanceof AssetLoadError)) return false;
  return error.code === "asset_mismatch" || (error.code === "asset_download_failed" && (error.status === 404 || error.status === 410));
}
