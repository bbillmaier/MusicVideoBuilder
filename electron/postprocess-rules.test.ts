import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  cacheKey, defaultSettings, effectiveSettings, mp4VideoSize, normalizeSettings, PRESETS, processingRequested, resolveClip, resolveVramMode, timingProblems,
  type ResolveAttempt,
} from "./postprocess-rules";
import { buildPostprocessPrompt, schemaProblems, type PostJob } from "./postprocess-workflow";
import type { WorkflowTemplate } from "./workflow-template";

const template = JSON.parse(readFileSync(path.resolve(__dirname, "../workflows/07-postprocess-clip.json"), "utf-8")) as WorkflowTemplate;
const withMode = (faceMode: "preserve" | "restore" | "replace", upscale: boolean) => ({ ...defaultSettings(), faceMode, upscale });

test("settings validation rejects bad values and keeps valid ones", () => {
  const ok = normalizeSettings({ ...defaultSettings(), faceMode: "replace", advanced: { ...defaultSettings().advanced, batchSize: 13 } });
  assert.equal(ok.advanced.batchSize, 13);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), faceMode: "swap" }), /Face treatment/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), advanced: { ...defaultSettings().advanced, batchSize: 8 } }), /4n\+1/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), codeformerFidelity: 1.5 }), /fidelity/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), vramMode: "medium" }), /Memory mode/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), advanced: { ...defaultSettings().advanced, targetFacesIndex: "0;rm" } }), /Target face/);
  assert.equal(processingRequested(defaultSettings()), false);
  assert.equal(processingRequested(withMode("preserve", true)), true);
});

test("presets: Low VRAM starts at 3B FP8 / batch 5 / tiling; High VRAM at 7B FP16 / batch 9", () => {
  const low = effectiveSettings(withMode("preserve", true), "low_vram").upscale!;
  assert.equal(low.ditModel, "seedvr2_ema_3b_fp8_e4m3fn.safetensors");
  assert.equal(low.batchSize, 5);
  assert.equal(low.vaeTiling, true);
  assert.equal(low.ditOffload, "cpu");
  const high = effectiveSettings(withMode("preserve", true), "high_vram").upscale!;
  assert.equal(high.ditModel, "seedvr2_ema_7b_fp16.safetensors");
  assert.equal(high.batchSize, 9);
  assert.equal(high.ditOffload, "none");
  assert.equal(PRESETS.low_vram.frameRamBudgetGb < PRESETS.high_vram.frameRamBudgetGb, true);
  // BlockSwap requires an offload device even in High VRAM mode.
  const swapped = effectiveSettings({ ...withMode("preserve", true), advanced: { ...defaultSettings().advanced, blocksToSwap: 8 } }, "high_vram").upscale!;
  assert.equal(swapped.ditOffload, "cpu");
});

test("explicit job memory mode overrides the worker default; worker default follows the worker", () => {
  assert.deepEqual(resolveVramMode("low_vram", { value: "high_vram", error: null }), { mode: "low_vram", source: "job" });
  assert.deepEqual(resolveVramMode("worker_default", { value: "low_vram", error: null }), { mode: "low_vram", source: "worker" });
  assert.match((resolveVramMode("worker_default", { value: null, error: "POST_PROCESSING_VRAM_MODE='x' is not valid" }) as { error: string }).error, /invalid/);
  assert.match((resolveVramMode("worker_default", null) as { error: string }).error, /unknown/);
  assert.deepEqual(resolveVramMode("high_vram", null), { mode: "high_vram", source: "job" });
});

