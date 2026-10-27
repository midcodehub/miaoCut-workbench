/**
 * 内部 API 转发层（src/app/api/internal/[...path]/route.ts）对查询串的唯一例外：
 * “列出我的批次” GET /groups?kind=batch&limit=N。
 *
 * 转发层原本拒绝任何带查询串的请求，这样前端换不出新的服务端入口。现在只放行这一个读取接口，
 * 而且只认两个参数、值必须落在白名单里；放行时不是原样转发浏览器给的查询串，而是用校验过的值重新拼一份，
 * 所以多余的参数、重复的参数、编码花样都到不了私有网关。
 *
 * 放在 domain 目录而不是 route.ts 里：Next 的路由文件只能导出 GET/POST 等固定名字，
 * 放在这里才能被单元测试直接覆盖。
 */
export const LIST_KINDS = ["batch", "candidates"] as const;
const LIMIT = /^(?:[1-9]|[1-4][0-9]|50)$/;

/** 返回可以安全拼在 URL 后面的查询串（"" 或 "?kind=batch&limit=10"）；参数不合格返回 null。 */
export function listQuery(search: URLSearchParams): string | null {
  for (const key of search.keys()) if (key !== "kind" && key !== "limit") return null;
  if (search.getAll("kind").length > 1 || search.getAll("limit").length > 1) return null;
  const kind = search.get("kind"), limit = search.get("limit"), query = new URLSearchParams();
  if (kind !== null) {
    if (!(LIST_KINDS as readonly string[]).includes(kind)) return null;
    query.set("kind", kind);
  }
  if (limit !== null) {
    if (!LIMIT.test(limit)) return null;
    query.set("limit", limit);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
