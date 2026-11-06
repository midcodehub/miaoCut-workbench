// 演示底图的体积和引用检查。
//
// 背景（2026-11-06 的实测，记录见 miaoCut-pro 的 docs/framework-first-landing-2026-11-02.md）：内测工作台首页要等 7.08 秒才“加载完成”，
// 最慢的一个请求是 /workbench/demo/marble.png（806 KB，6.0 秒）：这台机器到站点的下载速度只有约 120～250 KB/s，页面的 load 事件要等这张 CSS 背景图。
// 同一张图换成 WebP q90 只有 45 KB（和原图的 PSNR 44.4 dB，肉眼看不出差别）。
// 这个测试防止它退回去：演示底图必须是 WebP、总量有预算、代码里不能再引用已经删掉的 PNG。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(root, "public/demo");
const walk = (dir) => readdirSync(dir).flatMap((name) => { const full = path.join(dir, name); return statSync(full).isDirectory() ? walk(full) : [full]; });
const sources = walk(path.join(root, "src")).filter((file) => /\.(ts|tsx|css)$/.test(file));
const kb = (file) => statSync(file).size / 1024;

test("the marble backdrop is a small WebP and the 800 KB PNG is gone", () => {
  const webp = path.join(demo, "marble.webp");
  assert.ok(existsSync(webp), "public/demo/marble.webp exists");
  assert.ok(kb(webp) <= 60, `marble.webp is ${kb(webp).toFixed(0)} KB, the budget is 60 KB`);
  const head = readFileSync(webp).subarray(0, 12);
  assert.equal(head.subarray(0, 4).toString("latin1"), "RIFF");
  assert.equal(head.subarray(8, 12).toString("latin1"), "WEBP", "it really is a WebP, not a renamed PNG");
  assert.ok(!existsSync(path.join(demo, "marble.png")), "the static build copies public/ as it is, so a leftover PNG would still be shipped");
});

test("nothing in the source still points at the removed PNG, and every demo image that is referenced exists", () => {
  for (const file of sources) assert.ok(!/demo\/marble\.png|\/marble\.png/.test(readFileSync(file, "utf8")), `${path.relative(root, file)} still references marble.png`);
  const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  assert.match(css, /\.scene-marble\s*\{\s*background-image:\s*url\('\/workbench\/demo\/marble\.webp'\)/);
  const renderer = readFileSync(path.join(root, "src/client/demo-renderer.ts"), "utf8");
  assert.match(renderer, /\$\{ASSET_BASE\}\/marble\.webp/);
  for (const file of sources) {
    for (const [, name] of readFileSync(file, "utf8").matchAll(/\/workbench\/demo\/([A-Za-z0-9._-]+)/g)) assert.ok(existsSync(path.join(demo, name)), `${path.relative(root, file)} references demo/${name}, which does not exist`);
  }
});

test("the demo folder stays within a total byte budget, so a heavy backdrop cannot sneak back in", () => {
  const total = walk(demo).reduce((sum, file) => sum + statSync(file).size, 0) / 1024;
  assert.ok(total <= 120, `public/demo is ${total.toFixed(0)} KB, the budget is 120 KB (it was 803 KB with the PNG)`);
});
