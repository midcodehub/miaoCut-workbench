import test from "node:test";
import assert from "node:assert/strict";
import { emptyWorkspace } from "./model";
import type { ServiceJob } from "./service-contracts";
import { validInternalDraft } from "./service-state";
import {
  SCENE_CLIENT_DEADLINE_MS, SCENE_OUTPUT_GRACE, SCENE_POLL_MS, creditPhrase, historyFromJob, historyNeedsPoll, pollBackoffMs,
  rememberSceneJob, sceneHistory, scenePollErrorAction, scenePollStep, sceneSubmitAllowed, type ScenePollInput,
} from "./scene-job";

const asset = (id: string) => ({ assetId: id, mime: "image/png" as const, bytes: 10, sha256: "ab".repeat(32), width: 8, height: 8,
  bounds: { x: 0, y: 0, width: 8, height: 8 }, hasAlpha: true, transparent: true, sourceAssetId: null, expiresAt: 1, url: "https://example.test/a", urlExpiresAt: 2 });

function job(patch: Partial<ServiceJob> = {}): ScenePollInput["job"] {
  return { state: "queued", error: null, billing: { mode: "credits_internal", units: 2, state: "held" }, ...patch };
}
const step = (patch: Partial<ScenePollInput> & Pick<ScenePollInput, "job">) => scenePollStep({ kind: "product", startedAt: 0, now: 1_000, missingOutputs: 0, ...patch });

test("a cold GPU stays queued as 'starting' and submission is still allowed", () => {
  const cold = step({ job: job({ queue: { workerOnline: false } }) });
  assert.equal(cold.phase, "starting");
  assert.equal(cold.poll, true);
  assert.equal(cold.delayMs, SCENE_POLL_MS);
  assert.equal(step({ job: job({ queue: { workerOnline: true } }) }).phase, "queued");
  assert.equal(step({ job: job() }).phase, "queued", "a missing heartbeat field is not treated as offline");
  assert.equal(sceneSubmitAllowed(undefined), true);
  assert.equal(sceneSubmitAllowed(true), true);
  assert.equal(sceneSubmitAllowed(false), false, "the gateway's admission switch is the only block");
});

test("active states keep polling, and a late success still wins after the client deadline", () => {
  assert.equal(step({ job: job({ state: "leased" }) }).phase, "running");
  assert.equal(step({ job: job({ state: "verifying" }) }).phase, "verifying");
  assert.equal(step({ job: job({ state: "settling" }) }).phase, "settling");
  const late = step({ job: job({ state: "queued", queue: { workerOnline: false } }), now: SCENE_CLIENT_DEADLINE_MS + 1 });
  assert.equal(late.phase, "timeout");
  assert.equal(late.poll, true, "overtime slows the poll instead of stopping it, so a later success still appears");
  assert.ok(late.delayMs > SCENE_POLL_MS);
});

test("success publishes the result, a missing result is asked again, then stops", () => {
  const id = crypto.randomUUID();
  const done = step({ job: job({ state: "succeeded", billing: { mode: "credits_internal", units: 2, state: "confirmed" }, outputs: { final: asset(id) } }) });
  assert.deepEqual(done, { phase: "succeeded", poll: false, delayMs: 0, resultAssetId: id });
  const segment = scenePollStep({ kind: "segment", startedAt: 0, now: 1, missingOutputs: 0, job: job({ state: "succeeded", outputs: { foreground: asset(id) } }) });
  assert.equal(segment.resultAssetId, id);
  assert.equal(step({ job: job({ state: "succeeded", outputs: {} }), missingOutputs: 0 }).poll, true);
  assert.equal(step({ job: job({ state: "succeeded", outputs: {} }), missingOutputs: SCENE_OUTPUT_GRACE - 1 }).phase, "missing_output");
  assert.equal(step({ job: job({ state: "succeeded", outputs: {} }), missingOutputs: SCENE_OUTPUT_GRACE - 1 }).poll, false);
});

test("failure and cancel say refunded only when a paid hold was released", () => {
  assert.equal(step({ job: job({ state: "failed", error: "render_failed", billing: { mode: "credits_internal", units: 2, state: "released" } }) }).phase, "refunded");
  assert.equal(step({ job: job({ state: "failed", error: "render_failed", billing: { mode: "credits_internal", units: 0, state: "released" } }) }).phase, "failed");
  assert.equal(step({ job: job({ state: "failed", error: "job_expired", billing: { mode: "credits_internal", units: 2, state: "released" } }) }).phase, "expired");
  assert.equal(step({ job: job({ state: "cancelled", billing: { mode: "credits_internal", units: 2, state: "released" } }) }).phase, "refunded");
  assert.equal(step({ job: job({ state: "cancelled", billing: { mode: "unbilled_internal", units: 0 } }) }).phase, "cancelled");
  assert.equal(step({ job: job({ state: "failed", error: null, billing: { mode: "unbilled_internal", units: 0 } }) }).phase, "failed");
});

