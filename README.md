# MiaoCut Scene Workbench

独立 Next.js 商品场景工作台，包含P0交互演示、真实服务内测入口，以及免费/AI效果对比。本仓库从 [midcodehub/miaoCut](https://github.com/midcodehub/miaoCut) 拆出：旧站是直接发布仓库根目录的静态站，放不下需要服务端路由的 Next 应用，所以工作台有自己的仓库和部署。后端（任务、积分、GPU 调度）在私有仓库，这里只有界面、公开业务类型和受限转发。

Independent Next.js product-scene workbench with a local demo, an internal API route, and free/AI result comparison. Split out of midcodehub/miaoCut, whose root is published as static files and cannot host a Next app with server routes. The backend lives in a private repository.

`/workbench/poster`是免费的海报文字编辑器（见下文“海报文字”），`/workbench/recolor`是免费的精确换色（见下文“精确换色”）。`/workbench/compare`可直接查看两组之前真实GPU产出的样图，切换免费背景、并排/滑动对比并分别下载。无需账号，不启动GPU或扣积分。免费合成使用`src/vendor/editor/`里的旧站编辑器引擎副本（原文件、来源 commit 和更新方法见该目录 README）。`public/comparison/provenance.json`保留来源和哈希，公开素材只含原有样图与自建测试图，没有用户上传图。内部工作台也接入同一对比组件；离线或状态未知时暂停新的上传/AI生成，已有主体仍可本地合成。

## 启动 / Run

要求 Node.js 20.9+；当前使用 Node.js 22。

```bash
npm ci
npm run dev
```

打开 <http://127.0.0.1:3100/workbench/product>。`/workbench` 也显示同一工作台。没有环境变量或云端密钥要求。

```bash
npm run check
npm run lint
npm test
npm run build
npm start
```

`basePath` 固定为 `/workbench`，静态资源也包含该前缀。修改路径后必须重新构建。工作台有独立样式入口，沿用旧站的字体、品牌色和暗色约定（主题已内联在 `tailwind.config.cjs`）、Geist 字体和 Quiet Workbench 视觉规则。

## 可以体验什么 / What works

| 功能 / Feature | P0 行为 / Behavior |
|---|---|
| 商品槽 / Product slot | PNG、JPG、WebP，最大 10 MB、16,777,216 像素；图片留在浏览器 |
| 示例 / Sample | 复用仓库已有透明运动鞋，可直接体验 |
| 普通照片 / Regular photo | 预览原图并显示“待提取主体”；生成按钮禁用，避免假装已抠图 |
| 透明素材 / Transparent image | 检查真实 Alpha 包围盒，允许本地示意合成 |
| 场景 / Scenes | 大理石、原木、极简几何；固定背景与 Canvas 阴影，均明确标注为示意 |
| 构图 / Composition | 拖动、等比缩放、大小滑块、水平居中、复位、三分辅助线 |
| 键盘 / Keyboard | 主体方向键移动，Shift 加大步长；缩放控制点方向键改变大小；视图 Tab 支持左右键与 Home/End |
| 演示任务 / Demo jobs | 排队、准备、合成、保存、取消；阶段只用于演示，不能代表真实推理速度 |
| 结果 / Results | 独立的只读结果视图，下载 1024×1024 PNG，继续编辑指定版本 |
| 版本 / Versions | 本地最多保留 6 个版本；淘汰时优先保留当前查看的版本 |
| 恢复 / Restore | IndexedDB 保存素材 Blob、文档、任务和结果；刷新恢复原演示任务 ID |
| 显示 / Display | 中英文、浅色／深色、桌面三栏、手机纵向布局、减少动态效果偏好 |

**没有连接**真实主体提取、生成模型、上传服务、任务队列、账户或积分。不应把此模式部署为收费能力，也不应把固定演示阶段当成生产时延指标。

No image upload or render-job API is called. This mode must remain clearly labeled as a demo until a real service is connected.

## 状态与坐标 / State and coordinates

```text
编辑文档 ProductDocument
  └─提交时复制为不可变 DemoJob.snapshot
      └─完成产出 LocalResult（PNG + 原始快照）
```

- 资产 `bounds` 使用原图像素坐标；文档 `placement` 使用画布 0～1 坐标，表示可见主体包围盒。绘制时把源 `bounds` 映射到 `placement × 1024`，预览与导出共用同一函数。
- 编辑文档增加 `revision`；任务不读取之后修改的编辑文档。迟到结果进入历史，不能覆盖更新后的构图。
- 连续点击通过同步提交锁和 reducer 双重限制；重复完成、旧任务回报、取消后的回报均不能重复添加结果。
- 加载图片与演示任务使用各自的生命周期控制；替换素材不会改写执行中任务的原始素材。
- 刷新恢复的是本地演示。真实接入时应查询服务端原任务，不能在浏览器重新执行付费任务。
- `CreateProductJobRequest` 是公开业务类型草案，只有资产、场景与构图参数，不含任何模型工作流。正式服务端接入仍需版本化校验与授权。

## 文件入口 / Code map

| 位置 / Path | 职责 / Responsibility |
|---|---|
| `src/components/product-workbench.tsx` | 页面与槽位交互 |
| `src/components/editor-canvas.tsx` | 画布、指针与键盘操作 |
| `src/domain/contracts.ts` | 文档、任务、资产、结果业务类型 |
| `src/domain/model.ts` | 状态机、包围盒变换、版本与持久化校验 |
| `src/domain/model.test.ts` | 任务竞争、结果隔离、比例边界和恢复数据测试 |
| `src/client/use-workbench.ts` | 页面生命周期、操作和演示任务执行 |
| `src/client/local-store.ts` | IndexedDB 读写、串行保存 |
| `src/client/demo-renderer.ts` | 本地 Canvas 示意合成与 PNG 导出 |
| `src/client/i18n.ts` | 中英文文案 |

## 本地数据与素材 / Local data and assets

素材和演示结果存于 IndexedDB `miaocut-workbench-demo-v1`。页脚“清除本地草稿”会移除当前工作台的素材和历史并恢复示例；已经下载的 PNG 保留。浏览器清理站点数据也会丢失这些本地内容，因此这里不是云端作品库。自动保存有约 250 ms 防抖；存储失败会显示提示。

语言使用 `mc.workbench.locale`；主题沿用旧站 `theme` 偏好。清除工作台不清除账户凭据或站点其他存储。

- `public/demo/sneaker.webp`：复制自旧站仓库 midcodehub/miaoCut 的 `examples/product-cutout.webp`。
- `public/demo/marble.png`：用于本地展示的固定空场景图片，已移除生成参数等元数据。
- 原木与几何场景由浏览器绘制，不会调用生成服务。
- 字体使用 `public/fonts/` 里的本地 Geist 文件，不请求外部字体服务。

下一步接入真实服务时，在公开前端只保留业务契约与 UI。凭据、授权、计费、调度以及模型编排属于服务端。

## 海报文字 / Poster text（`/workbench/poster`）

给商品图加标题、卖点和价格。**文字是确定性渲染的**：内容逐字一致，位置就是文本框的归一化坐标 `[x1,y1,x2,y2]`（0～1，与后续 AI 海报接口的文本框契约相同）。修改文字不触发任何 GPU 任务，不收费，也不需要登录；全部在浏览器里完成。

| 项目 | 行为 |
|---|---|
| 画布 | 固定 1:1、1024×1024 PNG。其他画幅等各自通过认证后再开放 |
| 背景 | 纯色，或上传 PNG/JPG/WebP（最大 10 MB）。图片按“填满”居中裁切 |
| 文字框 | 最多 8 个，每个最多 300 字，换行保存为真实换行符。拖动移动，右下角缩放，方向键微调（Shift 加快），Delete 删除 |
| 字号 | 自动适应文本框：取“放得下的最大字号”。放不下最小字号（8px）时提示“文字超出文本框”，不会悄悄缩到看不清 |
| 样式 | 字体（黑体/宋体）、常规/粗体、左中右对齐、颜色；可调整叠放顺序 |
| 保存 | 工程（不含图片）和背景图存在 IndexedDB `miaocut-workbench-poster-v1`，刷新后恢复；校验不通过的记录不会变成画布状态 |
| 入口 | 场景工作台（内部页）的结果页和候选预览里有“做成海报”：把结果图交给海报页做背景，**只换背景、文字保持不变** |

价格、日期、数字直接写进文字里，导出时逐字保留。

**字体：** 拉丁字母用随应用打包的 Geist（SIL OFL）；中文等非拉丁字符回退到访客设备上的系统字体，所以同一份工程在不同设备上的中文字形可能不同。需要统一字形时，要挑选并打包一款可商用的开源中文字体（体积为数 MB），目前没有做。

**导出就是屏幕上的像素：** 导出时在用户正在看的预览画布上重画一次再 `toBlob`，而不是另建离屏画布。实测同一段文字画在“挂在页面上的画布”和“游离的画布”上，Chrome 给出的像素并不相同（约 1.6 万个像素不同，笔画边缘和约 1px 的基线位置会变），另建画布导出的图就会和屏幕上看到的不一样。见 `src/client/poster-renderer.ts`。

**从结果页交接背景图：** 场景工作台和换色页把图写进同源 IndexedDB 的待取区，海报页启动时读取。读取**不删除**，等工程连同新背景保存成功后才清除：开发模式下 React 会把 effect 执行两次，“读到就删”会让第二次读不到、背景换不上。超过 1 小时的记录、类型不对或超过 32 MB 的记录会被忽略。

| 位置 / Path | 职责 / Responsibility |
|---|---|
| `src/domain/poster.ts` | 文本框几何、增删改与上限、自动适配字号和换行（`fitText`/`wrapText`）、本地记录校验。纯函数，不碰 DOM |
| `src/domain/poster.test.ts` | 上述逻辑的单元测试（用确定的假度量，不依赖浏览器字体） |
| `src/client/poster-renderer.ts` | Canvas 绘制与导出 |
| `src/client/poster-store.ts` | IndexedDB：工程保存与结果页交接（底层封装在 `src/client/idb.ts`，与换色页共用） |
| `src/client/use-poster.ts` | 页面状态：恢复、保存、背景上传、交接套用 |
| `src/components/poster-workbench.tsx` | 页面：画布、文本框叠加层、属性面板 |

当前没有做：贴纸、AI 艺术字、多画幅、统一的中文字体。删除文字框后键盘焦点不会自动转到相邻的文本框。

## 精确换色 / Exact recolour（`/workbench/recolor`）

用画笔涂出要换色的区域，选 1～8 个颜色，每个颜色立刻出缩略图预览，选中的颜色在主画布上按**原图尺寸**显示，可下载 PNG 或交给海报页做背景。全部在浏览器里完成：不上传图片，不用 GPU，不收费，不需要登录。

**算法**（`src/domain/recolor.ts`）：在 CIE Lab 空间里把涂抹区域的色相和彩度换成目标色，同时把明度整体平移到目标色的明度，**但保留每个像素相对于平均明度的起伏**，所以褶皱、纹理、明暗关系都还在。

- 明度映射 `mapLightness`：被涂抹区域的平均明度正好变成目标色的明度；变亮时白色不动、变暗时黑色不动，所以不会把高光或暗部裁掉；斜率恒为正，明暗顺序不会颠倒。
- 彩度：比目标色更亮的部分逐渐回到中性（越亮越不饱和，像真实的高光）；放不进 sRGB 的颜色保持明度和色相、只压低彩度（`gamutMap`，二分 12 次）。
- 整个映射只依赖像素的明度，所以每个目标色预先算好一张 4096 项的“源明度 → RGB”查找表（约 2 ms），逐像素只需算一次明度、查一次表。
- 遮罩：笔画（归一化坐标，与图片分辨率无关）重放到全分辨率画布得到抗锯齿的遮罩，再用三次方框模糊柔化边缘（耗时与半径无关）。**遮罩值为 0 的像素完全不碰，字节与原图相同**；alpha 通道永远不改。
- 明暗跨度超过 35（Lab 的 L，满量程 100）时提示“原来的纹理会变淡”：例如深色换成白色，原来的纹理几乎没有可保留的信息。

| 项目 | 行为 |
|---|---|
| 底图 | PNG/JPG/WebP，10 MB、1600 万像素以内；也可以用示例图，或从场景工作台的结果页带过来（“精确换色”按钮，同海报页的交接机制） |
| 画笔 | 画笔 / 橡皮、大小 4～160（按 1024 像素长边计，图越大按比例放大）、边缘柔化 0～12；撤销 / 重做 / 清除（清除也可以撤销）；Ctrl/⌘+Z、Ctrl/⌘+Shift+Z |
| 上限 | 最多 300 笔、总计 6 万个点，超过后提示撤销或清除 |
| 颜色 | 最多 8 个；常用色一键添加，也可以改当前颜色。每个颜色一张缩略图（在缩小的底图上用同一套算法算出） |
| 输出 | 原图尺寸 PNG，文件名 `<原文件名>-<颜色>.png`；空遮罩不能导出。导出的就是屏幕主画布上的像素（实测逐字节相同） |
| 保存 | 底图和编辑状态分开存在 IndexedDB `miaocut-workbench-recolor-v1`（每涂一笔只重写几 KB 的编辑状态）；更换底图后涂抹作废，颜色保留 |
| 入口 | 页眉链接；结果页和候选预览里的“精确换色”；换色页的“做成海报”把当前颜色的结果交给海报页做背景（超过 32 MB 时提示先下载再上传） |

**耗时**（不是优化，是实测数据，方便后续对比）。计算部分用 `npm run bench:recolor` 在 Node 22 / Apple Silicon 上测，取 5 次中位数，单位 ms：

| 图片 | 遮罩面积 | 求平均明度 | 建查找表 ×1 | 换色（含 64 MB 拷贝） | 柔化 r=4 |
|---|---|---|---|---|---|
| 1024×1024 | 40% / 100% | 12.9 / 19.1 | 2.2 / 1.9 | 30.0 / 69.5 | 34.6 / 33.7 |
| 2048×2048 | 40% / 100% | 33.9 / 76.1 | 1.9 / 1.9 | 118 / 279 | 134 / 133 |
| 4096×4096 | 40% / 100% | 135.6 / 305.2 | 1.8 / 1.9 | 471 / 1116 | 535 / 534 |

浏览器里（Chromium，一张 4096×4096 合成 PNG、遮罩占 17%）：涂抹一笔后重算遮罩、柔化、平均明度、缩略图并在原图尺寸上算出选中的颜色，**约 1.65～2.1 s**；只切换颜色（重画主画布）约 0.46～0.49 s，期间没有超过 50 ms 的主线程阻塞；导出 6.1 MB 的 PNG 约 0.86～1.98 s。大图上的处理按每段 26 万像素切开、段间让出主线程；柔化原本是一次 547～599 ms 的阻塞，改成三次之后最长一次阻塞约 185～265 ms。1600 万像素以内的图都能处理；常见的 1024～2048 像素的图在浏览器里没有单独测过，按上表 Node 数据估计换色本身在几十到几百毫秒。

**已验证的事实**（单元测试 + 真实浏览器，见 PR 描述）：遮罩外的像素字节不变（浏览器里 4062 个变化像素全部落在笔画半径加柔化范围之内）；alpha 不变；平色区域换色后等于目标色（±1）；撤销后主画布与原图逐字节相同；导出的 PNG 与主画布逐字节相同；刷新后恢复底图、笔画和颜色；从换色页交给海报页、从待取区交给换色页都能走通。

| 位置 / Path | 职责 / Responsibility |
|---|---|
| `src/domain/recolor.ts` | Lab 转换、明度映射、查找表、逐像素换色、遮罩柔化、笔画与撤销/重做。纯函数，不碰 DOM |
| `src/domain/recolor.test.ts` | 上述逻辑的单元测试（参考值、单调性、字节不变、分段处理一致等） |
| `scripts/bench-recolor.ts` | 耗时基准（`npm run bench:recolor`） |
| `src/client/recolor-engine.ts` | 解码底图、笔画重放成遮罩、分段处理、PNG 编码 |
| `src/client/recolor-store.ts` | IndexedDB：底图、编辑状态、结果页交接 |
| `src/client/idb.ts` | 海报页和换色页共用的 IndexedDB 封装和结果页交接逻辑 |
| `src/client/use-recolor.ts` | 页面状态：恢复、遮罩与缩略图计算、保存、导出 |
| `src/components/recolor-workbench.tsx` | 页面：画笔叠加层、颜色卡片、导出 |

当前没有做：按颜色相似度限制范围（涂到的都会换，包括不想换的背景或别的颜色，所以需要涂得准）、“只涂商品内”（没有前景资产）、一次下载全部颜色（ZIP）、AI 换色（深浅跨度很大或需要重新渲染光影时）。涂抹需要鼠标、触控笔或手指，没有键盘涂抹方式；触屏上手指落在图上是涂抹而不是滚动。带不透明度的半透明像素在 Canvas 里是预乘存储，保存回来可能有 ±1 的舍入，完全不透明的图不受影响。带色彩配置文件的图会被浏览器先转成 sRGB，导出的 PNG 不带配置文件。Safari 和 Firefox 没有测过。

## 内部 API 联调入口 / Internal API route

新增 `/workbench/product/internal`，它调用服务端任务 API。该页和 `/workbench/api/internal/*` **默认返回 404**；原 `/workbench/product` 继续是本地演示。未增加旧站的生产导航。

在内部部署的 `.env.local` 设置（不要提交）：

```dotenv
WORKBENCH_INTERNAL_ENABLED=1
WORKBENCH_API_URL=https://YOUR_AUTHORIZED_API_HOST
WORKBENCH_SESSION_STORAGE_KEY=sb-YOUR_PROJECT_REF-auth-token
```

服务端必须已提供同版本 `/comfy/v1` 资产、任务与能力接口，并授权该内部测试账户。工作台复用同源已有 Supabase 会话，不接受模型图、R2 管理凭据或第二套钱包。跨域部署的会话交接与完整登录刷新仍需单独验收；本页遇到 401 会提示回原账户登录，并保留任务记录。

此模式将输入按显示方向解码成不缩放的 PNG 后上传，接收服务端真实 Alpha 包围盒，复用前景资产创建场景任务。它保存 requestId 和原 jobId，刷新查询原任务；网络失败后的恢复继续使用同一幂等请求。内部模式明确零扣费，不代表已开放商业服务。

The internal route uses server API job states. It is disabled by default, reuses the existing same-origin session, preserves idempotency across refresh, and requires a matching authorized backend. Model quality, real GPU execution, production authentication and billing still need separate acceptance testing.


## 原账户登录与积分内测协议（2026-10-26）

内部服务路由增加 `/workbench/login` 和固定 `/workbench/auth/callback`。配置 `.env.example` 中的原 Supabase 项目公开 URL/key，沿用原账户 storage key，支持 PKCE 登录与令牌自动续期。真实登录前需在原 Auth 项目配置精确回调地址。

v2 能力接口提供服务端报价：内测提取主体0积分，单张场景2积分。点击生成先展示报价和可用积分，确认后提交 `{quoteId,request}`。本地保存 quoteId 和原 requestId 以恢复丢失响应；显示预留、扣减、释放及结算确认状态。暂停新任务时保留已有任务查询，不切回免费提交。

资金、素材权限与任务编排均由私有网关负责。本仓库不配置服务角色密钥或收费开关。P0 `/workbench/product` 继续是本地交互演示，内部路由仍默认关闭；真实用户 OAuth、云端积分与 GPU 联合验收尚未完成。

2026-10-26 账号联调更新：Google登录会明确选择账号，登录页显示当前浏览器账号；内测白名单拒绝会提示切换账户。用于避免浏览器默认Google会话误入内部测试。
