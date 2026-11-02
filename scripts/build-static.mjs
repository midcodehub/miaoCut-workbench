// 把工作台构建成纯静态文件，放进 dist/workbench/，可以直接托管在 miaocut.app/workbench/ 下（Cloudflare Pages 的静态目录）。
//
// 用法：
//   node scripts/build-static.mjs                                    # 公开版：只有免费工具（海报文字、精确换色、本地演示），没有任何内测页
//   node scripts/build-static.mjs --internal --api-url https://pro-api.miaocut.app [--session-key sb-xxx-auth-token]
//                                                                    # 内测版：多出登录、AI 场景图、批量、对比页，浏览器直接请求私有网关
//
// 在临时目录里构建（复制源码 → 去掉静态站里不能有的路由 → 写入导出配置 → npm ci → next build），不改动这个仓库的工作树。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnv, excludedPaths, exportConfig, stripDynamic } from "./static-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COPY = ["src", "public", "package.json", "package-lock.json", "tsconfig.json", "postcss.config.cjs", "tailwind.config.cjs", "eslint.config.mjs"];

function parse(argv) {
  const options = { internal: false, out: path.join(root, "dist") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = () => argv[++i];
    if (flag === "--internal") options.internal = true;
    else if (flag === "--api-url") options.apiUrl = value();
    else if (flag === "--session-key") options.sessionKey = value();
    else if (flag === "--out") options.out = path.resolve(value());
    else throw new Error("unknown flag " + flag);
  }
  return options;
}
const walk = (dir) => readdirSync(dir).flatMap((name) => { const full = path.join(dir, name); return statSync(full).isDirectory() ? walk(full) : [full]; });
const run = (command, args, options) => { const done = spawnSync(command, args, { stdio: "inherit", ...options }); if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`); };

const options = parse(process.argv.slice(2));
const env = buildEnv(options);                                              // 先校验参数，再花时间构建
const work = mkdtempSync(path.join(os.tmpdir(), "workbench-static-"));
for (const entry of COPY) if (existsSync(path.join(root, entry))) cpSync(path.join(root, entry), path.join(work, entry), { recursive: true });
for (const excluded of excludedPaths(options)) rmSync(path.join(work, excluded), { recursive: true, force: true });
for (const file of walk(path.join(work, "src/app")).filter((name) => /\.(ts|tsx)$/.test(name))) {
  const before = readFileSync(file, "utf8"), after = stripDynamic(before);
  if (after !== before) writeFileSync(file, after);
}
writeFileSync(path.join(work, "next.config.ts"), exportConfig());
run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: work });
run("npx", ["next", "build"], { cwd: work, env: { ...process.env, ...env } });

const built = path.join(work, "out"), target = path.join(options.out, "workbench");
if (!existsSync(path.join(built, "index.html"))) throw new Error("the export has no index.html");
rmSync(target, { recursive: true, force: true });
mkdirSync(options.out, { recursive: true });
cpSync(built, target, { recursive: true });
const files = walk(target), commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim().length > 0;
writeFileSync(path.join(target, "BUILD.json"), JSON.stringify({
  commit, dirty, internal: options.internal, apiUrl: env.NEXT_PUBLIC_WORKBENCH_API_URL || null, builtAt: new Date().toISOString(),
  files: files.length, bytes: files.reduce((sum, file) => sum + statSync(file).size, 0),
  pages: files.filter((file) => file.endsWith("index.html")).map((file) => path.relative(target, path.dirname(file)) || "."),
}, null, 2) + "\n");
console.log(`built ${files.length} files into ${target}`);
rmSync(work, { recursive: true, force: true });
