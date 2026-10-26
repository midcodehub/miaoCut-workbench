# 旧站编辑器引擎副本 / Vendored editor engine

`engine.js` 和 `presets.js` 是 [midcodehub/miaoCut](https://github.com/midcodehub/miaoCut) 主站的 `editor/` 目录里的原文件，**未做任何修改**。
工作台的“免费合成”（`src/client/free-composition.ts`）用它们渲染免费版的背景和阴影，所以与旧站的免费工具效果一致。

| 项目 | 值 |
|---|---|
| 来源仓库 | midcodehub/miaoCut |
| 取自 commit | `5719c95c291b8cec23ddb269c255d8f0f43321ca`（origin/main） |
| 这两个文件最后一次改动 | `4562b55` |
| engine.js SHA-256 | `0a2be26a9ada11ba8e168a58db7b4949da83be18e0ba1dc36b08e1dee39d3275` |
| presets.js SHA-256 | `876529549e2f880b7a9509640e9b0da2cc36222c73a2aa0489de9c0c9ced3d62` |

## 更新方法

旧站的 `editor/engine.js` 或 `editor/presets.js` 改了以后，免费合成不会自动跟着变。需要手动同步：

```bash
cp ../miaoCut/editor/engine.js ../miaoCut/editor/presets.js src/vendor/editor/
shasum -a 256 src/vendor/editor/*.js   # 把新哈希和 commit 写回上面的表
```

同步后重新跑 `npm test` 和 `npm run build`，并打开 `/workbench/compare` 确认免费合成仍能渲染。许可证与本仓库相同（MIT，见根目录 LICENSE）。
