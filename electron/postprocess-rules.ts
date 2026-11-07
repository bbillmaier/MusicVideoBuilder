// Pure post-processing rules: settings, memory presets, cache keys, and how each clip resolves for the final stitch.
// No Electron or SQLite imports, so everything here is unit-tested with plain Node (postprocess-rules.test.ts).
import { createHash } from "node:crypto";
import type {
  ClipMode, PostAdvancedSettings, PostAttemptStatus, PostClipState, PostFaceMode, PostPreset, PostResolution, PostResolvedVramMode, PostSettings,
  PostVramMode,
} from "./contracts";
import { POST_ATTENTION_MODES, POST_COLOR_CORRECTIONS, POST_DLSS5_FPS, POST_DLSS5_SCALES, POST_DLSS5_STYLES, POST_FACE_MODES, POST_FACE_ORDERS, POST_OUTPUT_EDGES, POST_VRAM_MODES } from "./contracts";

/** Changes whenever the graph the app builds, or the nodes' save/validation contract, would change output pixels. Part of
 *  every cache key, so a new version makes earlier results stale instead of silently reusing them. */
export const POSTPROCESS_WORKFLOW_VERSION = "07-postprocess-clip@1/pp-nodes-1";
export const SWAP_MODEL = "inswapper_128.onnx";
export const RESTORE_MODEL = "codeformer-v0.1.0.pth";
export const FACE_DETECTION = "retinaface_resnet50";
export const SEEDVR2_VAE = "ema_vae_fp16.safetensors";
export const DLSS5_INTERMEDIATE_CRF = 10;

/** Starting presets to measure, not guaranteed limits. Low VRAM targets 16 GB VRAM / 64 GB RAM; High VRAM targets 48 GB VRAM
 *  (96 GB RAM recommended). The destination (this PC or a remote worker) is a separate choice. */
export const PRESETS: Record<PostResolvedVramMode, PostPreset> = {
  low_vram: {
    mode: "low_vram", label: "Low VRAM", budget: "16 GB VRAM / 64 GB RAM", ditModel: "seedvr2_ema_3b_fp8_e4m3fn.safetensors", batchSize: 5,
    vaeTiling: true, blocksToSwap: 0, ditOffload: "cpu", frameRamBudgetGb: 24,
  },
  high_vram: {
    mode: "high_vram", label: "High VRAM", budget: "48 GB VRAM / 96 GB RAM", ditModel: "seedvr2_ema_7b_fp16.safetensors", batchSize: 9,
    vaeTiling: false, blocksToSwap: 0, ditOffload: "none", frameRamBudgetGb: 48,
  },
};
export const DIT_MODELS = [
  "seedvr2_ema_3b_fp8_e4m3fn.safetensors", "seedvr2_ema_3b_fp16.safetensors", "seedvr2_ema_7b_fp16.safetensors",
  "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors", "seedvr2_ema_7b_sharp_fp16.safetensors",
] as const;
export const VRAM_MODE_LABEL: Record<PostVramMode, string> = { worker_default: "Worker default", low_vram: "Low VRAM", high_vram: "High VRAM" };
export const FACE_MODE_LABEL: Record<PostFaceMode, string> = { preserve: "Preserve", restore: "Restore", replace: "Replace" };

export function defaultSettings(): PostSettings {
  return {
    faceMode: "preserve", referenceAssetId: null, restoreAfterSwap: true, codeformerFidelity: 0.7, restoreVisibility: 1,
    dlss5: false, dlss5Style: "Default", dlss5Strength: 1, dlss5Scale: 1, dlss5TargetFps: 0, upscale: false,
    outputShortEdge: 1080, vramMode: "worker_default",
    advanced: {
      ditModel: null, batchSize: null, temporalOverlap: null, vaeTiling: null, blocksToSwap: null, offload: "preset", attention: "sdpa",
      colorCorrection: "lab", seed: 42, targetFacesOrder: "large-small", targetFacesIndex: "0", uniformBatch: true,
    },
  };
}

