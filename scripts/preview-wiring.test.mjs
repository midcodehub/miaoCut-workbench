// 页面接线检查：预览图只用于显示，导出（下载、海报、换色）必须取原图，画图要按预览换算坐标。
// 规则本身（什么时候用预览、坐标怎么换算）在 src/domain/preview.test.ts 里逐条测；这里只盯“页面确实按这些规则接上了”，
// 因为接错的后果很隐蔽：用户下载到的是缩小的 WebP，或者抠图在预览里错位。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const page = read("src/components/internal-workbench.tsx"), client = read("src/client/service-api.ts"), renderer = read("src/client/demo-renderer.ts");
const free = read("src/client/free-composition.ts"), comparison = read("src/components/scene-comparison.tsx");

test("the service client has a preview() that uses the same verified shared loader and falls back to the original image()", () => {
  assert.match(client, /async preview\(asset: ServiceAsset, signal\?: AbortSignal/);
  assert.match(client, /previewDescriptor\(asset\)/, "the decision whether a preview can be trusted lives in domain/preview.ts");
  assert.match(client, /shouldFallBackToOriginal\(error\)/, "a corrupt or missing preview falls back instead of leaving the page empty");
  assert.match(client, /preview: true/, "the result is marked so nothing mistakes it for the original");
  assert.equal([...client.matchAll(/sharedImageLoader\(/g)].length, 1, "one place downloads (so progress, caching and de-duplication apply to previews too)");
});

test("the three images the page shows (subject, result, comparison subject) come from preview(), and none of them from image()", () => {
  assert.equal([...page.matchAll(/api\.preview\([^)]*trackImage\(/g)].length, 3);
  assert.equal([...page.matchAll(/api\.image\([^)]*trackImage\(/g)].length, 1, "the only tracked image() left is the export fetch of the original");
  assert.match(page, /api\.image\(result, controller\.signal\)/, "candidate images (their own flow) still use the original");
});

test("downloading, making a poster and recolouring take the original PNG, never the blob that is on screen", () => {
  assert.ok(!/downloadPng\(output\.blob/.test(page), "no download of the displayed result blob");
  assert.ok(!/makePoster\(output\.blob/.test(page) && !/makeRecolor\(output\.blob/.test(page), "no handoff of the displayed result blob");
  assert.match(page, /exportOriginal\(record\.result!\.assetId/, "the result's exports go through the original fetch");
  assert.match(page, /const exportOriginal = /);
  assert.match(page, /loadOriginal=\{/, "the comparison panel gets a way to fetch the originals for its two downloads");
});

test("the comparison panel downloads originals: the AI image from the server, and the free composition re-rendered from the full-resolution subject", () => {
  assert.ok(!/downloadPng\(ai,/.test(comparison), "no download of the displayed AI blob");
  assert.match(comparison, /loadOriginal\.ai\(\)/);
  assert.match(comparison, /loadOriginal\.foreground\(\)/);
  assert.match(comparison, /foreground\.preview/, "only a preview-based subject needs the full-resolution re-render; an original already is one");
});

test("drawing converts the original-pixel bounds to the decoded image's size, in both the editor/demo renderer and the free composition", () => {
  assert.match(renderer, /sourceRect\(asset,\s*image\)/);
  assert.ok(!/const crop = asset\.bounds/.test(renderer), "no raw asset.bounds crop left in drawComposition");
  assert.match(free, /sourceRect\(asset,\s*image\)/);
  assert.ok(!/const b=asset\.bounds/.test(free), "no raw asset.bounds crop left in renderFreeComposition");
});
