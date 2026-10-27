/**
 * 精确换色的耗时基准：npm run bench:recolor
 * 测的是 src/domain/recolor.ts 里的纯计算部分（Node 里单线程运行）。浏览器里还要加上 Canvas 读写像素和 PNG 编码的时间，
 * 这些由真实浏览器实测（见 README 的“精确换色”一节）。结果取每项 5 次中的中位数。
 */
import { accumulateLightness, buildTable, featherMask, meanLightness, recolorPixels, type LightnessSum } from "../src/domain/recolor";

const RUNS = 5;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function time(run: () => void): number {
  run(); // 预热，让 JIT 先编译
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) { const start = performance.now(); run(); samples.push(performance.now() - start); }
  return median(samples);
}
let seed = 12345;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

console.log(`node ${process.version} · ${process.platform}/${process.arch} · median of ${RUNS} runs (ms)`);
console.log("size".padEnd(12) + "mask".padEnd(8) + "mean-L".padStart(9) + "table×1".padStart(10) + "recolor".padStart(10) + "feather r=4".padStart(13));
for (const side of [1024, 2048, 4096]) {
  const count = side * side, data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < data.length; i++) data[i] = random() * 256;
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const coverage of [0.4, 1]) {
    // 一个居中的矩形，面积约占 coverage；“全图”就是整张图。
    const mask = new Uint8Array(count), half = Math.sqrt(coverage) * side / 2, lo = Math.round(side / 2 - half), hi = Math.round(side / 2 + half);
    for (let y = lo; y < hi; y++) mask.fill(255, y * side + lo, y * side + hi);
    const sum: LightnessSum = { sum: 0, weight: 0 };
    const meanTime = time(() => { sum.sum = 0; sum.weight = 0; accumulateLightness(data, mask, 0, count, sum); });
    const sourceL = meanLightness(sum) ?? 50;
    const tableTime = time(() => { buildTable("#C62828", sourceL); });
    const table = buildTable("#C62828", sourceL), out = new Uint8ClampedArray(data.length);
    const recolorTime = time(() => { out.set(data); recolorPixels(data, mask, table, out, 0, count); });
    const featherTime = time(() => { featherMask(mask, side, side, 4); });
    console.log(`${side}×${side}`.padEnd(12) + `${Math.round(coverage * 100)}%`.padEnd(8) + meanTime.toFixed(1).padStart(9) + tableTime.toFixed(1).padStart(10) + recolorTime.toFixed(1).padStart(10) + featherTime.toFixed(1).padStart(13));
  }
}