const oneOf = <T extends string | number>(value: unknown, options: readonly T[], label: string): T => {
  if (!options.includes(value as T)) throw new Error(`${label} must be one of ${options.join(", ")}.`);
  return value as T;
};
const bool = (value: unknown, label: string): boolean => { if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`); return value; };
const num = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a number from ${min} to ${max}.`);
  return value;
};
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => (value === null || value === undefined ? null : parse(value));

/** Validates settings that came over IPC or from the database. Throws a readable error; never guesses. */
export function normalizeSettings(raw: unknown): PostSettings {
  if (!raw || typeof raw !== "object") throw new Error("Post-processing settings are missing.");
  const value = raw as Record<string, unknown>;
  const base = defaultSettings();
  const adv = (value.advanced ?? {}) as Record<string, unknown>;
  const batch = nullable(adv.batchSize, (v) => num(v, "Temporal batch", 5, 129));
  if (batch !== null && (batch - 1) % 4 !== 0) throw new Error("Temporal batch must follow 4n+1 (5, 9, 13, …).");
  const advanced: PostAdvancedSettings = {
    ditModel: nullable(adv.ditModel, (v) => oneOf(v, DIT_MODELS, "SeedVR2 model")),
    batchSize: batch,
    temporalOverlap: nullable(adv.temporalOverlap, (v) => Math.round(num(v, "Temporal overlap", 0, 16))),
    vaeTiling: nullable(adv.vaeTiling, (v) => bool(v, "VAE tiling")),
    blocksToSwap: nullable(adv.blocksToSwap, (v) => Math.round(num(v, "BlockSwap blocks", 0, 36))),
    offload: oneOf(adv.offload ?? base.advanced.offload, ["preset", "none", "cpu"] as const, "Offload"),
    attention: oneOf(adv.attention ?? base.advanced.attention, POST_ATTENTION_MODES, "Attention"),
    colorCorrection: oneOf(adv.colorCorrection ?? base.advanced.colorCorrection, POST_COLOR_CORRECTIONS, "Color correction"),
    seed: Math.round(num(adv.seed ?? base.advanced.seed, "Seed", 0, 2 ** 32 - 1)),
    targetFacesOrder: oneOf(adv.targetFacesOrder ?? base.advanced.targetFacesOrder, POST_FACE_ORDERS, "Target face order"),
    targetFacesIndex: (() => {
      const text = String(adv.targetFacesIndex ?? base.advanced.targetFacesIndex).trim();
      if (!/^\d{1,2}(,\d{1,2}){0,7}$/.test(text)) throw new Error("Target face index is a number or a comma list such as 0 or 0,1.");
      return text;
    })(),
    uniformBatch: bool(adv.uniformBatch ?? base.advanced.uniformBatch, "Uniform final batch"),
  };
  const reference = value.referenceAssetId;
  if (reference !== null && reference !== undefined && (typeof reference !== "string" || !/^[0-9a-f-]{36}$/i.test(reference))) throw new Error("Unknown reference image.");
  return {
    faceMode: oneOf(value.faceMode, POST_FACE_MODES, "Face treatment"),
    referenceAssetId: (reference as string | null | undefined) ?? null,
    restoreAfterSwap: bool(value.restoreAfterSwap ?? base.restoreAfterSwap, "Restore after replacing"),
    codeformerFidelity: Math.round(num(value.codeformerFidelity ?? base.codeformerFidelity, "CodeFormer fidelity", 0, 1) * 100) / 100,
    restoreVisibility: Math.round(num(value.restoreVisibility ?? base.restoreVisibility, "Restore visibility", 0.1, 1) * 100) / 100,
    dlss5: bool(value.dlss5 ?? base.dlss5, "DLSS 5"),
    dlss5Style: oneOf(value.dlss5Style ?? base.dlss5Style, POST_DLSS5_STYLES, "DLSS 5 style"),
    dlss5Strength: Math.round(num(value.dlss5Strength ?? base.dlss5Strength, "DLSS 5 strength", 0, 2) * 10) / 10,
    dlss5Scale: oneOf(value.dlss5Scale ?? base.dlss5Scale, POST_DLSS5_SCALES, "DLSS 5 scale"),
    dlss5TargetFps: oneOf(value.dlss5TargetFps ?? base.dlss5TargetFps, POST_DLSS5_FPS, "DLSS 5 target frame rate"),
    upscale: bool(value.upscale ?? base.upscale, "Upscale"),
    outputShortEdge: oneOf(value.outputShortEdge ?? base.outputShortEdge, POST_OUTPUT_EDGES, "Output size"),
    vramMode: oneOf(value.vramMode ?? base.vramMode, POST_VRAM_MODES, "Memory mode"),
    advanced,
  };
}

