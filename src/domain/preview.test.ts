// 服务端预览图（WebP）在页面侧的规则测试：什么时候用预览、预览和原图的几何关系、按预览取图时的缩放。
//
// 背景（2026-11-06）：产品负责人量到抠图 2700 KB、结果图 1115 KB，第一次打开要十几秒。registry 现在会给 foreground 和 final
// 各生成一份几十～一百多 KB 的 WebP 预览（长边最多 1024），页面显示用预览，下载/海报/换色仍用原始 PNG。
// 这些测试钉住的是“页面敢不敢用这份预览”的判断，和“用预览画图时怎么把原图坐标换算过去”——换算错了，抠图会错位、边缘会被切掉。
import assert from "node:assert/strict";
import test from "node:test";
import { previewDescriptor, shouldFallBackToOriginal, sourceRect } from "./preview";
import { AssetLoadError } from "./asset-loader";
import type { ServiceAsset } from "./service-contracts";

const asset = (overrides: Partial<ServiceAsset> = {}): ServiceAsset => ({
  assetId: "11111111-1111-4111-8111-111111111111", mime: "image/png", bytes: 2_700_000, sha256: "a".repeat(64), width: 1122, height: 1402,
  bounds: { x: 100, y: 200, width: 900, height: 1000 }, hasAlpha: true, transparent: true, sourceAssetId: null,
  expiresAt: Date.now() + 86_400_000, url: "https://r2.example/original.png?sig=1", urlExpiresAt: Date.now() + 900_000,
  preview: { mime: "image/webp", bytes: 109_566, sha256: "b".repeat(64), width: 819, height: 1024, url: "https://r2.example/preview.webp?sig=2" },
  ...overrides,
});

test("a valid preview becomes a download descriptor of its own (own url, size and fingerprint), under the same asset id", () => {
  const found = previewDescriptor(asset());
  assert.deepEqual(found, { assetId: "11111111-1111-4111-8111-111111111111", url: "https://r2.example/preview.webp?sig=2",
    bytes: 109_566, sha256: "b".repeat(64), mime: "image/webp" });
});

test("no preview field (old asset, too large, encoder failed) means: use the original", () => {
  const plain: Partial<ServiceAsset> = asset(); delete plain.preview;
  assert.equal(previewDescriptor(plain as ServiceAsset), undefined);
});

test("a preview the page cannot trust is ignored rather than shown (the original is the safe fallback)", () => {
  const bad = (patch: Record<string, unknown>) => previewDescriptor(asset({ preview: { ...asset().preview!, ...patch } as ServiceAsset["preview"] }));
  assert.equal(bad({ mime: "image/png" }), undefined, "only WebP");
  assert.equal(bad({ sha256: "xyz" }), undefined, "fingerprint must be 64 hex characters");
  assert.equal(bad({ sha256: "B".repeat(64) }), undefined, "and lower-case, like the original's");
  assert.equal(bad({ bytes: 0 }), undefined);
  assert.equal(bad({ bytes: 12.5 }), undefined);
  assert.equal(bad({ bytes: 2_700_000 }), undefined, "a preview that is not smaller than the original defeats the purpose");
  assert.equal(bad({ url: "" }), undefined);
  assert.equal(bad({ url: "http://r2.example/preview.webp" }), undefined, "https only");
  assert.equal(bad({ width: 1200, height: 1500 }), undefined, "never larger than the original");
  assert.equal(bad({ width: 819.5 }), undefined, "whole pixels");
  assert.equal(bad({ width: 1024, height: 1024 }), undefined, "a different aspect ratio would put the cut-out in the wrong place");
});

