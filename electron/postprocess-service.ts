// Per-clip post-processing (design_docs/05-post-processing-plan.md), owned by Electron main. The renderer reaches it only
// through typed IPC. One ComfyUI workflow (07-postprocess-clip.json) per clip, sequentially, through the app's single
// ComfyUI line (serializeComfyWork) and the production lock, so it never overlaps a render, a package, or a stitch.
//  - Originals are only read. Every attempt writes <package>/postprocess/clip_NNN/<attempt id>.mp4 (+ .json sidecar).
//  - Remote work reuses runWorkflowTemplate's hash-checked project mirror; the returned file is checked against the
//    sha256 the save node reported before it is recorded.
//  - The final stitch asks stitchSelection() which file to use per clip and refuses while enabled processing is unresolved.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type {
  PostAttempt, PostAttemptStatus, PostClip, PostFaceReport, PostProcessOverview, PostResolvedVramMode, PostSelectRequest, PostSettings,
  PostSettingsRequest, PostVramMode, PostWorkerInfo, ProjectAsset,
} from "./contracts";
import { ComfyCanceledError, ComfyWorkflowError, comfyEndpoint, comfyStatus, runWorkflowTemplate, serializeComfyWork, type CleanupEvidence } from "./comfy-client";
import { db, getMachineSettings } from "./db";
import { previewText } from "./plan-rules";
import {
  cacheKey, defaultSettings, effectiveSettings, mp4VideoSize, normalizeSettings, POSTPROCESS_WORKFLOW_VERSION, PRESETS, processingRequested, resolveClip,
  resolveVramMode, settingsSummary, suggestion, timingProblems, type EffectiveSettings, type ResolveAttempt,
} from "./postprocess-rules";
import { buildPostprocessPrompt, schemaProblems, type PostJob } from "./postprocess-workflow";
import { claimProduction, productionBusy } from "./production-lock";
import { readableProductionError, validateClipIndex } from "./production-rules";
import { clipRows, currentPackageRow, syncClipsWithDisk, toPackage, type ClipRow } from "./production-service";
import { getProject, projectIdentity } from "./project-service";
import { isInside } from "./project-rules";
import { loadWorkflowTemplate } from "./workflow-template";

const TEMPLATE = "07-postprocess-clip.json";
const INTERRUPTED = "Martini Shot was closed while this clip was being post-processed.";
const now = () => new Date().toISOString();

type AttemptRow = {
  id: string; project_id: string; package_run_id: string; clip_index: number; status: PostAttemptStatus; cache_key: string; workflow_version: string;
  settings: string; effective: string; requested_mode: PostVramMode; resolved_mode: PostResolvedVramMode | null; mode_source: string | null;
  destination: "local" | "remote"; endpoint: string | null; source_path: string; source_sha256: string; reference_asset_id: string | null;
  reference_path: string | null; reference_sha256: string | null; output_path: string; output_sha256: string | null; output_size: number | null;
  media: string | null; face_report: string | null; review_required: number; environment: string | null; comfy_job_id: string | null;
  prompt_id: string | null; cleanup_status: string; cleanup: string | null; error: string | null; started_at: string; submitted_at: string | null;
  finished_at: string | null; runtime_ms: number | null;
};
type Media = { source: { frames: number; fps: string; width: number; height: number }; output: { frames: number; fps: string; width: number; height: number; size: number; sha256: string } };

let development = false;
let notify: (projectId: string) => void = () => undefined;

export function configurePostProcessService(options: { isDevelopment: boolean; onChange(projectId: string): void }): void {
  development = options.isDevelopment;
  notify = options.onChange;
  // Nothing watches work that was running when the app closed. The overview adopts a finished file if its sidecar is there.
  db().prepare(`UPDATE postprocess_attempts SET status = 'failed', finished_at = ?, error = ? WHERE status IN ('pending', 'queued', 'running')`)
    .run(now(), `${INTERRUPTED} ComfyUI may still have finished it; Martini Shot adopts the result if the file and its report are in the project.`);
}