/** True when the clip asks for any processing. Preserve without upscaling uses the original render as is. */
export function processingRequested(settings: PostSettings): boolean {
  return settings.faceMode !== "preserve" || settings.dlss5 || settings.upscale;
}

/** A starting point from the scene type. Shown as a suggestion; never applied without the user. */
export function suggestion(scene: ClipMode): { faceMode: PostFaceMode; upscale: boolean; reason: string } {
  if (scene === "Performance") return { faceMode: "preserve", upscale: true, reason: "Performance shot: keep the singing mouth shapes and expression; add face treatment only if playback improves." };
  if (scene === "Dance") return { faceMode: "replace", upscale: true, reason: "Dance shot: faces are often small and soft; Replace with the performer reference if the face is damaged or inconsistent." };
  if (scene === "B-roll") return { faceMode: "preserve", upscale: true, reason: "B-roll: usually no performer face; upscaling alone is the common choice." };
  return { faceMode: "preserve", upscale: false, reason: "No scene type recorded; start from the original and compare." };
}

/** Explicit low/high VRAM on the job overrides the worker default. Worker default needs the worker's POST_PROCESSING_VRAM_MODE. */
export function resolveVramMode(requested: PostVramMode, workerDefault: { value: PostResolvedVramMode | null; error: string | null } | null):
  { mode: PostResolvedVramMode; source: "job" | "worker" } | { error: string } {
  if (requested !== "worker_default") return { mode: requested, source: "job" };
  if (!workerDefault) return { error: "The worker's default memory mode is unknown (the worker could not be reached). Choose Low VRAM or High VRAM, or connect to the worker." };
  if (workerDefault.error || !workerDefault.value) return { error: `The worker's POST_PROCESSING_VRAM_MODE is invalid: ${workerDefault.error ?? "no value"}` };
  return { mode: workerDefault.value, source: "worker" };
}

export type EffectiveSettings = {
  faceMode: PostFaceMode;
  face: null | {
    swapModel: string | null; detection: string; restoreModel: string; codeformerWeight: number; restoreVisibility: number;
    targetFacesOrder: string; targetFacesIndex: string;
  };
  /** DLSS 5 neural render; scale 1 = native size, targetFps 0 = no interpolation; intermediateCrf is the H.264 quality of
   *  the file handed to it. */
  dlss5: null | { style: string; strength: number; scale: number; targetFps: number; intermediateCrf: number };
  upscale: null | {
    ditModel: string; vaeModel: string; resolution: number; batchSize: number; uniformBatch: boolean; temporalOverlap: number; vaeTiling: boolean;
    tileSize: number; tileOverlap: number; blocksToSwap: number; swapIo: boolean; ditOffload: "none" | "cpu"; vaeOffload: "none" | "cpu";
    tensorOffload: "none" | "cpu"; attention: string; colorCorrection: string; seed: number;
  };
  resolvedVramMode: PostResolvedVramMode;
  frameRamBudgetGb: number;
};

/** Every value the graph will receive, with the preset filled in. Only ReActor's built-in CodeFormer is used for Replace,
 *  and Restore uses ReActor's standalone restore node, so restoration never runs twice. */