test("no duplicate CodeFormer: Replace restores inside ReActor, Restore uses only the standalone node", () => {
  const job = (faceMode: "restore" | "replace", upscale: boolean, restoreAfterSwap = true): PostJob => ({
    attemptId: "a", cacheKey: "k", sourceVideo: "martini_shot/p/r/s.mp4", referenceImage: faceMode === "replace" ? "martini_shot/p/assets/originals/me.png" : "",
    outputPath: "martini_shot/p/r/postprocess/clip_001/a.mp4", sourceSha256: "s", referenceSha256: "r", requestedVramMode: "low_vram",
    effective: effectiveSettings({ ...withMode(faceMode, upscale), restoreAfterSwap }, "low_vram"),
  });
  const replace = buildPostprocessPrompt(template, job("replace", true));
  const classes = Object.values(replace).map((node) => (node as { class_type: string }).class_type);
  assert.equal(classes.filter((name) => /Restore/.test(name)).length, 0);
  assert.equal((replace.face as { inputs: Record<string, unknown> }).inputs.face_restore_model, "codeformer-v0.1.0.pth");
  assert.deepEqual((replace.seedvr2 as { inputs: { image: unknown } }).inputs.image, ["face_unload", 0]);
  assert.deepEqual((replace.save as { inputs: { images: unknown } }).inputs.images, ["seedvr2", 0]);
  const noRestore = buildPostprocessPrompt(template, job("replace", false, false));
  assert.equal((noRestore.face as { inputs: Record<string, unknown> }).inputs.face_restore_model, "none");
  assert.equal(noRestore.seedvr2, undefined);
  const restore = buildPostprocessPrompt(template, job("restore", false));
  const restoreClasses = Object.values(restore).map((node) => (node as { class_type: string }).class_type);
  assert.deepEqual(restoreClasses.filter((name) => /ReActor(RestoreFace|FaceSwap)/.test(name)), ["ReActorRestoreFace"]);
  const preserve = buildPostprocessPrompt(template, { ...job("restore", true), effective: effectiveSettings(withMode("preserve", true), "high_vram") });
  assert.equal(preserve.face, undefined);
  assert.deepEqual((preserve.seedvr2 as { inputs: { image: unknown } }).inputs.image, ["load", 0]);
});

test("schema validation reports unknown inputs, bad combos, ranges, and missing classes", () => {
  const prompt = {
    a: { class_type: "Known", inputs: { model: "missing.safetensors", batch: 999, flag: "yes", extra: 1 } },
    b: { class_type: "Unknown", inputs: {} },
  };
  const info = { Known: { input: { required: { model: [["real.safetensors"]], batch: ["INT", { min: 1, max: 64 }], flag: ["BOOLEAN", {}], other: ["INT", {}] } }, output: ["IMAGE"] } };
  const problems = schemaProblems(prompt, info);
  assert.equal(problems.length, 6);
  assert.ok(problems.some((line) => /not installed/.test(line)));
  assert.ok(problems.some((line) => /no input extra/.test(line)));
  assert.ok(problems.some((line) => /required input other/.test(line)));
});

test("cache keys change with source, reference, pixel settings, mode, and workflow; not with offload", () => {
  const base = { sourceSha256: "s1", referenceSha256: "r1", effective: effectiveSettings(withMode("replace", true), "low_vram") };
  const key = cacheKey(base);
  assert.equal(cacheKey({ ...base }), key);
  assert.notEqual(cacheKey({ ...base, sourceSha256: "s2" }), key);
  assert.notEqual(cacheKey({ ...base, referenceSha256: "r2" }), key);
  assert.notEqual(cacheKey({ ...base, effective: effectiveSettings({ ...withMode("replace", true), codeformerFidelity: 0.5 }, "low_vram") }), key);
  assert.notEqual(cacheKey({ ...base, effective: effectiveSettings(withMode("replace", true), "high_vram") }), key);
  assert.notEqual(cacheKey({ ...base, workflowVersion: "next" }), key);
  const moved = effectiveSettings({ ...withMode("replace", true), advanced: { ...defaultSettings().advanced, offload: "none" } }, "low_vram");
  assert.equal(cacheKey({ ...base, effective: moved }), key);
  // The reference only matters when faces are replaced.
  const restore = { sourceSha256: "s1", referenceSha256: "r1", effective: effectiveSettings(withMode("restore", false), "low_vram") };
  assert.equal(cacheKey(restore), cacheKey({ ...restore, referenceSha256: "other" }));
});

const attempt = (id: string, status: ResolveAttempt["status"], key: string, at: string, extra: Partial<ResolveAttempt> = {}): ResolveAttempt =>
  ({ id, status, cacheKey: key, reviewRequired: false, outputOk: true, error: null, startedAt: at, ...extra });