const parse = <T>(value: string | null | undefined): T | null => { if (!value) return null; try { return JSON.parse(value) as T; } catch { return null; } };
function update(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (keys.length) db().prepare(`UPDATE postprocess_attempts SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => fields[key]) as never[], id);
}
function addReport(projectId: string, body: string, data?: unknown): void {
  db().prepare("INSERT INTO project_reports (id, project_id, category, body, data, created_at) VALUES (?, ?, 'postprocess', ?, ?, ?)")
    .run(randomUUID(), projectId, body, data === undefined ? null : JSON.stringify(data), now());
}

// ----- Files: hashes and sizes (cached by size + modified time) ------------------------------------------------

const hashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
async function sha256File(file: string): Promise<string> {
  const stat = statSync(file);
  const known = hashCache.get(file);
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.sha256;
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).once("error", reject).once("end", () => resolve(hash.digest("hex")));
  });
  hashCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest });
  return digest;
}
const sizeCache = new Map<string, { size: number; mtimeMs: number; value: { width: number; height: number } | null }>();
function videoSize(file: string): { width: number; height: number } | null {
  try {
    const stat = statSync(file);
    const known = sizeCache.get(file);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.value;
    const fd = openSync(file, "r");
    try {
      const value = mp4VideoSize((offset, length) => { const buffer = Buffer.alloc(Math.max(0, Math.min(length, stat.size - offset))); const read = buffer.length ? readSync(fd, buffer, 0, buffer.length, offset) : 0; return buffer.subarray(0, read); }, stat.size);
      sizeCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
      return value;
    } finally { closeSync(fd); }
  } catch { return null; }
}

// ----- Worker info (GET /martini/postprocess/info) --------------------------------------------------------------

type RawInfo = {
  vram_mode?: { value: string | null; source: string; raw: string | null; error: string | null };
  reactor?: { version?: string | null; path?: string | null }; seedvr2?: { version?: string | null; path?: string | null };
  dlss5?: { node?: boolean; cli?: string | null; error?: string | null };
  onnxruntime?: { version?: string | null; cuda_build?: string | null; session_providers?: string[] | null };
  torch?: { version?: string; cuda?: string; device?: string | null; vram_total?: number | null }; ram_total?: number | null;
  models?: Record<string, { present: boolean }>; mode_models?: Record<string, string[]>; face_models?: string[];
};
const workerCache = new Map<string, { at: number; info: PostWorkerInfo }>();

async function destination(): Promise<{ kind: "local" | "remote"; endpoint: string; token: string }> {
  const settings = await getMachineSettings();
  const remote = settings.executionDestination === "remote";
  return { kind: remote ? "remote" : "local", endpoint: comfyEndpoint(remote ? settings.remoteComfyUrl : settings.comfyUrl, remote ? "remote" : "local"), token: remote ? settings.remoteFileApiToken : "" };
}

export async function workerInfo(force = false): Promise<PostWorkerInfo> {
  const target = await destination();
  const cached = workerCache.get(target.endpoint);
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.info;
  const empty: PostWorkerInfo = {
    endpoint: target.endpoint, reachable: false, error: null, vramDefault: null, reactor: null, seedvr2: null, dlss5Problem: "The worker was not reached.", onnxruntime: null, ortCudaBuild: null,
    ortSessionProviders: null, torch: null, cuda: null, device: null, vramTotal: null, ramTotal: null, missingModels: { face: [], low_vram: [], high_vram: [], optional: [] }, checkedAt: now(),
  };
  let info = empty;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${target.endpoint}/martini/postprocess/info${force ? "?refresh=1" : ""}`, { headers: target.token ? { "X-Martini-Token": target.token } : {}, signal: controller.signal });
    if (response.status === 404) throw new Error("This ComfyUI's MartiniShot nodes have no post-processing support. Update the MartiniShot node pack and restart ComfyUI.");
    if (response.status === 403) throw new Error("The worker rejected the Martini Shot file API token.");
    if (!response.ok) throw new Error(`The worker answered HTTP ${response.status}.`);
    const raw = await response.json() as RawInfo;
    const missing = (names: string[] | undefined) => (names ?? []).filter((name) => !raw.models?.[name]?.present);
    const mode = raw.vram_mode;
    info = {
      ...empty, reachable: true,
      vramDefault: mode ? { value: mode.value === "low_vram" || mode.value === "high_vram" ? mode.value : null, source: mode.source, raw: mode.raw, error: mode.error } : null,
      reactor: raw.reactor?.version ?? (raw.reactor?.path ? "unknown version" : null), seedvr2: raw.seedvr2?.version ?? (raw.seedvr2?.path ? "unknown version" : null),
      dlss5Problem: !raw.dlss5?.node ? "The Custom DLSS5 Enhance (Video) node is not loaded on this ComfyUI (it is Windows-only, so remote Linux workers never have it)."
        : !raw.dlss5.cli ? `The Custom DLSS5 node can't find VE_CLI.exe: ${raw.dlss5.error ?? "no runtime found"}.` : null,
      onnxruntime: raw.onnxruntime?.version ?? null, ortCudaBuild: raw.onnxruntime?.cuda_build ?? null, ortSessionProviders: raw.onnxruntime?.session_providers ?? null,
      torch: raw.torch?.version ?? null, cuda: raw.torch?.cuda ?? null, device: raw.torch?.device ?? null, vramTotal: raw.torch?.vram_total ?? null, ramTotal: raw.ram_total ?? null,
      missingModels: { face: missing(raw.face_models), low_vram: missing(raw.mode_models?.low_vram), high_vram: missing(raw.mode_models?.high_vram), optional: missing(["ultralytics/bbox/hand_yolov8s.pt"]) },
    };
  } catch (error) {
    info = { ...empty, error: error instanceof Error ? (error.name === "AbortError" ? "The worker did not answer within 30 seconds." : error.message) : String(error) };
  } finally { clearTimeout(timer); }
  workerCache.set(target.endpoint, { at: Date.now(), info });
  return info;
}

// ----- Settings, attempts, selection -----------------------------------------------------------------------------