export function effectiveSettings(settings: PostSettings, mode: PostResolvedVramMode): EffectiveSettings {
  const preset = PRESETS[mode];
  const adv = settings.advanced;
  const face = settings.faceMode === "preserve" ? null : {
    swapModel: settings.faceMode === "replace" ? SWAP_MODEL : null, detection: FACE_DETECTION,
    restoreModel: settings.faceMode === "restore" || settings.restoreAfterSwap ? RESTORE_MODEL : "none",
    codeformerWeight: settings.codeformerFidelity, restoreVisibility: settings.restoreVisibility,
    targetFacesOrder: adv.targetFacesOrder, targetFacesIndex: adv.targetFacesIndex,
  };
  const offload = adv.offload === "preset" ? preset.ditOffload : adv.offload;
  const blocks = adv.blocksToSwap ?? preset.blocksToSwap;
  const tiling = adv.vaeTiling ?? preset.vaeTiling;
  const upscale = !settings.upscale ? null : {
    ditModel: adv.ditModel ?? preset.ditModel, vaeModel: SEEDVR2_VAE, resolution: settings.outputShortEdge, batchSize: adv.batchSize ?? preset.batchSize,
    uniformBatch: adv.uniformBatch, temporalOverlap: adv.temporalOverlap ?? (mode === "low_vram" ? 1 : 2), vaeTiling: tiling,
    tileSize: mode === "low_vram" ? 512 : 1024, tileOverlap: 128,
    // BlockSwap needs an offload device; with blocks requested, offload to CPU even when the preset keeps the model resident.
    blocksToSwap: blocks, swapIo: false, ditOffload: blocks > 0 ? "cpu" : offload, vaeOffload: offload, tensorOffload: "cpu",
    attention: adv.attention, colorCorrection: adv.colorCorrection, seed: adv.seed,
  } as NonNullable<EffectiveSettings["upscale"]>;
  const dlss5 = settings.dlss5 ? {
    style: settings.dlss5Style, strength: settings.dlss5Strength, scale: settings.dlss5Scale, targetFps: settings.dlss5TargetFps,
    intermediateCrf: DLSS5_INTERMEDIATE_CRF,
  } : null;
  return { faceMode: settings.faceMode, face, dlss5, upscale, resolvedVramMode: mode, frameRamBudgetGb: preset.frameRamBudgetGb };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Device placement and memory budgets do not change pixels, so they are left out: moving to offload or another
 *  destination keeps a result current. Everything that can change pixels, including the resolved memory mode (it picks
 *  the model), is in the key. */
export function cacheKey(input: { sourceSha256: string; referenceSha256: string | null; effective: EffectiveSettings; workflowVersion?: string }): string {
  const { effective } = input;
  const upscale = effective.upscale ? (({ ditOffload: _a, vaeOffload: _b, tensorOffload: _c, blocksToSwap: _d, swapIo: _e, ...rest }) => rest)(effective.upscale) : null;
  const material = {
    workflow: input.workflowVersion ?? POSTPROCESS_WORKFLOW_VERSION, source: input.sourceSha256,
    reference: effective.face?.swapModel ? input.referenceSha256 : null, faceMode: effective.faceMode, face: effective.face, upscale,
    mode: effective.resolvedVramMode,
    // Only present when on, so results made before DLSS 5 existed keep their keys.
    ...(effective.dlss5 ? { dlss5: effective.dlss5 } : {}),
  };
  return createHash("sha256").update(canonical(material)).digest("hex");
}

export type ResolveAttempt = {
  id: string; status: PostAttemptStatus; cacheKey: string; reviewRequired: boolean; outputOk: boolean; error: string | null; startedAt: string;
};
export type ResolveInput = {
  rendered: boolean; requested: boolean;
  /** null when it cannot be computed now (e.g. the reference is missing or the worker default is unknown). */
  currentKey: string | null; keyProblem?: string | null;
  attempts: ResolveAttempt[];
  selection: { choice: "original" | "processed"; attemptId: string | null } | null;
};

/** How the final stitch uses one clip, and the state shown on Post-processing. Enabled processing that is missing,
 *  failed, stale, or awaiting review stays unresolved; it never falls back to the raw render on its own. */
export function resolveClip(input: ResolveInput): { resolution: PostResolution; state: PostClipState; text: string } {
  if (!input.rendered) return { resolution: { kind: "unresolved", reason: "The clip is not rendered yet." }, state: "not_rendered", text: "Not rendered" };
  if (input.selection?.choice === "original") {
    return { resolution: { kind: "bypass", reason: "Original render chosen explicitly." }, state: "bypassed", text: "Original (bypass)" };
  }
  if (!input.requested) return { resolution: { kind: "original", reason: "No post-processing requested." }, state: "not_requested", text: "Original" };
  const newest = [...input.attempts].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const matching = input.currentKey ? newest.filter((attempt) => attempt.cacheKey === input.currentKey) : [];
  const active = matching.find((attempt) => attempt.status === "queued" || attempt.status === "running" || attempt.status === "pending");
  if (active) {
    return { resolution: { kind: "unresolved", reason: "Processing is queued or running." }, state: active.status === "running" ? "running" : "queued", text: active.status === "running" ? "Processing" : "Queued" };
  }
  const usable = matching.filter((attempt) => attempt.status === "succeeded" && attempt.outputOk);
  if (input.selection?.choice === "processed") {
    const chosen = newest.find((attempt) => attempt.id === input.selection!.attemptId);
    if (chosen && usable.includes(chosen)) return { resolution: { kind: "processed", attemptId: chosen.id, reason: "Processed version chosen explicitly." }, state: "done", text: "Processed (chosen)" };
    if (chosen) {
      const why = chosen.status !== "succeeded" ? "did not succeed" : !chosen.outputOk ? "is missing on disk" : "was made from an earlier source, reference, or settings";
      return { resolution: { kind: "unresolved", reason: `The chosen processed version ${why}. Process again, choose the original, or restore the earlier settings.` }, state: "stale", text: "Chosen result is stale" };
    }
  }
  if (!input.currentKey) {
    return { resolution: { kind: "unresolved", reason: input.keyProblem ?? "The current request cannot be checked." }, state: "needs_processing", text: "Cannot check" };
  }
  const latest = usable[0];
  if (latest) {
    if (latest.reviewRequired) {
      return { resolution: { kind: "unresolved", reason: "The face report needs a look before this result is used: choose the processed version or the original." }, state: "needs_review", text: "Needs review" };
    }
    return { resolution: { kind: "processed", attemptId: latest.id, reason: "Current processed version." }, state: "done", text: "Processed" };
  }
  const last = matching[0];
  if (last?.status === "failed") return { resolution: { kind: "unresolved", reason: `Processing failed: ${last.error ?? "no error text"}. Retry, or choose the original.` }, state: "failed", text: "Failed" };
  if (last?.status === "canceled") return { resolution: { kind: "unresolved", reason: "Processing was canceled. Process it, or choose the original." }, state: "canceled", text: "Canceled" };
  if (newest.some((attempt) => attempt.status === "succeeded")) {
    return { resolution: { kind: "unresolved", reason: "Earlier results were made from a different source, reference, or settings. Process again, or choose the original." }, state: "stale", text: "Stale" };
  }
  return { resolution: { kind: "unresolved", reason: "Post-processing is enabled but this clip has not been processed." }, state: "needs_processing", text: "Not processed" };
}

/** Defense in depth after the save node's own checks: the metadata must show the source timing unchanged, or with DLSS 5
 *  interpolation (targetFps), the target rate and the source duration within two frames. */
export function timingProblems(source: { frames: number; fps: string; width: number; height: number }, output: { frames: number; fps: string; width: number; height: number }, targetFps = 0): string[] {
  const problems: string[] = [];
  const rate = (fps: string) => { const [a, b = "1"] = fps.split("/"); return Number(a) / Number(b); };
  if (targetFps) {
    const expected = Math.round(source.frames * targetFps / rate(source.fps));
    if (Math.abs(output.frames - expected) > 2) problems.push(`frame count ${output.frames}, expected about ${expected} after interpolation to ${targetFps} fps`);
    if (Math.abs(rate(output.fps) - targetFps) > 1e-9) problems.push(`frame rate ${output.fps}, expected ${targetFps}`);
  } else {
    if (source.frames !== output.frames) problems.push(`frame count ${source.frames} → ${output.frames}`);
    if (Math.abs(rate(source.fps) - rate(output.fps)) > 1e-9) problems.push(`frame rate ${source.fps} → ${output.fps}`);
  }
  const aspect = (w: number, h: number) => w / h;
  if (Math.abs(aspect(output.width, output.height) - aspect(source.width, source.height)) / aspect(source.width, source.height) > 0.01) {
    problems.push(`aspect ratio ${source.width}x${source.height} → ${output.width}x${output.height}`);
  }
  return problems;
}

/** Width and height of the first video track (moov/trak/tkhd), or null. `read` returns up to `length` bytes at `offset`. */
export function mp4VideoSize(read: (offset: number, length: number) => Buffer, size: number): { width: number; height: number } | null {
  const box = (offset: number, end: number) => {
    if (offset + 8 > end) return null;
    const head = read(offset, 16);
    if (head.length < 8) return null;
    let boxSize = head.readUInt32BE(0); let header = 8;
    if (boxSize === 1) { if (head.length < 16) return null; boxSize = Number(head.readBigUInt64BE(8)); header = 16; }
    else if (boxSize === 0) boxSize = end - offset;
    if (boxSize < header) return null;
    return { size: boxSize, type: head.toString("latin1", 4, 8), header };
  };
  const children = (start: number, end: number, visit: (type: string, at: number, header: number, size: number) => { width: number; height: number } | null | undefined) => {
    for (let at = start, guard = 0; at + 8 <= end && guard < 4096; guard++) {
      const item = box(at, end);
      if (!item) return null;
      const found = visit(item.type, at, item.header, item.size);
      if (found) return found;
      at += item.size;
    }
    return null;
  };
  return children(0, size, (type, at, header, length) => type !== "moov" ? null : children(at + header, Math.min(size, at + length), (t, a, h, l) => {
    if (t !== "trak") return null;
    return children(a + h, a + l, (tt, aa, hh) => {
      if (tt !== "tkhd") return null;
      const body = read(aa + hh, 96);
      const v1 = body[0] === 1;
      const offset = v1 ? 88 : 76;
      if (body.length < offset + 8) return null;
      const width = body.readUInt32BE(offset) / 65536; const height = body.readUInt32BE(offset + 4) / 65536;
      return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null;
    });
  }));
}

/** Short human description of an effective setting, for attempt lists. */
export function settingsSummary(effective: EffectiveSettings): string {
  const parts: string[] = [];
  if (effective.face?.swapModel) parts.push(`Replace${effective.face.restoreModel !== "none" ? ` + CodeFormer ${effective.face.codeformerWeight}` : ""}`);
  else if (effective.face) parts.push(`Restore (CodeFormer ${effective.face.codeformerWeight})`);
  else parts.push("Preserve");
  if (effective.dlss5) {
    parts.push(`DLSS 5 ${effective.dlss5.style} ${effective.dlss5.strength.toFixed(1)}${(effective.dlss5.scale ?? 1) > 1 ? ` ×${effective.dlss5.scale}` : ""}${effective.dlss5.targetFps ? ` → ${effective.dlss5.targetFps} fps` : ""}`);
  }
  if (effective.upscale) parts.push(`SeedVR2 ${/7b/.test(effective.upscale.ditModel) ? "7B" : "3B"} ${/fp8/.test(effective.upscale.ditModel) ? "FP8" : "FP16"} → ${effective.upscale.resolution}p, batch ${effective.upscale.batchSize}`);
  parts.push(VRAM_MODE_LABEL[effective.resolvedVramMode]);
  return parts.join(" · ");
}
