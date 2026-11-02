import assert from "node:assert/strict";
import test from "node:test";
import { serviceUrl } from "./service-url";

test("without a configured API origin the browser keeps using the same-origin forwarder (unchanged behaviour)", () => {
  assert.equal(serviceUrl("jobs"), "/workbench/api/internal/jobs");
  assert.equal(serviceUrl("jobs", ""), "/workbench/api/internal/jobs");
  assert.equal(serviceUrl("groups?kind=batch&limit=50", undefined), "/workbench/api/internal/groups?kind=batch&limit=50");
});

test("with an API origin the browser calls the private gateway's /comfy/v1 routes directly, so the page can be hosted as plain static files", () => {
  assert.equal(serviceUrl("capabilities", "https://pro-api.miaocut.app"), "https://pro-api.miaocut.app/comfy/v1/capabilities");
  assert.equal(serviceUrl("jobs/11111111-1111-1111-1111-111111111111/cancel", "https://pro-api.miaocut.app/"), "https://pro-api.miaocut.app/comfy/v1/jobs/11111111-1111-1111-1111-111111111111/cancel", "a trailing slash on the origin does not double up");
  assert.equal(serviceUrl("groups?kind=batch&limit=10", "https://pro-api.miaocut.app"), "https://pro-api.miaocut.app/comfy/v1/groups?kind=batch&limit=10");
});

test("only a plain https origin is accepted; plain http only for a local development gateway", () => {
  assert.equal(serviceUrl("capabilities", "http://127.0.0.1:8787"), "http://127.0.0.1:8787/comfy/v1/capabilities");
  assert.equal(serviceUrl("capabilities", "http://localhost:8787"), "http://localhost:8787/comfy/v1/capabilities");
  for (const bad of ["http://pro-api.miaocut.app", "https://user:secret@pro-api.miaocut.app", "https://pro-api.miaocut.app/some/path", "https://pro-api.miaocut.app?x=1",
                     "https://pro-api.miaocut.app#frag", "ftp://pro-api.miaocut.app", "not a url", "javascript:alert(1)"]) {
    assert.throws(() => serviceUrl("capabilities", bad), /api_configuration/, bad);
  }
});

test("a request path can never climb out of /comfy/v1 or point somewhere else", () => {
  for (const bad of ["../health", "jobs/../../auth/me", "//evil.example/x", "https://evil.example/x", "jobs\\x", "jobs#x", " jobs", "/jobs", "jobs?x=1#y"]) {
    assert.throws(() => serviceUrl(bad, "https://pro-api.miaocut.app"), /bad_path/, bad);
    assert.throws(() => serviceUrl(bad), /bad_path/, "the same rule applies to the forwarder: " + bad);
  }
});