function storedSettings(packageRunId: string): Map<number, PostSettings> {
  const rows = db().prepare("SELECT clip_index, settings FROM postprocess_settings WHERE package_run_id = ?").all(packageRunId) as { clip_index: number; settings: string }[];
  const map = new Map<number, PostSettings>();
  for (const row of rows) { try { map.set(row.clip_index, normalizeSettings(JSON.parse(row.settings))); } catch { /* unreadable: defaults */ } }
  return map;
}
function attemptRowsFor(packageRunId: string): AttemptRow[] {
  return db().prepare("SELECT * FROM postprocess_attempts WHERE package_run_id = ? ORDER BY started_at DESC").all(packageRunId) as AttemptRow[];
}
function selections(packageRunId: string): Map<number, { choice: "original" | "processed"; attemptId: string | null }> {
  const rows = db().prepare("SELECT clip_index, choice, attempt_id FROM postprocess_selection WHERE package_run_id = ?").all(packageRunId) as { clip_index: number; choice: "original" | "processed"; attempt_id: string | null }[];
  return new Map(rows.map((row) => [row.clip_index, { choice: row.choice, attemptId: row.attempt_id }]));
}

function references(assets: ProjectAsset[]): ProjectAsset[] {
  return assets.filter((asset) => asset.role === "performer").concat(assets.filter((asset) => asset.role === "outfit"));
}
function referenceFor(settings: PostSettings, assets: ProjectAsset[]): ProjectAsset | null {
  const options = references(assets);
  if (settings.referenceAssetId) return options.find((asset) => asset.id === settings.referenceAssetId) ?? null;
  return options.find((asset) => asset.role === "performer") ?? null;
}

/** An attempt's output only counts while the recorded file is still there with the recorded size. */
function outputOk(row: AttemptRow, projectPath: string): boolean {
  if (row.status !== "succeeded" || !isInside(projectPath, row.output_path)) return false;
  try { return statSync(row.output_path).size === row.output_size; } catch { return false; }
}

type ClipContext = {
  row: ClipRow; settings: PostSettings; requested: boolean; source: string | null; sourceSha: string | null; reference: ProjectAsset | null;
  referenceSha: string | null; effective: EffectiveSettings | null; key: string | null; keyProblem: string | null;
  mode: { mode: PostResolvedVramMode; source: string } | null;
};

async function clipContext(row: ClipRow, settings: PostSettings, folder: string, assets: ProjectAsset[], worker: PostWorkerInfo | null, attempts: AttemptRow[]): Promise<ClipContext> {
  const requested = processingRequested(settings);
  const source = row.status === "rendered" && row.output_path && isInside(folder, row.output_path) && existsSync(row.output_path) ? row.output_path : null;
  const context: ClipContext = { row, settings, requested, source, sourceSha: null, reference: null, referenceSha: null, effective: null, key: null, keyProblem: null, mode: null };
  if (!source || !requested) return context;
  context.sourceSha = await sha256File(source);
  // Worker default: the worker's answer, else the mode the last worker-default attempt of this clip resolved to.
  let workerDefault = worker?.reachable ? worker.vramDefault : null;
  if (!workerDefault && settings.vramMode === "worker_default") {
    const previous = attempts.find((attempt) => attempt.clip_index === row.clip_index && attempt.requested_mode === "worker_default" && attempt.resolved_mode);
    if (previous) workerDefault = { value: previous.resolved_mode, source: "last attempt", raw: null, error: null };
  }
  const mode = resolveVramMode(settings.vramMode, workerDefault);
  if ("error" in mode) { context.keyProblem = mode.error; return context; }
  context.mode = mode;
  if (settings.faceMode === "replace") {
    context.reference = referenceFor(settings, assets);
    if (!context.reference || !existsSync(context.reference.storedPath)) { context.keyProblem = "Replace needs a character reference image; add a performer image on Projects or pick one here."; return context; }
    context.referenceSha = await sha256File(context.reference.storedPath);
  }
  context.effective = effectiveSettings(settings, mode.mode);
  context.key = cacheKey({ sourceSha256: context.sourceSha, referenceSha256: context.referenceSha, effective: context.effective });
  return context;
}