test("the aspect-ratio check tolerates the one-pixel rounding the server's resize introduces, and nothing more", () => {
  // 1122×1402 → 长边 1024 → 宽 819.49 四舍五入 819；比例差 0.0004，必须通过
  assert.ok(previewDescriptor(asset({ preview: { ...asset().preview!, width: 819, height: 1024 } })));
  assert.ok(previewDescriptor(asset({ preview: { ...asset().preview!, width: 820, height: 1024 } })), "820 is also within a pixel");
  assert.equal(previewDescriptor(asset({ preview: { ...asset().preview!, width: 830, height: 1024 } })), undefined, "11 pixels off is not rounding");
  // 极端细长的图：宽度只有几个像素时，一个像素的舍入就是很大的比例差，规则按“偏差不超过一个像素”算而不是按百分比
  assert.ok(previewDescriptor(asset({ width: 4000, height: 10, bounds: { x: 0, y: 0, width: 4000, height: 10 }, preview: { ...asset().preview!, width: 1024, height: 3 } })));
});

test("a preview of the same size as the original is allowed (a 1024×1024 result already at the cap)", () => {
  assert.ok(previewDescriptor(asset({ width: 1024, height: 1024, preview: { ...asset().preview!, width: 1024, height: 1024 } })));
});

test("the source rectangle is the original-pixel bounds scaled to whatever image was actually decoded", () => {
  const bounds = { x: 100, y: 200, width: 900, height: 1000 }, original = { width: 1122, height: 1402, bounds };
  // 没有缩放（原图，或本地上传的图）：必须逐字相等——这条保证旧路径不受影响
  assert.deepEqual(sourceRect(original, { naturalWidth: 1122, naturalHeight: 1402 }), bounds);
  const scaled = sourceRect(original, { naturalWidth: 819, naturalHeight: 1024 });
  assert.ok(Math.abs(scaled.x - 100 * 819 / 1122) < 1e-9 && Math.abs(scaled.y - 200 * 1024 / 1402) < 1e-9);
  assert.ok(Math.abs(scaled.width - 900 * 819 / 1122) < 1e-9 && Math.abs(scaled.height - 1000 * 1024 / 1402) < 1e-9);
  // 取图矩形在预览图内：不会读到图外
  assert.ok(scaled.x >= 0 && scaled.y >= 0 && scaled.x + scaled.width <= 819 + 1e-9 && scaled.y + scaled.height <= 1024 + 1e-9);
});

test("the source rectangle of a full-frame cut-out still covers the whole preview", () => {
  const full = sourceRect({ width: 1122, height: 1402, bounds: { x: 0, y: 0, width: 1122, height: 1402 } }, { naturalWidth: 819, naturalHeight: 1024 });
  assert.deepEqual(full, { x: 0, y: 0, width: 819, height: 1024 });
});

test("an image that did not decode (zero size) is an error, not a silent empty rectangle", () => {
  assert.throws(() => sourceRect({ width: 100, height: 100, bounds: { x: 0, y: 0, width: 10, height: 10 } }, { naturalWidth: 0, naturalHeight: 0 }), /preview_geometry/);
});

test("when the preview itself is bad (missing, gone, corrupt) fall back to the original; when the network is bad, do not double the wait", () => {
  assert.equal(shouldFallBackToOriginal(new AssetLoadError("asset_mismatch")), true, "wrong size or fingerprint: the preview object is corrupt");
  assert.equal(shouldFallBackToOriginal(new AssetLoadError("asset_download_failed", 404)), true, "the preview object is missing");
  assert.equal(shouldFallBackToOriginal(new AssetLoadError("asset_download_failed", 410)), true);
  assert.equal(shouldFallBackToOriginal(new AssetLoadError("asset_download_failed", 403)), false, "an expired link would expire the original's too; the caller asks for fresh links");
  assert.equal(shouldFallBackToOriginal(new AssetLoadError("asset_download_failed", 503)), false);
  assert.equal(shouldFallBackToOriginal(new AssetLoadError("asset_download_failed", 0)), false, "network error");
  assert.equal(shouldFallBackToOriginal(new AssetLoadError("asset_timeout")), false, "a stalled link stalls for the original too");
  assert.equal(shouldFallBackToOriginal(new DOMException("aborted", "AbortError")), false, "leaving the page is never a reason to start another download");
  assert.equal(shouldFallBackToOriginal(new Error("anything else")), false);
});