test("artifact selection: originals, bypass, current results, review, stale, and failures never fall back silently", () => {
  const base = { rendered: true, requested: true, currentKey: "k2", attempts: [] as ResolveAttempt[], selection: null };
  assert.equal(resolveClip({ ...base, requested: false }).resolution.kind, "original");
  assert.equal(resolveClip({ ...base, selection: { choice: "original", attemptId: null } }).resolution.kind, "bypass");
  assert.equal(resolveClip(base).state, "needs_processing");
  assert.equal(resolveClip(base).resolution.kind, "unresolved");
  const done = resolveClip({ ...base, attempts: [attempt("a", "succeeded", "k2", "2026-01-01")] });
  assert.deepEqual(done.resolution, { kind: "processed", attemptId: "a", reason: "Current processed version." });
  const stale = resolveClip({ ...base, attempts: [attempt("a", "succeeded", "k1", "2026-01-01")] });
  assert.equal(stale.state, "stale");
  assert.equal(stale.resolution.kind, "unresolved");
  const review = resolveClip({ ...base, attempts: [attempt("a", "succeeded", "k2", "2026-01-01", { reviewRequired: true })] });
  assert.equal(review.state, "needs_review");
  const accepted = resolveClip({ ...base, attempts: [attempt("a", "succeeded", "k2", "2026-01-01", { reviewRequired: true })], selection: { choice: "processed", attemptId: "a" } });
  assert.equal(accepted.resolution.kind, "processed");
  const chosenStale = resolveClip({ ...base, attempts: [attempt("a", "succeeded", "k1", "2026-01-01")], selection: { choice: "processed", attemptId: "a" } });
  assert.equal(chosenStale.state, "stale");
  const vanished = resolveClip({ ...base, attempts: [attempt("a", "succeeded", "k2", "2026-01-01", { outputOk: false })] });
  assert.equal(vanished.resolution.kind, "unresolved");
  assert.equal(resolveClip({ ...base, rendered: false }).state, "not_rendered");
});

test("failure and retry: a failed retry keeps the earlier success; a lone failure stays unresolved", () => {
  const base = { rendered: true, requested: true, currentKey: "k", selection: null };
  const kept = resolveClip({ ...base, attempts: [attempt("old", "succeeded", "k", "2026-01-01"), attempt("new", "failed", "k", "2026-01-02", { error: "OOM" })] });
  assert.deepEqual(kept.resolution, { kind: "processed", attemptId: "old", reason: "Current processed version." });
  const failed = resolveClip({ ...base, attempts: [attempt("x", "failed", "k", "2026-01-02", { error: "CUDA out of memory" })] });
  assert.equal(failed.state, "failed");
  assert.match((failed.resolution as { reason: string }).reason, /out of memory/);
  assert.equal(resolveClip({ ...base, attempts: [attempt("x", "canceled", "k", "2026-01-02")] }).state, "canceled");
  assert.equal(resolveClip({ ...base, attempts: [attempt("x", "running", "k", "2026-01-02")] }).state, "running");
});

test("timing preservation check", () => {
  const source = { frames: 121, fps: "24/1", width: 1280, height: 720 };
  assert.deepEqual(timingProblems(source, { frames: 121, fps: "24/1", width: 1920, height: 1080 }), []);
  assert.equal(timingProblems(source, { frames: 120, fps: "24000/1001", width: 1920, height: 1080 }).length, 2);
  assert.equal(timingProblems(source, { frames: 121, fps: "24/1", width: 1080, height: 1080 }).length, 1);
});

test("mp4 tkhd size reader", () => {
  const boxOf = (type: string, body: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "latin1"); return Buffer.concat([head, body]); };
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(1280 * 65536, 76); tkhd.writeUInt32BE(720 * 65536, 80);
  const file = Buffer.concat([boxOf("ftyp", Buffer.alloc(8)), boxOf("moov", boxOf("trak", boxOf("tkhd", tkhd)))]);
  assert.deepEqual(mp4VideoSize((offset, length) => file.subarray(offset, offset + length), file.length), { width: 1280, height: 720 });
  assert.equal(mp4VideoSize((offset, length) => Buffer.alloc(0).subarray(offset, offset + length), 0), null);
});