function toAttempt(row: AttemptRow, currentKey: string | null, projectPath: string): PostAttempt {
  const media = parse<Media>(row.media);
  const report = parse<Record<string, unknown>>(row.face_report);
  const env = parse<{ reactor?: { version?: string }; seedvr2?: { version?: string }; onnxruntime?: { version?: string; session_providers?: string[] }; torch?: { version?: string; device?: string } }>(row.environment);
  const exists = outputOk(row, projectPath);
  return {
    id: row.id, status: row.status, cacheKey: row.cache_key, current: row.cache_key === currentKey,
    requestedMode: row.requested_mode, resolvedMode: row.resolved_mode, modeSource: row.mode_source, destination: row.destination, endpoint: row.endpoint,
    summary: (() => { const effective = parse<EffectiveSettings>(row.effective); return effective ? settingsSummary(effective) : ""; })(),
    startedAt: row.started_at, submittedAt: row.submitted_at, finishedAt: row.finished_at, runtimeSeconds: row.runtime_ms === null ? null : Math.round(row.runtime_ms / 100) / 10, error: row.error,
    output: media && row.status === "succeeded" ? {
      fileName: path.basename(row.output_path), url: exists ? `martini-asset://post/${row.id}?v=${row.output_size ?? 0}` : null, exists,
      width: media.output.width, height: media.output.height, frames: media.output.frames, fps: media.output.fps, sizeBytes: media.output.size,
    } : null,
    faceReport: report ? {
      faceMode: String(report.face_mode ?? ""), frames: Number(report.frames ?? 0), detector: Boolean(report.detector), handDetector: Boolean(report.hand_detector),
      framesWithFace: Number(report.frames_with_face ?? 0), framesChanged: Number(report.frames_changed ?? 0),
      dropoutFrames: (report.dropout_frames as number[][]) ?? [], multiFaceFrames: (report.multi_face_frames as number[][]) ?? [],
      handOverlapFrames: (report.hand_overlap_frames as number[][]) ?? [], smallFaceFrames: (report.small_face_frames as number[][]) ?? [],
      warnings: (report.warnings as string[]) ?? [], reviewRequired: Boolean(report.review_required),
    } satisfies PostFaceReport : null,
    reviewRequired: row.review_required === 1,
    environment: env ? { reactor: env.reactor?.version ?? null, seedvr2: env.seedvr2?.version ?? null, onnxruntime: env.onnxruntime?.version ?? null, ortProviders: env.onnxruntime?.session_providers ?? null, torch: env.torch?.version ?? null, device: env.torch?.device ?? null } : null,
  };
}

function resolveAttempts(rows: AttemptRow[], projectPath: string): ResolveAttempt[] {
  return rows.map((row) => ({ id: row.id, status: row.status, cacheKey: row.cache_key, reviewRequired: row.review_required === 1, outputOk: outputOk(row, projectPath), error: row.error, startedAt: row.started_at }));
}

// ----- Queue state -----------------------------------------------------------------------------------------------

type Queue = { projectId: string; packageRunId: string; pending: number[]; current: number | null; cancel: boolean };
let queue: Queue | null = null;

/** Adopts an attempt that was running when the app closed, when its file and sidecar report made it into the project. */
async function adoptInterrupted(rows: AttemptRow[], projectPath: string): Promise<void> {
  for (const row of rows) {
    if (row.status !== "failed" || !row.error?.startsWith(INTERRUPTED)) continue;
    const sidecar = row.output_path.replace(/\.mp4$/i, ".json");
    if (!existsSync(row.output_path) || !existsSync(sidecar) || !isInside(projectPath, row.output_path)) continue;
    try {
      const metadata = JSON.parse(await (await import("node:fs/promises")).readFile(sidecar, "utf-8")) as Record<string, unknown>;
      await recordSuccess(row, metadata, null);
      update(row.id, { error: "Finished in ComfyUI while Martini Shot was closed; adopted after checking its file and report." });
    } catch { /* stays failed */ }
  }
}

// ----- Overview ---------------------------------------------------------------------------------------------------