test("poll errors retry unless the request itself was rejected", () => {
  assert.equal(scenePollErrorAction(null, true), "retry");
  assert.equal(scenePollErrorAction({ status: 503, code: "control_unavailable" }, true), "retry");
  assert.equal(scenePollErrorAction({ status: 0, code: "network" }, true), "retry");
  assert.equal(scenePollErrorAction({ status: 401, code: "login_required" }, true), "reject");
  assert.equal(scenePollErrorAction({ status: 404, code: "job_not_found" }, true), "reject");
  assert.equal(scenePollErrorAction({ status: 410, code: "asset_expired" }, true), "expired_asset");
  assert.equal(scenePollErrorAction({ status: 402, code: "insufficient" }, false), "reject");
  assert.equal(scenePollErrorAction({ status: 409, code: "quote_expired" }, true), "retry", "a quote error on a job that already exists is not fatal");
  assert.equal(pollBackoffMs(1), SCENE_POLL_MS);
  assert.ok(pollBackoffMs(8) <= 15_000);
});

function productJob(id = crypto.randomUUID(), state: ServiceJob["state"] = "succeeded"): ServiceJob {
  const document = { ...emptyWorkspace(crypto.randomUUID()).document, revision: 2, sourceAssetId: crypto.randomUUID(), foregroundAssetId: crypto.randomUUID() };
  return { jobId: id, state, mode: "internal", error: null, billing: { mode: "credits_internal", units: 2, state: state === "succeeded" ? "confirmed" : state === "failed" ? "released" : "held" },
    request: { version: 1, requestId: crypto.randomUUID(), kind: "product", documentId: document.id, documentRevision: document.revision, sourceAssetId: document.sourceAssetId!,
      foregroundAssetId: document.foregroundAssetId, scene: "wood", canvas: document.canvas, placement: document.placement },
    ...(state === "succeeded" ? { outputs: { final: asset(crypto.randomUUID()) } } : {}) };
}

test("scene history keeps this browser's jobs, credits, and drops corrupt rows", () => {
  const done = productJob();
  const entry = historyFromJob(done, 500)!;
  assert.equal(entry.scene, "wood");
  assert.equal(entry.units, 2);
  assert.equal(entry.billing, "confirmed");
  assert.equal(entry.resultAssetId, done.outputs!.final!.assetId);
  assert.equal(creditPhrase(entry), "charged");
  assert.equal(creditPhrase({ ...entry, billing: "released" }), "refunded");
  assert.equal(creditPhrase({ ...entry, units: 0, billing: "released" }), "free");
  assert.equal(creditPhrase({ ...entry, billing: "held" }), "reserved");
  assert.equal(historyFromJob({ ...done, request: { ...done.request, kind: "segment" } }, 1), null, "subject extraction is not a scene job");

  const older = historyFromJob(productJob(), 100)!;
  const list = rememberSceneJob([older, { jobId: "nope" }, entry], entry);
  assert.deepEqual(list.map(row => row.jobId), [entry.jobId, older.jobId]);
  assert.equal(sceneHistory([entry, { ...entry, units: -1 }, null]).length, 1);
  const many = Array.from({ length: 25 }, (_, index) => historyFromJob(productJob(), index)!);
  assert.equal(sceneHistory(many).length, 20);
  assert.equal(sceneHistory(many)[0].createdAt, 24);
  assert.equal(historyNeedsPoll({ ...entry, state: "queued", resultAssetId: undefined }, entry.createdAt + 1000), true);
  assert.equal(historyNeedsPoll(entry, entry.createdAt + 1000), false, "a finished image does not need another poll");
  assert.equal(historyNeedsPoll({ ...entry, resultAssetId: undefined }, entry.createdAt + 1000), true, "success without a file is polled until it appears");

  const draft = { version: 1 as const, authUserId: crypto.randomUUID(), document: entry.document, view: "draft" as const, history: list,
    pending: { request: { ...done.request, documentId: entry.document.id, sourceAssetId: entry.document.sourceAssetId! }, startedAt: 10 } };
  assert.equal(validInternalDraft(JSON.parse(JSON.stringify(draft))), true);
  assert.equal(validInternalDraft({ ...draft, history: { jobId: entry.jobId } }), false);
  assert.equal(validInternalDraft({ ...draft, pending: { ...draft.pending, startedAt: "soon" } }), false);
});
