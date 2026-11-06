// 页面接线检查：图片下载的进度、失败提示和重新载入按钮不能被悄悄改没。
// 下载器本身的行为在 src/domain/asset-loader.test.ts 里逐条测；这里只盯“页面和客户端确实接上了它”。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const page = read("src/components/internal-workbench.tsx"), client = read("src/client/service-api.ts");

test("the service client downloads images through the verified, retrying, cached loader and no longer reads the body by itself", () => {
  assert.match(client, /from "@\/domain\/asset-loader"/);
  assert.match(client, /loadAsset\(/);
  assert.match(client, /browserAssetStore\(\)/);
  assert.ok(!/response\.blob\(\)/.test(client), "no direct response.blob() download path left in the client");
  assert.match(client, /new ServiceError\(error\.code, error\.status\)/, "loader errors keep their codes (asset_download_failed, asset_timeout, asset_mismatch)");
});

test("every image the internal workbench downloads reports progress and is released when the effect ends", () => {
  const calls = [...page.matchAll(/api\.image\(/g)].length;
  const tracked = [...page.matchAll(/api\.image\([^)]*trackImage\(/g)].length;
  const untracked = [...page.matchAll(/api\.image\(result, controller\.signal\)/g)].length;   // 候选图（后台预取），不占状态行
  assert.equal(tracked + untracked, calls, "each api.image( call is either tracked or a known background prefetch");
  assert.equal(tracked, 3, "display image, result image and comparison image");
  assert.equal([...page.matchAll(/finishImage\(/g)].length >= 9, true, "finished, failed and aborted loads all clear their progress entry");
});

test("the loading text, the failure text and the reload button exist in both languages, and a failed load offers to reload", () => {
  for (const key of ["loadingImage", "imageFailed", "retryImage"]) assert.equal([...page.matchAll(new RegExp(`${key}:`, "g"))].length, 2, `${key} is defined for zh and en`);
  assert.match(page, /"imageFailed" \| null/, "imageFailed is a known error state");
  assert.match(page, /\["asset_download_failed", "asset_timeout", "asset_mismatch"\]\.includes\(problem\.code\)/, "download failures are reported as imageFailed, not as a generic error");
  assert.match(page, /setImageRetry\(n => n \+ 1\)/, "the reload button restarts the image effects");
  assert.match(page, /imagePercent !== null && !pending \? `\$\{c\.loadingImage\} · \$\{imagePercent\}%`/, "the status line shows the download percentage");
});