export async function postProcessOverview(projectId: unknown): Promise<PostProcessOverview> {
  const project = getProject(projectId);
  const pkgRow = currentPackageRow(project.id);
  const pkg = pkgRow ? toPackage(pkgRow) : null;
  const target = await destination();
  const comfy = await comfyStatus();
  const worker = comfy.connected ? await workerInfo() : null;
  const blockers: string[] = [];
  if (!pkg || !pkgRow) blockers.push("There is no prompt package yet. Write it and render clips on Produce first.");
  if (!comfy.connected) blockers.push(`ComfyUI is not reachable at ${comfy.endpoint}. ${comfy.message}`);
  else if (worker && !worker.reachable) blockers.push(`Post-processing is unavailable on ${worker.endpoint}: ${worker.error}`);
  const busy = productionBusy();
  if (busy && busy.kind !== "postprocess") blockers.push(busy.projectId === project.id ? `This project is busy (${busy.kind === "render" ? "rendering clips" : busy.kind === "stitch" ? "stitching" : "writing a prompt package"}).` : "Another project is using ComfyUI.");
  const clips: PostClip[] = [];
  let processedCount = 0; let bypassCount = 0; const unresolved: string[] = [];
  if (pkg && pkgRow) {
    const rows = await syncClipsWithDisk(pkgRow.id, pkg.folder);
    const settings = storedSettings(pkgRow.id);
    let attempts = attemptRowsFor(pkgRow.id);
    await adoptInterrupted(attempts, project.projectPath);
    attempts = attemptRowsFor(pkgRow.id);
    const chosen = selections(pkgRow.id);
    for (const row of rows) {
      const clipSettings = settings.get(row.clip_index) ?? defaultSettings();
      const context = await clipContext(row, clipSettings, pkg.folder, project.assets, worker, attempts);
      const own = attempts.filter((attempt) => attempt.clip_index === row.clip_index);
      const live = queue?.packageRunId === pkgRow.id ? queue : null;
      const resolved = resolveClip({
        rendered: Boolean(context.source), requested: context.requested, currentKey: context.key, keyProblem: context.keyProblem,
        attempts: resolveAttempts(own, project.projectPath), selection: chosen.get(row.clip_index) ?? null,
      });
      let state = resolved.state; let text = resolved.text;
      if (live?.pending.includes(row.clip_index) && state !== "running") { state = "queued"; text = "Queued"; }
      if (resolved.resolution.kind === "processed") processedCount++;
      if (resolved.resolution.kind === "bypass") bypassCount++;
      if (resolved.resolution.kind === "unresolved" && context.source) unresolved.push(`Clip ${row.clip_index}: ${resolved.resolution.reason}`);
      const scene = (row.scene ?? "") as PostClip["scene"];
      clips.push({
        index: row.clip_index, section: row.section_number, scene, start: row.song_start, end: row.song_end, duration: Math.max(0, row.song_end - row.song_start),
        rendered: Boolean(context.source), sourceUrl: context.source ? `martini-asset://clip/${project.id}/${row.clip_index}?v=${encodeURIComponent(row.rendered_at ?? "")}` : null,
        sourceSize: context.source ? videoSize(context.source) : null, settings: clipSettings, customized: settings.has(row.clip_index),
        suggestion: suggestion(scene), state, stateText: text, resolution: resolved.resolution, selection: chosen.get(row.clip_index) ?? null,
        attempts: own.map((attempt) => toAttempt(attempt, context.key, project.projectPath)),
      });
    }
  }
  return {
    projectId: project.id, projectName: project.name, package: pkg && pkgRow ? { runId: pkgRow.id, folder: pkg.folder, clipCount: pkg.clipCount } : null,
    clips, references: references(project.assets).map((asset) => ({ id: asset.id, role: asset.role, name: asset.displayName, url: asset.previewUrl })),
    destination: target.kind, worker, presets: [PRESETS.low_vram, PRESETS.high_vram],
    queue: { active: Boolean(queue && queue.projectId === project.id), current: queue?.projectId === project.id ? queue.current : null, pending: queue?.projectId === project.id ? [...queue.pending] : [], cancelling: Boolean(queue?.cancel) },
    blockers, combine: { processedCount, bypassCount, unresolved }, defaults: defaultSettings(),
  };
}

// ----- Settings and selection (IPC) -------------------------------------------------------------------------------

function packageFor(projectId: string): { pkgRow: NonNullable<ReturnType<typeof currentPackageRow>>; folder: string } {
  const pkgRow = currentPackageRow(projectId);
  const pkg = pkgRow ? toPackage(pkgRow) : null;
  if (!pkgRow || !pkg) throw new Error("There is no prompt package yet.");
  return { pkgRow, folder: pkg.folder };
}

function clipIndexes(raw: unknown, rows: ClipRow[]): number[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("Choose at least one clip.");
  const known = new Set(rows.map((row) => row.clip_index));
  const indexes = [...new Set(raw.map(validateClipIndex))];
  const unknown = indexes.filter((index) => !known.has(index));
  if (unknown.length) throw new Error(`Clip ${unknown.join(", ")} is not in the current prompt package.`);
  return indexes.sort((a, b) => a - b);
}

export async function savePostSettings(projectId: unknown, request: unknown): Promise<PostProcessOverview> {
  const project = projectIdentity(projectId);
  const { pkgRow } = packageFor(project.id);
  const value = request as PostSettingsRequest;
  const settings = normalizeSettings(value?.settings);
  if (settings.referenceAssetId && !references(getProject(project.id).assets).some((asset) => asset.id === settings.referenceAssetId)) throw new Error("That reference image is not in this project.");
  const indexes = clipIndexes(value?.clips, clipRows(pkgRow.id));
  const statement = db().prepare(`INSERT INTO postprocess_settings (package_run_id, project_id, clip_index, settings, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(package_run_id, clip_index) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`);
  const at = now();
  for (const index of indexes) statement.run(pkgRow.id, project.id, index, JSON.stringify(settings), at);
  notify(project.id);
  return postProcessOverview(project.id);
}

/** Original = explicit bypass for the stitch. Processed = this exact succeeded attempt (also how a result that needs review
 *  is accepted). Clear = back to automatic (the current, review-free result, or waiting for one). */
export async function selectPostVersion(projectId: unknown, request: unknown): Promise<PostProcessOverview> {
  const project = projectIdentity(projectId);
  const { pkgRow } = packageFor(project.id);
  const value = request as PostSelectRequest;
  const [index] = clipIndexes([value?.clip], clipRows(pkgRow.id));
  if (value.choice === "clear") db().prepare("DELETE FROM postprocess_selection WHERE package_run_id = ? AND clip_index = ?").run(pkgRow.id, index);
  else {
    if (value.choice !== "original" && value.choice !== "processed") throw new Error("Unknown choice.");
    let attemptId: string | null = null;
    if (value.choice === "processed") {
      const row = db().prepare("SELECT * FROM postprocess_attempts WHERE id = ? AND package_run_id = ? AND clip_index = ?").get(String(value.attemptId ?? ""), pkgRow.id, index) as AttemptRow | undefined;
      if (!row || row.status !== "succeeded" || !outputOk(row, project.projectPath)) throw new Error("That processed version is not available.");
      attemptId = row.id;
    }
    db().prepare(`INSERT INTO postprocess_selection (package_run_id, project_id, clip_index, choice, attempt_id, selected_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_run_id, clip_index) DO UPDATE SET choice = excluded.choice, attempt_id = excluded.attempt_id, selected_at = excluded.selected_at`)
      .run(pkgRow.id, project.id, index, value.choice, attemptId, now());
  }
  notify(project.id);
  return postProcessOverview(project.id);
}

