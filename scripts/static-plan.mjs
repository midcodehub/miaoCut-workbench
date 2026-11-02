// 静态导出的“计划”：哪些路由在静态站里不能存在、构建副本里要改什么、构建时要设哪些环境变量。
// 单独成文件是为了能被单元测试覆盖（构建脚本本身要跑 npm ci 和 next build，太重）。
//
// 为什么能做成静态站：工作台只有一个服务端路由（src/app/api/internal，一层很薄的转发），而私有网关本来就要求登录令牌、
// 校验名单和资产归属，CORS 白名单也已经放行 miaocut.app，所以浏览器可以直接请求网关（见 src/domain/service-url.ts），
// 转发层就不需要了。其余页面都是浏览器端代码。

/** 服务端路由：静态站里永远不能有（next export 不支持带 POST 的路由处理函数）。 */
export const SERVER_ONLY = ["src/app/api"];
/** 只给内测联调用的页面：登录、登录回调、需要账号才能用的 AI 场景图、批量页、免费/AI 对比页。公开的免费工具构建不带它们。 */
export const INTERNAL_PAGES = ["src/app/auth", "src/app/login", "src/app/product/internal", "src/app/batch", "src/app/compare"];

export function excludedPaths({ internal }) {
  return internal ? [...SERVER_ONLY] : [...SERVER_ONLY, ...INTERNAL_PAGES];
}

/** 内测页原来用 force-dynamic 在“请求时”读开关；静态站里没有请求时，开关改成构建时读。只改构建副本，仓库里的文件不动（next start 模式照旧）。 */
export function stripDynamic(source) {
  return source.replace(/^export const dynamic\s*=\s*["']force-dynamic["'];?[ \t]*$/gm, "");
}

/** 静态导出用的 Next 配置：挂在 /workbench 下、目录式地址（/workbench/poster/）、不用图片优化服务。 */
export function exportConfig() {
  return [
    'import type { NextConfig } from "next";',
    'const config: NextConfig = { basePath: "/workbench", poweredByHeader: false, output: "export", trailingSlash: true, images: { unoptimized: true } };',
    "export default config;",
    "",
  ].join("\n");
}

/** 只认 https 的纯来源（本地开发可以是 http://127.0.0.1 或 localhost）；带路径、查询、账号密码的一律拒绝。 */
function checkApiUrl(apiUrl) {
  let url;
  try { url = new URL(apiUrl); } catch { throw new Error("--api-url must be a plain https origin"); }
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!(url.protocol === "https:" || local) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("--api-url must be a plain https origin");
  }
  return url.origin;
}

/**
 * 构建时的环境变量。内测页打开时必须同时给出网关地址：否则页面会退回到静态站没有的转发路由，到用户手里才发现请求全部 404。
 * NEXT_PUBLIC_ 开头的会被编进浏览器代码，所以这里只放公开信息（网关地址、会话存储键），不放任何密钥。
 */
export function buildEnv({ internal, apiUrl, sessionKey }) {
  if (!internal) return { NEXT_PUBLIC_WORKBENCH_API_URL: "", WORKBENCH_INTERNAL_ENABLED: "" };
  if (!apiUrl) throw new Error("--api-url is required with --internal");
  return {
    NEXT_PUBLIC_WORKBENCH_API_URL: checkApiUrl(apiUrl), WORKBENCH_INTERNAL_ENABLED: "1",
    ...(sessionKey ? { WORKBENCH_SESSION_STORAGE_KEY: sessionKey } : {}),
  };
}
