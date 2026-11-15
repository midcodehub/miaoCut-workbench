// 冷 GPU 不能把提交按钮关掉：网关 createJob 不看心跳。预览只用于显示，下载走原图。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const page = read("src/components/internal-workbench.tsx");
const batchPage = read("src/components/batch-workbench.tsx");
const batch = read("src/client/use-batch.ts");

test("scene and batch submit stay enabled when the GPU heartbeat is offline", () => {
  assert.match(page, /sceneSubmitAllowed\(/);
  assert.ok(!/execution\s*!==\s*['"]online['"]/.test(page), "the scene page must not treat a missing heartbeat as a disabled control");
  assert.ok(!/execution\s*!==\s*['"]online['"]/.test(batch));
  assert.match(batch, /sceneSubmitAllowed\(/);
  assert.match(page, /c\.starting/);
  assert.match(page, /c\.coldGpu/);
  assert.match(batchPage, /startingGpu/);
});

test("batch result images are previews, and zip/download ask for the original PNG", () => {
  assert.match(batch, /api\.preview\(asset, signal\)/);
  assert.match(batch, /shown\.preview !== true/);
  assert.match(batch, /api\.image\(await api\.asset\(asset\.assetId\)\)/);
  assert.ok(!/downloadPng\(image\.blob/.test(batch));
});
