// 静态导出计划的测试：哪些路由在静态站里不能存在、哪些页面的 force-dynamic 要在构建副本里去掉。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INTERNAL_PAGES, SERVER_ONLY, buildEnv, excludedPaths, exportConfig, stripDynamic } from "./static-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir) => readdirSync(dir).flatMap((name) => { const full = path.join(dir, name); return statSync(full).isDirectory() ? walk(full) : [full]; });

test("the static site never contains the server forwarder; the public build also drops every internal page", () => {
  assert.deepEqual(excludedPaths({ internal: true }), SERVER_ONLY);
  assert.deepEqual(excludedPaths({ internal: false }), [...SERVER_ONLY, ...INTERNAL_PAGES]);
  assert.ok(SERVER_ONLY.includes("src/app/api"));
  for (const page of ["src/app/batch", "src/app/compare", "src/app/login", "src/app/auth", "src/app/product/internal"]) assert.ok(INTERNAL_PAGES.includes(page), page);
});

test("force-dynamic is removed only from the build copy, and every page that uses it is accounted for in the plan", () => {
  const dynamicFiles = walk(path.join(root, "src/app")).filter((file) => /force-dynamic/.test(readFileSync(file, "utf8")));
  assert.ok(dynamicFiles.length >= 4, "the internal pages that read their flag at request time");
  for (const file of dynamicFiles) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    assert.ok([...SERVER_ONLY, ...INTERNAL_PAGES].some((prefix) => relative.startsWith(prefix + "/")), `${relative} must be listed, otherwise a new dynamic page silently breaks the static build`);
    assert.doesNotMatch(stripDynamic(readFileSync(file, "utf8")), /force-dynamic/, relative);
  }
  assert.equal(stripDynamic('export const dynamic = "force-dynamic";\nexport default function P(){}\n'), "\nexport default function P(){}\n");
  assert.equal(stripDynamic("export const dynamic='force-dynamic';\nx"), "\nx");
  assert.equal(stripDynamic("const keep = 1;"), "const keep = 1;");
});

test("the export config hosts everything under /workbench with directory-style URLs and no image optimiser", () => {
  const config = exportConfig();
  for (const piece of ['basePath: "/workbench"', 'output: "export"', "trailingSlash: true", "unoptimized: true"]) assert.ok(config.includes(piece), piece);
});

test("the build environment turns the internal pages and the direct API on together, and refuses an API address that is not a plain https origin", () => {
  assert.deepEqual(buildEnv({ internal: false }), { NEXT_PUBLIC_WORKBENCH_API_URL: "", WORKBENCH_INTERNAL_ENABLED: "" });
  const env = buildEnv({ internal: true, apiUrl: "https://pro-api.miaocut.app", sessionKey: "sb-abc-auth-token" });
  assert.equal(env.WORKBENCH_INTERNAL_ENABLED, "1");
  assert.equal(env.NEXT_PUBLIC_WORKBENCH_API_URL, "https://pro-api.miaocut.app");
  assert.equal(env.WORKBENCH_SESSION_STORAGE_KEY, "sb-abc-auth-token");
  assert.throws(() => buildEnv({ internal: true }), /api-url/, "internal pages without an API address would silently fall back to the forwarder that a static site does not have");
  for (const bad of ["http://pro-api.miaocut.app", "https://pro-api.miaocut.app/x", "https://u:p@pro-api.miaocut.app", "nonsense"]) assert.throws(() => buildEnv({ internal: true, apiUrl: bad }), /api-url/, bad);
});
