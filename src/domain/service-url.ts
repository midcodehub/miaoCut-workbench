/**
 * 浏览器请求私有网关（/comfy/v1/*）时用的地址。
 *
 * 两种方式：
 * - 没配置 API 地址（默认）：走同源的转发路由 /workbench/api/internal/<路径>，需要服务端运行环境（next start）；
 * - 配置了 API 地址（构建时的 NEXT_PUBLIC_WORKBENCH_API_URL）：浏览器直接请求 <API 地址>/comfy/v1/<路径>。
 *   网关本来就要求登录令牌、校验名单和资产归属，并且 CORS 白名单已经放行 miaocut.app，
 *   所以工作台可以导出成纯静态文件，托管在现有的静态站（Cloudflare Pages）上，不需要任何服务端。
 *
 * 放在 domain 目录是为了能被单元测试直接覆盖（路由文件只能导出固定名字的处理函数）。
 */
const LOCAL = new Set(["127.0.0.1", "localhost"]);

/** 请求路径只能是网关接口的相对路径：不能往上爬、不能是绝对地址、不能带片段。 */
function checkPath(path: string): void {
  const [route, query = ""] = path.split("?", 2);
  if (!route || route.startsWith("/") || /[\s\\#:]|\.\.|\/\//.test(path) || query.includes("?")) throw new Error("bad_path");
}

/** 返回完整的请求地址。API 地址不合格抛 api_configuration，路径不合格抛 bad_path。 */
export function serviceUrl(path: string, apiOrigin?: string): string {
  checkPath(path);
  if (!apiOrigin) return `/workbench/api/internal/${path}`;
  let url: URL;
  try { url = new URL(apiOrigin); } catch { throw new Error("api_configuration"); }
  const secure = url.protocol === "https:", localHttp = url.protocol === "http:" && LOCAL.has(url.hostname);
  if (!(secure || localHttp) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("api_configuration");
  return `${url.origin}/comfy/v1/${path}`;
}