/** For martini-asset://post/<attemptId>: the recorded processed file, only inside its project. */
export function postArtifactFile(attemptId: string): string | null {
  const row = db().prepare("SELECT * FROM postprocess_attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
  if (!row) return null;
  try { return outputOk(row, projectIdentity(row.project_id).projectPath) ? path.resolve(row.output_path) : null; } catch { return null; }
}

// ----- Processing queue -------------------------------------------------------------------------------------------

/** Queues clips for processing (all = every enabled clip whose current result is missing, failed, canceled, or stale). */
export async function startPostProcessing(projectId: unknown, raw: unknown): Promise<PostProcessOverview> {
  const project = projectIdentity(projectId);
  const { pkgRow } = packageFor(project.id);
  if (queue) throw new Error(queue.projectId === project.id ? "Post-processing is already running. Wait for it, or cancel it." : "Another project is post-processing.");
  const overview = await postProcessOverview(project.id);
  if (overview.blockers.length) throw new Error(`Nothing was queued.\n${overview.blockers.join("\n")}`);
  const wanted = raw === "pending"
    ? overview.clips.filter((clip) => clip.rendered && processingRequested(clip.settings) && ["needs_processing", "failed", "canceled", "stale"].includes(clip.state)).map((clip) => clip.index)
    : clipIndexes(raw, clipRows(pkgRow.id));
  const notRendered = wanted.filter((index) => !overview.clips.find((clip) => clip.index === index)?.rendered);
  if (notRendered.length) throw new Error(`Clip ${notRendered.join(", ")} has no rendered video yet.`);
  const off = wanted.filter((index) => !processingRequested(overview.clips.find((clip) => clip.index === index)!.settings));
  if (off.length) throw new Error(`Clip ${off.join(", ")} asks for no processing (Preserve, no upscaling). Change its settings first.`);
  if (!wanted.length) throw new Error("No clip needs processing.");
  const release = claimProduction("postprocess", project.id);
  queue = { projectId: project.id, packageRunId: pkgRow.id, pending: [...wanted], current: null, cancel: false };
  addReport(project.id, `Post-processing queued for clip${wanted.length === 1 ? "" : "s"} ${wanted.join(", ")}.`);
  void runQueue().catch(() => undefined).finally(() => { queue = null; release(); notify(project.id); });
  notify(project.id);
  return postProcessOverview(project.id);
}

export async function cancelPostProcessing(projectId: unknown): Promise<PostProcessOverview> {
  const project = projectIdentity(projectId);
  if (queue?.projectId === project.id) {
    queue.cancel = true;
    queue.pending = [];
    addReport(project.id, "Post-processing cancel requested.");
    notify(project.id);
  }
  return postProcessOverview(project.id);
}

async function runQueue(): Promise<void> {
  while (queue && queue.pending.length && !queue.cancel) {
    const index = queue.pending.shift()!;
    queue.current = index;
    notify(queue.projectId);
    const live = queue;
    await serializeComfyWork(() => processClip(live, index)).catch((error) => addReport(live.projectId, `Clip ${index}: ${error instanceof Error ? error.message : String(error)}`));
    if (queue) queue.current = null;
  }
}

async function processClip(live: Queue, index: number): Promise<void> {
  const project = getProject(live.projectId);
  const { pkgRow, folder } = packageFor(project.id);
  if (pkgRow.id !== live.packageRunId) throw new Error("The prompt package changed; the queue stopped.");
  const row = (await syncClipsWithDisk(pkgRow.id, folder)).find((item) => item.clip_index === index);
  if (!row) throw new Error("The clip is no longer in the package.");
  const settings = storedSettings(pkgRow.id).get(index) ?? defaultSettings();
  const target = await destination();
  const worker = await workerInfo(true);
  const attempts = attemptRowsFor(pkgRow.id);
  const context = await clipContext(row, settings, folder, project.assets, worker, attempts);
  if (!context.source) throw new Error(`Clip ${index} has no rendered video.`);
  // Same request already processed and still on disk: reuse it instead of running again.
  const reusable = attempts.find((attempt) => attempt.clip_index === index && attempt.cache_key === context.key && attempt.status === "succeeded" && outputOk(attempt, project.projectPath));
  if (reusable) { addReport(project.id, `Clip ${index}: reused processed version ${path.basename(reusable.output_path)} (same source, reference, and settings).`); return; }

  const attemptId = randomUUID();
  const relative = `postprocess/clip_${String(index).padStart(3, "0")}/${attemptId}.mp4`;
  const outputLocal = path.join(folder, ...relative.split("/"));
  const started = now();
  db().prepare(`INSERT INTO postprocess_attempts (id, project_id, package_run_id, clip_index, status, cache_key, workflow_version, settings, effective,
      requested_mode, resolved_mode, mode_source, destination, endpoint, source_path, source_sha256, reference_asset_id, reference_path, reference_sha256,
      output_path, started_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(attemptId, project.id, pkgRow.id, index, context.key ?? "unresolved", POSTPROCESS_WORKFLOW_VERSION, JSON.stringify(settings), JSON.stringify(context.effective ?? null),
      settings.vramMode, context.mode?.mode ?? null, context.mode?.source ?? null, target.kind, target.endpoint, context.source, context.sourceSha ?? "",
      context.reference?.id ?? null, context.reference?.storedPath ?? null, context.referenceSha, outputLocal, started);
  notify(project.id);
  const fail = (message: string) => { update(attemptId, { status: "failed", error: message, finished_at: now(), runtime_ms: Date.now() - Date.parse(started) }); addReport(project.id, `Clip ${index} post-processing failed: ${message}`, { attemptId }); };

  if (live.cancel) { update(attemptId, { status: "canceled", finished_at: now(), error: "Canceled before it started." }); return; }
  if (!context.effective || !context.key || !context.mode) return fail(context.keyProblem ?? "The request could not be resolved.");
  if (!worker.reachable) return fail(`Post-processing is unavailable on ${worker.endpoint}: ${worker.error}`);
  const missing = [...(context.effective.face ? worker.missingModels.face : []), ...(context.effective.upscale ? worker.missingModels[context.mode.mode] : [])];
  if (context.effective.face && !worker.reactor) return fail("The ReActor node pack is not loaded on the worker. Install it (cloud/runpod/setup.sh does) and restart ComfyUI.");
  if (context.effective.dlss5 && worker.dlss5Problem) return fail(`DLSS 5 can't run: ${worker.dlss5Problem} Turn DLSS 5 off for this clip, or switch to this PC in Settings.`);
  if (context.effective.upscale && !worker.seedvr2) return fail("The SeedVR2 node pack is not loaded on the worker. Install it and restart ComfyUI.");
  if (missing.length) {
    return fail(`The worker lacks these models for ${PRESETS[context.mode.mode].label}: ${missing.join(", ")}. On RunPod set POST_PROCESSING_MODELS=all (or this mode) and restart the pod; locally put them in ComfyUI/models. Nothing was submitted.`);
  }

  const wire = (local: string) => target.kind === "remote" ? `martini_shot/${project.slug}/${path.relative(project.projectPath, local).split(path.sep).join("/")}` : local;
  const job: PostJob = {
    attemptId, cacheKey: context.key, sourceVideo: wire(context.source), referenceImage: context.reference && context.effective.face?.swapModel ? wire(context.reference.storedPath) : "",
    outputPath: wire(outputLocal), sourceSha256: context.sourceSha!, referenceSha256: context.referenceSha, requestedVramMode: settings.vramMode, effective: context.effective,
  };
  let prompt: Record<string, unknown>;
  try {
    prompt = buildPostprocessPrompt(await loadWorkflowTemplate(development, TEMPLATE), job);
    const problems = await checkSchemas(target, prompt);
    if (problems.length) return fail(`The workflow does not match the worker's installed nodes, so nothing was submitted:\n${problems.join("\n")}`);
  } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }

  const jobId = randomUUID();
  update(attemptId, { comfy_job_id: jobId });
  let cleanup: CleanupEvidence | null = null;
  try {
    update(attemptId, { status: "running" });
    notify(project.id);
    let outputs: unknown;
    try {
      const run = await runWorkflowTemplate(development, TEMPLATE, {}, project.id, () => prompt, {
        jobId, waitWhileQueued: true, isCanceled: () => live.cancel,
        onSubmitted: (promptId) => { update(attemptId, { prompt_id: promptId, submitted_at: now() }); notify(project.id); },
        onCleanup: (evidence) => update(attemptId, { cleanup_status: evidence.status, cleanup: JSON.stringify(evidence) }),
      });
      outputs = run.outputs; cleanup = run.cleanup;
    } catch (error) {
      if (!(error instanceof ComfyWorkflowError) || !error.completed) throw error;
      outputs = error.outputs; cleanup = error.cleanup; // processed; only /free could not be confirmed
    }
    const metadataText = previewText(outputs, "metadata");
    const metadata = parse<Record<string, unknown>>(metadataText);
    if (!metadata) throw new Error("ComfyUI finished, but the save node's metadata was not in its results.");
    const row = db().prepare("SELECT * FROM postprocess_attempts WHERE id = ?").get(attemptId) as AttemptRow;
    await recordSuccess(row, metadata, previewText(outputs, "face_report_text"));
    if (cleanup && cleanup.status !== "completed" && cleanup.status !== "skipped") addReport(project.id, `Clip ${index} was processed, but ComfyUI cleanup could not be confirmed: ${cleanup.error ?? "unknown"}.`);
    addReport(project.id, `Clip ${index} post-processed: ${settingsSummary(context.effective)}.`, { attemptId });
  } catch (error) {
    if (error instanceof ComfyCanceledError || live.cancel) {
      update(attemptId, { status: "canceled", error: error instanceof Error ? error.message : "Canceled.", finished_at: now(), runtime_ms: Date.now() - Date.parse(started) });
      addReport(project.id, `Clip ${index} post-processing canceled.`, { attemptId });
    } else fail(readableProductionError(error instanceof Error ? error.message : String(error), target.endpoint));
  } finally { notify(project.id); }
}

async function checkSchemas(target: { endpoint: string; token: string }, prompt: Record<string, unknown>): Promise<string[]> {
  const classes = [...new Set(Object.values(prompt).map((node) => (node as { class_type: string }).class_type))];
  const info: Record<string, unknown> = {};
  for (const name of classes) {
    const response = await fetch(`${target.endpoint}/object_info/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`Could not read the worker's node schema for ${name} (HTTP ${response.status}).`);
    Object.assign(info, await response.json());
  }
  return schemaProblems(prompt, info as Parameters<typeof schemaProblems>[1]);
}

/** Records a finished attempt only after the file is in the local project with the hash, size, and timing the node reported. */
async function recordSuccess(row: AttemptRow, metadata: Record<string, unknown>, faceReportText: string | null): Promise<void> {
  const media = metadata as unknown as Media & { cache_key?: string; attempt_id?: string; face_report?: Record<string, unknown> | null; environment?: unknown };
  if (media.attempt_id && media.attempt_id !== row.id) throw new Error("The save node reported a different attempt.");
  if (media.cache_key && media.cache_key !== row.cache_key) throw new Error("The save node processed a different request (cache key differs).");
  if (!existsSync(row.output_path)) throw new Error(`The processed file ${row.output_path} is not in the local project${row.destination === "remote" ? " (the download from the worker did not bring it back)" : ""}.`);
  const size = statSync(row.output_path).size;
  if (size !== media.output.size) throw new Error(`The processed file has ${size} bytes; the worker wrote ${media.output.size}.`);
  const sha = await sha256File(row.output_path);
  if (sha !== media.output.sha256) throw new Error("The processed file's sha256 does not match what the worker wrote; it was not used.");
  const source = media.source as Media["source"] & { sha256?: string };
  if (source.sha256 && source.sha256 !== row.source_sha256) throw new Error("The worker processed a different source file than the one Martini Shot hashed.");
  const effective = parse<EffectiveSettings>(row.effective);
  const problems = timingProblems(source, media.output, effective?.dlss5?.targetFps ?? 0);
  if (problems.length) throw new Error(`The processed clip does not keep the source timing (${problems.join("; ")}).`);
  const report = media.face_report ?? parse<Record<string, unknown>>(faceReportText);
  if (report) delete report.per_frame_change;
  const finished = now();
  update(row.id, {
    status: "succeeded", output_sha256: sha, output_size: size, media: JSON.stringify({ source, output: media.output }), face_report: report ? JSON.stringify(report) : null,
    review_required: report?.review_required ? 1 : 0, environment: JSON.stringify(media.environment ?? null), error: null, finished_at: finished,
    runtime_ms: Date.parse(finished) - Date.parse(row.started_at),
  });
}

// ----- Final stitch ---------------------------------------------------------------------------------------------

export type StitchSelection = {
  /** True when at least one clip uses a processed artifact (then 06b-stitch-selected.json runs). */
  usesProcessed: boolean;
  /** Package-relative file per clip index (originals included). */
  files: Array<{ index: number; path: string; absolute: string; processed: boolean }>;
  /** Clips whose enabled processing has no usable result; the stitch is blocked until each is processed or bypassed. */
  unresolved: string[];
};

export async function stitchSelection(projectId: string): Promise<StitchSelection> {
  const overview = await postProcessOverview(projectId);
  const pkgRow = currentPackageRow(projectId);
  const pkg = pkgRow ? toPackage(pkgRow) : null;
  if (!pkgRow || !pkg) return { usesProcessed: false, files: [], unresolved: [] };
  const rows = clipRows(pkgRow.id);
  const attempts = new Map(attemptRowsFor(pkgRow.id).map((row) => [row.id, row]));
  const files: StitchSelection["files"] = [];
  for (const clip of overview.clips) {
    const row = rows.find((item) => item.clip_index === clip.index);
    if (!row?.output_path) continue;
    const processed = clip.resolution.kind === "processed" ? attempts.get(clip.resolution.attemptId) : undefined;
    const absolute = processed ? processed.output_path : row.output_path;
    files.push({ index: clip.index, path: path.relative(pkg.folder, absolute).split(path.sep).join("/"), absolute, processed: Boolean(processed) });
  }
  return {
    usesProcessed: files.some((file) => file.processed), files,
    unresolved: overview.combine.unresolved.map((line) => `Post-processing — ${line}`),
  };
}
