// Production plan, prompt package, and the sequential render queue (Ticket 05), owned by Electron main.
// The renderer reaches it only through typed IPC.
//  - Write prompt package runs workflows/04-write-prompt-package.json (Open Project -> Load Story Plan -> Resolve Locations ->
//    Build Production Plan -> Prompt LLM Loader -> Write Prompt Package). It never runs the story planner.
//  - Each queued clip runs workflows/05-render-next-clip.json once: one ComfyUI prompt renders exactly one clip, then
//    runWorkflowTemplate sends POST /free and waits for ComfyUI to be idle before this loop considers the next clip.
import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CLIP_CAMERAS } from "./contracts";
import type {
  ClipCamera, ClipChanges, ClipMode, ClipRefOption, ClipRefRole, ClipRevisionMode, ClipRevisionRequest, ClipShotSettings,
  ClipDetail, ClipStatus, CleanupState, DecisionRow, PackageRun, PackageRunStatus, PlanData, ProduceClip, ProduceEvent, ProduceOverview,
  PromptPackage, RenderAttempt, RenderQueueState, RerenderResult, TimelineSection, CreativeDirection, LivePreviewSession, LivePreviewFrame,
} from "./contracts";
import { archiveStamp, formatRanges, parseClipSelection, withContinuations } from "./results-rules";
import {
  ComfyWorkflowError, comfyHistory, comfyQueueIds, comfyStatus, freeComfyMemory, runWorkflowTemplate, serializeComfyWork,
  type CleanupEvidence, type StepProgress, type WorkflowProgress,
} from "./comfy-client";
import { db, getMachineSettings } from "./db";
import { locationsOverview } from "./location-service";
import { storyFileHash } from "./location-rules";
import { previewText, storySignature, parseStoryPlan, reportBlock, type RawStoryPlan } from "./plan-rules";
import { directorLlmOptions, planOverview, renderSteps } from "./plan-service";
import { claimProduction, productionBusy } from "./production-lock";
import {
  FIXED_INDEX, MAX_NOISE_SEED, NEXT_MISSING, RENDER_NAME, actionValidation, clipMetadata, estimateRemaining, findVideo, parseLoaderReport,
  parseManifest, parsePackageReport, parseProductionReport, queueTarget, readableProductionError, savedVideo, validateClipIndex,
  validateQueueCount, type ClipMeta, type FolderFile,
} from "./production-rules";
import { ensureComfyProjectSaved, getProject, projectIdentity, suppliedLocationNames } from "./project-service";
import { isInside } from "./project-rules";
import { RemoteRenderStaging, remoteOutputPath, remotePackageRoot } from "./remote-render-staging";

const PACKAGE_STAGE = "prompt_package";
const now = () => new Date().toISOString();
const EVENT_CATEGORIES = [
  "prompt_package", "prompt_package_error", "clip_prompt_revision", "render_queue", "render_clip", "render_clip_error", "render_cleanup", "render_recovery", "rerender",
];

export type PackageRow = {
  id: string; project_id: string; status: PackageRunStatus; settings: string; report: string | null; plan_json: string | null;
  error: string | null; created_at: string; completed_at: string | null; comfy_job_id: string | null;
};
export type PackageSettings = { planRunId: string; motifWeight: number; seed: number; directorLlm: string | null; renderName: string; direction: CreativeDirection };
/** What a successful Write prompt package run stored in director_runs.plan_json. */
export type StoredPackage = Omit<PromptPackage, "runId" | "writtenAt"> & { clipNotes: Record<string, string[]>; storyHash: string };
export type ClipRow = {
  id: string; project_id: string; package_run_id: string; clip_index: number; shot_number: number | null; section_number: number | null;
  song_start: number; song_end: number; scene: string | null; location: string | null; outfit: string | null; action: string | null;
  transition: string | null; overlap_frames: number; video_name: string; prompt_file: string; meta: string; status: ClipStatus;
  output_path: string | null; attempts: number; last_attempt_id: string | null; error: string | null; rendered_at: string | null; updated_at: string;
};
export type AttemptRow = {
  id: string; project_id: string; package_run_id: string; queue_id: string | null; clip_index: number; attempt: number; loader_mode: string;
  noise_seed: number; comfy_job_id: string | null; prompt_id: string | null; status: RenderAttempt["status"]; cleanup_status: CleanupState;
  cleanup: string | null; output_path: string | null; loader_report: string | null; error: string | null; started_at: string;
  submitted_at: string | null; rendered_at: string | null; finished_at: string | null; remote_endpoint?: string | null; staging_evidence?: string | null;
};
type QueueRow = {
  id: string; project_id: string; package_run_id: string; kind: RenderQueueState["kind"]; requested: number; target: number;
  retry_clip: number | null; completed: number; status: RenderQueueState["status"]; stop_requested_at: string | null; message: string | null;
  created_at: string; finished_at: string | null;
};
type ClipMetaExtra = { camera?: string; role?: string; sectionLabel?: string; storyDriven?: boolean; flags?: string[]; matched?: boolean; subject?: string };
/** One clip's entry in the package's clip_creatives.json (written by the Director, edited by the revision node). */
type CreativeRecord = {
  action?: unknown; revision?: unknown; scene?: unknown; camera_name?: unknown; camera_sentence?: unknown; ask_camera?: unknown;
  soundscape?: unknown; dance_soundscape?: unknown; soundscape_locked?: unknown; lip_sync_text?: unknown; lip_sync_saved?: unknown;
  lip_sync_option?: unknown; location_text?: unknown; ending_override?: unknown; parsed?: { ending?: unknown };
  refs?: Array<{ role?: unknown; file?: unknown }>;
};

let development = false;
let notify: (projectId: string) => void = () => undefined;
let previewSession: LivePreviewSession = null;
let notifyPreview: (session: LivePreviewSession) => void = () => undefined;
let notifyPreviewFrame: (frame: LivePreviewFrame) => void = () => undefined;
const packageActivity = new Map<string, NonNullable<PackageRun["activity"]>>();
const attemptPhase = new Map<string, NonNullable<RenderAttempt["phase"]>>();
const attemptStep = new Map<string, StepProgress>();
let gpuCache: { label: string | null; at: number } = { label: null, at: 0 };

/** A remote node reports paths relative to its own output root. Convert only a
 * proven `martini_shot/<this slug>` suffix back to the local authority. */
function localProjectPath(project: { slug: string; projectPath: string }, value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const marker = `/martini_shot/${project.slug}/`;
  const index = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (index < 0) return value;
  return path.join(project.projectPath, ...normalized.slice(index + marker.length).split("/").filter(Boolean));
}

export function configureProductionService(options: {
  isDevelopment: boolean; onChange(projectId: string): void; onPreviewSession(session: LivePreviewSession): void; onPreviewFrame(frame: LivePreviewFrame): void;
}): void {
  notifyPreviewFrame = options.onPreviewFrame;
  development = options.isDevelopment;
  notify = options.onChange;
  notifyPreview = (session) => { previewSession = session; options.onPreviewSession(session); };
  // Nothing is watching work that was in progress when the app closed. Mark it so the user sees it and decides what to do.
  const at = now();
  db().prepare(`UPDATE director_runs SET status = 'interrupted', completed_at = ?,
    error = 'Martini Shot was closed while this prompt package was being written. ComfyUI may still have finished it in a new folder; write the package again.'
    WHERE stage = ? AND status IN ('queued', 'running')`).run(at, PACKAGE_STAGE);
  db().prepare(`UPDATE render_queues SET status = 'interrupted', finished_at = ?,
    message = 'Martini Shot was closed while this queue was running. It did not restart on its own.' WHERE status IN ('running', 'stopping')`).run(at);
  db().prepare(`UPDATE render_attempts SET status = 'interrupted', finished_at = ?,
    error = 'Martini Shot was closed while this clip was rendering. ComfyUI may still finish it; Martini Shot checks before rendering again.'
    WHERE status IN ('queued', 'running', 'cleanup')`).run(at);
  db().prepare("UPDATE render_clips SET status = 'interrupted', updated_at = ? WHERE status IN ('queued', 'rendering')").run(at);
}

export function currentPreviewSession(): LivePreviewSession {
  return previewSession;
}

// ----- Small helpers ---------------------------------------------------------------------------------------

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function addReport(projectId: string, category: string, body: string, data?: unknown, runId?: string): void {
  db().prepare("INSERT INTO project_reports (id, project_id, category, body, data, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), projectId, category, body, data === undefined ? null : JSON.stringify(data), runId ?? null, now());
}

function update(table: "director_runs" | "render_attempts" | "render_queues" | "render_clips", id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db().prepare(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => fields[key]) as never[], id);
}

export function packageRow(id: string | null | undefined): PackageRow | null {
  if (!id) return null;
  return (db().prepare("SELECT * FROM director_runs WHERE id = ? AND stage = ?").get(id, PACKAGE_STAGE) as PackageRow | undefined) ?? null;
}

function latestPackageRow(projectId: string): PackageRow | null {
  return (db().prepare("SELECT * FROM director_runs WHERE project_id = ? AND stage = ? ORDER BY created_at DESC LIMIT 1").get(projectId, PACKAGE_STAGE) as PackageRow | undefined) ?? null;
}

export function currentPackageRow(projectId: string): PackageRow | null {
  const row = db().prepare("SELECT current_package_run_id FROM martini_projects WHERE id = ?").get(projectId) as { current_package_run_id: string | null } | undefined;
  const pkg = packageRow(row?.current_package_run_id);
  return pkg?.status === "complete" ? pkg : null;
}

function toPackageRun(row: PackageRow): PackageRun {
  const settings = parseJson<PackageSettings>(row.settings);
  return {
    id: row.id, status: row.status, activity: packageActivity.get(row.id) ?? null, planRunId: settings?.planRunId ?? null,
    motifWeight: settings?.motifWeight ?? null, directorLlm: settings?.directorLlm ?? null, error: row.error, startedAt: row.created_at, completedAt: row.completed_at,
  };
}

export function toPackage(row: PackageRow): PromptPackage | null {
  const stored = parseJson<StoredPackage>(row.plan_json);
  if (!stored) return null;
  return {
    runId: row.id, folder: stored.folder, packageFile: stored.packageFile, clipCount: stored.clipCount, shotCount: stored.shotCount,
    steps: stored.steps, warnings: stored.warnings, polish: stored.polish, reports: stored.reports, writtenAt: row.completed_at ?? row.created_at,
  };
}

export function toAttempt(row: AttemptRow): RenderAttempt {
  const cleanup = parseJson<CleanupEvidence>(row.cleanup);
  return {
    id: row.id, attempt: row.attempt, loaderMode: row.loader_mode, status: row.status, phase: attemptPhase.get(row.id) ?? null, step: attemptStep.get(row.id) ?? null, promptId: row.prompt_id,
    noiseSeed: row.noise_seed, cleanup: row.cleanup_status, cleanupDetail: cleanupText(cleanup), outputPath: row.output_path, loaderReport: row.loader_report,
    error: row.error, startedAt: row.started_at, submittedAt: row.submitted_at, renderedAt: row.rendered_at, finishedAt: row.finished_at,
  };
}

function toQueue(row: QueueRow): RenderQueueState {
  return {
    id: row.id, kind: row.kind, requested: row.requested, target: row.target, completed: row.completed, retryClip: row.retry_clip, status: row.status,
    stopRequestedAt: row.stop_requested_at, message: row.message, createdAt: row.created_at, finishedAt: row.finished_at,
  };
}

function gib(bytes: number | null): string {
  return bytes === null ? "?" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function cleanupText(evidence: CleanupEvidence | null): string | null {
  if (!evidence) return null;
  if (evidence.status === "failed") return `Cleanup failed${evidence.acceptedAt ? " after ComfyUI accepted /free" : ""}: ${evidence.error}`;
  if (evidence.status === "accepted") return "ComfyUI accepted /free (unload models + free memory); waiting for its cleanup cycle.";
  const vram = evidence.vramFreeBefore !== null && evidence.vramFreeAfter !== null ? ` ComfyUI reported free VRAM ${gib(evidence.vramFreeBefore)} → ${gib(evidence.vramFreeAfter)}.` : "";
  return `ComfyUI accepted /free and completed its cleanup cycle (queue idle, server responsive).${vram}`;
}

async function gpuLabel(): Promise<string | null> {
  if (Date.now() - gpuCache.at < 60_000) return gpuCache.label;
  const status = await comfyStatus();
  const device = (status.system as { devices?: Array<{ name?: unknown; vram_total?: unknown }> } | undefined)?.devices?.[0];
  let label: string | null = null;
  if (device && typeof device.name === "string") {
    const name = device.name.replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*cudaMallocAsync$/i, "").replace(/^NVIDIA (GeForce )?/, "").trim();
    label = typeof device.vram_total === "number" ? `${name} / ${Math.round(device.vram_total / 1024 ** 3)} GB VRAM` : name;
  }
  gpuCache = { label, at: Date.now() };
  return label;
}

async function readFolder(folder: string): Promise<FolderFile[]> {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const files: FolderFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp4")) continue;
      try {
        const stat = await fs.stat(path.join(folder, entry.name));
        files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch { /* A file being written right now. */ }
    }
    return files;
  } catch { return []; }
}

export function clipRows(packageRunId: string): ClipRow[] {
  return db().prepare("SELECT * FROM render_clips WHERE package_run_id = ? ORDER BY clip_index").all(packageRunId) as ClipRow[];
}

export function attemptRows(packageRunId: string): AttemptRow[] {
  return db().prepare("SELECT * FROM render_attempts WHERE package_run_id = ? ORDER BY started_at").all(packageRunId) as AttemptRow[];
}

function latestQueueRow(projectId: string, packageRunId: string): QueueRow | null {
  return (db().prepare("SELECT * FROM render_queues WHERE project_id = ? AND package_run_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId, packageRunId) as QueueRow | undefined) ?? null;
}

/** Brings clip rows in line with the package folder: a playable-looking video means rendered; a vanished one means pending. */
export async function syncClipsWithDisk(packageRunId: string, folder: string): Promise<ClipRow[]> {
  const files = await readFolder(folder);
  const rows = clipRows(packageRunId);
  const at = now();
  for (const row of rows) {
    if (row.last_attempt_id && attemptPhase.has(row.last_attempt_id)) continue; // being rendered right now
    const video = findVideo(files, row.video_name);
    if (video) {
      const output = path.join(folder, video.name);
      if (row.status !== "rendered" || row.output_path !== output) {
        update("render_clips", row.id, { status: "rendered", output_path: output, error: null, rendered_at: row.rendered_at ?? new Date(video.mtimeMs).toISOString(), updated_at: at });
      }
    } else if (row.status === "rendered") {
      update("render_clips", row.id, { status: "pending", output_path: null, error: "The rendered file is no longer in the package folder.", updated_at: at });
    }
  }
  return clipRows(packageRunId);
}

// ----- Overview --------------------------------------------------------------------------------------------

function sectionsFor(plan: PlanData | null): TimelineSection[] {
  return (plan?.sections ?? []).map((section) => ({
    number: section.number, start: section.start, end: section.end, label: section.label || section.role, phase: section.wheelPhase,
  }));
}

const CACHE_TEXT: Record<string, { text: string; tone: DecisionRow["tone"] }> = {
  reused: { text: "HIT — the director plan was reused unchanged", tone: "ok" },
  partly_reused: { text: "Partly reused — some planning steps came from the director cache", tone: "info" },
  new: { text: "MISS — the plan was written new by the local LLM", tone: "info" },
  rerolled: { text: "Rerolled — a new story was planned", tone: "info" },
  no_llm: { text: "Planned from the song only (no LLM story steps)", tone: "info" },
  unknown: { text: "The planner report did not include cache lines", tone: "none" },
};

export async function produceOverview(projectId: unknown): Promise<ProduceOverview> {
  const project = getProject(projectId);
  const plans = await planOverview(project.id);
  const locations = await locationsOverview(project.id);
  const latestRow = latestPackageRow(project.id);
  const currentRow = currentPackageRow(project.id);
  const pkg = currentRow ? toPackage(currentRow) : null;
  const settings = parseJson<PackageSettings>(currentRow?.settings);
  const busy = productionBusy();
  const plan = plans.plan;

  const packageStale: string[] = [];
  const packageNotes: string[] = [];
  const editableSourceMissing = Boolean(pkg && !existsSync(path.join(pkg.folder, "clip_creatives.json")));
  if (editableSourceMissing) {
    packageNotes.push("This older prompt package predates per-clip Prompt Workshop sources. Write a new prompt package to enable one-clip retries and edits.");
  }
  // Steps are read at render time, so changing them never makes the package's settings out of date.
  const promptSettings = (direction: CreativeDirection) => JSON.stringify({ ...direction, renderSteps: undefined });
  if (pkg && settings?.direction && promptSettings(settings.direction) !== promptSettings(plans.direction)) {
    packageNotes.push("Shot mix, pacing, lip-sync, or prompt settings changed on Direction. This package keeps its saved settings; write a new prompt package to apply the new values.");
  }
  if (pkg && settings) {
    if (settings.planRunId !== plans.planRun?.id) packageStale.push("The director plan changed after this prompt package was written.");
    else if (settings.motifWeight !== plans.direction.motifWeight) {
      packageNotes.push(`The surreal motif weight changed on Direction (${settings.motifWeight} → ${plans.direction.motifWeight}). These prompts were written with ${settings.motifWeight}; a new prompt package would use the new value and start a new clip folder.`);
    }
  }

  const packageBlockers: string[] = [];
  if (!project.folderExists) packageBlockers.push(`The project folder is missing: ${project.projectPath}.`);
  if (!plan) packageBlockers.push("There is no director plan yet. Create one on the Plan page.");
  else {
    if (plans.latestRun?.status === "queued" || plans.latestRun?.status === "running") packageBlockers.push("A director plan is being made. Wait for it to finish.");
    if (plans.freshness.state === "stale") {
      packageBlockers.push(`The director plan is out of date: ${plans.freshness.reasons.join(" ")} Create the plan again on the Plan page (unchanged steps are reused from the director cache).`);
    }
    if (!locations.ready) {
      const missing = locations.requested.filter((item) => !item.passedToMiniMax);
      packageBlockers.push(missing.some((item) => item.mode === "not_checked" || item.changedSinceCheck)
        ? `Check for images has not confirmed ${missing.map((item) => item.name).join(", ")} for this plan. Click Check for images on Locations.`
        : `Needs location images: ${missing.map((item) => item.name).join(", ")}. Add them on Locations, then click Check for images.`);
    }
  }
  if (latestRow && (latestRow.status === "queued" || latestRow.status === "running")) packageBlockers.push("A prompt package is being written.");
  if (busy?.kind === "render") packageBlockers.push(busy.projectId === project.id ? "Clips are rendering. Use Stop after current clip and wait for it to finish first." : "Another project is rendering.");
  if (busy?.kind === "stitch") packageBlockers.push("A final video is being stitched. Wait for it to finish.");
  const latestFailed = latestRow && (latestRow.status === "failed" || latestRow.status === "interrupted") && latestRow.id !== currentRow?.id;
  const canWritePackage = !packageBlockers.length && (!pkg || packageStale.length > 0 || packageNotes.length > 0 || Boolean(latestFailed));

  // Clips, attempts, queue.
  let rows: ClipRow[] = [];
  let attempts: AttemptRow[] = [];
  let queueRow: QueueRow | null = null;
  if (pkg && currentRow) {
    rows = await syncClipsWithDisk(currentRow.id, pkg.folder);
    attempts = attemptRows(currentRow.id);
    queueRow = latestQueueRow(project.id, currentRow.id);
  }
  const attemptById = new Map(attempts.map((row) => [row.id, row]));
  const queueActive = queueRow?.status === "running" || queueRow?.status === "stopping";
  const missing = rows.filter((row) => row.status !== "rendered").map((row) => row.clip_index);
  const current = attempts.find((row) => attemptPhase.has(row.id)) ?? null;
  let upcoming: number[] = [];
  if (queueActive && queueRow) {
    const left = Math.max(0, queueRow.target - queueRow.completed);
    upcoming = (queueRow.kind === "retry" || queueRow.kind === "specific") && queueRow.retry_clip ? (left ? [queueRow.retry_clip] : []) : missing.slice(0, left);
    if (current && !upcoming.includes(current.clip_index)) upcoming.unshift(current.clip_index);
  }
  const clips: ProduceClip[] = rows.map((row) => {
    const meta = parseJson<ClipMetaExtra>(row.meta) ?? {};
    const last = row.last_attempt_id ? attemptById.get(row.last_attempt_id) ?? null : null;
    let status: ClipStatus = row.status;
    if (current?.clip_index === row.clip_index) status = "rendering";
    else if (status !== "rendered" && upcoming.includes(row.clip_index)) status = "queued";
    return {
      index: row.clip_index, section: row.section_number, shot: row.shot_number, start: row.song_start, end: row.song_end,
      mode: (row.scene ?? "") as ProduceClip["mode"], location: row.location ?? "", outfit: row.outfit ?? "", action: row.action ?? "",
      transition: row.transition ?? "", continuity: continuityFor(row), status, attempts: row.attempts, outputPath: row.output_path,
      promptPath: path.join(pkg!.folder, row.prompt_file), error: row.error, metadataMatched: meta.matched !== false,
      lastAttempt: last ? toAttempt(last) : null,
    };
  });
  const rendered = rows.filter((row) => row.status === "rendered").length;
  const failed = rows.filter((row) => row.status === "failed" || row.status === "interrupted").length;

  // Timing evidence: finished, successful attempts of this package (submission to end of cleanup).
  const durations = attempts.filter((row) => row.status === "complete" && row.submitted_at && row.finished_at)
    .map((row) => (new Date(row.finished_at!).getTime() - new Date(row.submitted_at!).getTime()) / 1000);
  const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null;
  const currentElapsed = current?.submitted_at ? (Date.now() - new Date(current.submitted_at).getTime()) / 1000 : 0;
  const clipsLeft = queueActive && queueRow ? Math.max(0, queueRow.target - queueRow.completed) : 0;

  const renderBlockers: string[] = [];
  if (!pkg) renderBlockers.push("Write the prompt package first.");
  if (packageStale.length) renderBlockers.push(`${packageStale.join(" ")} Write a new prompt package before rendering more clips.`);
  if (latestRow && (latestRow.status === "queued" || latestRow.status === "running")) renderBlockers.push("A prompt package is being written.");
  if (busy && !(busy.kind === "render" && busy.projectId === project.id)) {
    renderBlockers.push(busy.projectId !== project.id ? "Another project is using ComfyUI." : busy.kind === "stitch" ? "The final video is being stitched." : "A prompt package is being written.");
  }
  if (pkg && !missing.length) renderBlockers.push("Every clip in this package is rendered.");

  const planEvidence: DecisionRow[] = [];
  if (plans.planRun) {
    const cache = CACHE_TEXT[plans.planRun.cacheResult ?? "unknown"] ?? CACHE_TEXT.unknown;
    planEvidence.push({ label: "Plan cache", value: cache.text, tone: cache.tone, at: plans.planRun.completedAt });
  }
  const check = locations.latestCheck;
  if (check?.status === "complete") {
    planEvidence.push({ label: "Location check", value: check.summary.join(" · ") || "No performer-location images were requested.", tone: check.readyToProduce ? "ok" : "warn", at: check.completedAt });
  }

  const events = (db().prepare(`SELECT id, category, body, created_at FROM project_reports WHERE project_id = ? AND category IN (${EVENT_CATEGORIES.map(() => "?").join(", ")})
    ORDER BY created_at DESC LIMIT 60`).all(project.id, ...EVENT_CATEGORIES) as { id: string; category: string; body: string; created_at: string }[])
    .map((row): ProduceEvent => ({ id: row.id, category: row.category, body: row.body, at: row.created_at }));
  const song = project.assets.find((asset) => asset.role === "song" && asset.available);

  return {
    projectId: project.id, projectName: project.name, durationSeconds: plan?.durationSeconds ?? project.songDurationSeconds, songUrl: song?.previewUrl ?? null,
    gpu: await gpuLabel(), packageBlockers, packageStale, packageNotes, canWritePackage, latestPackageRun: latestRow ? toPackageRun(latestRow) : null, package: pkg,
    clips, counts: { total: rows.length, rendered, failed, remaining: rows.length - rendered }, queue: queueRow ? toQueue(queueRow) : null, upcoming,
    currentClip: current?.clip_index ?? null, busy: busy ? { ...busy } : null,
    timing: {
      elapsedSince: queueRow?.created_at ?? null, averageSeconds: average, samples: durations.length,
      estimateSeconds: queueActive ? estimateRemaining(durations, clipsLeft, currentElapsed) : null,
    },
    sections: sectionsFor(plan), planEvidence, events, renderBlockers,
  };
}

function continuityFor(row: ClipRow): string {
  const meta = parseJson<{ continuity?: string }>(row.meta);
  return meta?.continuity ?? row.transition ?? "";
}

// ----- Write prompt package --------------------------------------------------------------------------------

function setPackageActivity(runId: string, projectId: string, phase: NonNullable<PackageRun["activity"]>["phase"], queuePosition?: number): void {
  const previous = packageActivity.get(runId);
  if (previous?.phase === phase && previous.queuePosition === queuePosition) return;
  packageActivity.set(runId, { phase, since: previous?.phase === phase ? previous.since : now(), queuePosition });
  notify(projectId);
}

/** Starts Write prompt package in the background and returns at once. Progress and the result are announced through onChange. */
export async function startPromptPackage(projectId: unknown): Promise<ProduceOverview> {
  const project = projectIdentity(projectId);
  const release = claimProduction("package", project.id);
  try {
    const overview = await produceOverview(project.id);
    if (overview.packageBlockers.length) throw new Error(overview.packageBlockers.join(" "));
    if (!overview.canWritePackage) throw new Error("The prompt package for this plan is already written. Nothing changed that needs a new one.");
    const comfy = await comfyStatus();
    if (!comfy.connected) throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI, wait until it has finished loading, then try again. (${comfy.message})`);
    const plans = await planOverview(project.id);
    const settings: PackageSettings = {
      planRunId: plans.planRun!.id, motifWeight: plans.direction.motifWeight, seed: plans.plan!.seed, directorLlm: null, renderName: RENDER_NAME,
      direction: plans.direction,
    };
    const runId = randomUUID();
    db().prepare("INSERT INTO director_runs (id, project_id, stage, seed, settings, kind, status, created_at) VALUES (?, ?, ?, ?, ?, 'package', 'queued', ?)")
      .run(runId, project.id, PACKAGE_STAGE, settings.seed, JSON.stringify(settings), now());
    packageActivity.set(runId, { phase: "waiting", since: now() });
    void serializeComfyWork(() => executePackage(runId, project.id, settings, comfy.endpoint))
      .catch(() => undefined)
      .finally(() => { release(); notify(project.id); });
    return produceOverview(project.id);
  } catch (error) {
    release();
    throw error;
  }
}

async function readStory(file: string): Promise<{ bytes: Buffer; raw: RawStoryPlan }> {
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); } catch { throw new Error(`${file} is missing. Create the director plan again on the Plan page.`); }
  try { return { bytes, raw: JSON.parse(bytes.toString("utf-8")) as RawStoryPlan }; }
  catch { throw new Error(`${file} could not be read. Create the director plan again on the Plan page.`); }
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function executePackage(runId: string, projectId: string, settings: PackageSettings, endpoint: string): Promise<void> {
  const reports = { resolve: "", production: "", package: "" };
  let cleanupNote: CleanupEvidence | null = null;
  try {
    update("director_runs", runId, { status: "running" });
    const project = projectIdentity(projectId);
    const plans = await planOverview(projectId);
    if (!plans.plan || plans.planRun?.id !== settings.planRunId) throw new Error("The director plan changed while this package was waiting. Write the prompt package again.");
    const plan = plans.plan;

    // The saved story on disk must be the plan Martini Shot shows; the package is built from it unchanged.
    const storyFile = path.join(project.projectPath, "story_plan.json");
    const before = await readStory(storyFile);
    const onDisk = parseStoryPlan(before.raw, { projectPath: project.projectPath, suppliedLocations: suppliedLocationNames(projectId), report: "" });
    if (storySignature(onDisk) !== storySignature(plan)) {
      throw new Error(`${storyFile} no longer matches the plan shown in Martini Shot (it may have been re-planned directly in ComfyUI). Create the director plan again on the Plan page; nothing was written.`);
    }
    const storyHash = storyFileHash(before.bytes);
    const locations = await locationsOverview(projectId);
    if (!locations.ready) throw new Error("Requested performer locations are no longer all image-backed. Check for images on Locations.");

    setPackageActivity(runId, projectId, "saving_project");
    const saveProblem = await ensureComfyProjectSaved(projectId);
    if (saveProblem) throw new Error(`The project could not be saved through ComfyUI: ${saveProblem}`);
    const llms = await directorLlmOptions();
    if (!llms.selected) throw new Error(llms.error || "No local director LLM is available in ComfyUI's Prompt LLM Loader.");
    const finalSettings: PackageSettings = { ...settings, directorLlm: llms.selected };
    update("director_runs", runId, { settings: JSON.stringify(finalSettings) });

    const packageFile = path.join(project.projectPath, "render_package.json");
    const packageBefore = existsSync(packageFile) ? (await fs.stat(packageFile)).mtimeMs : 0;
    const jobId = randomUUID();
    update("director_runs", runId, { comfy_job_id: jobId });
    let outputs: unknown;
    try {
      const direction = finalSettings.direction;
      const run = await runWorkflowTemplate(development, "04-write-prompt-package.json", {
        project_name: project.slug, seed: finalSettings.seed, director_llm: llms.selected, render_name: finalSettings.renderName, motif_weight: finalSettings.motifWeight,
        dance_style: direction.danceStyle, target_shot_seconds: direction.targetShotSeconds, min_shot_seconds: direction.minShotSeconds,
        max_shot_seconds: direction.maxShotSeconds, cut_rate_vs_energy: direction.cutRateVsEnergy, broll_amount: direction.brollAmount,
        performance_vs_dance: direction.performanceVsDance, freeform_amount: direction.freeformAmount, location_variety: direction.locationVariety,
        chorus_consistency: direction.chorusConsistency, outfit_change_rate: direction.outfitChangeRate, continue_bias: direction.continueBias,
        hard_cuts_change_location: direction.hardCutsChangeLocation, lip_sync: direction.lipSync,
      }, projectId, undefined, { jobId, onProgress: (progress: WorkflowProgress) => setPackageActivity(runId, projectId, progress.phase, progress.queuePosition) });
      outputs = run.outputs;
      cleanupNote = run.cleanup;
    } catch (error) {
      if (error instanceof ComfyWorkflowError) {
        reports.resolve = previewText(error.outputs, "resolve_report") ?? "";
        reports.production = previewText(error.outputs, "production_report") ?? "";
        cleanupNote = error.cleanup;
        // The package was written; only /free could not be confirmed. Keep the package and report the cleanup failure.
        if (!error.completed) throw error;
        outputs = error.outputs;
      } else throw error;
    }

    reports.resolve = previewText(outputs, "resolve_report") ?? "";
    reports.production = previewText(outputs, "production_report") ?? "";
    reports.package = previewText(outputs, "package_report") ?? "";
    const ready = previewText(outputs, "ready_to_produce");
    const remoteFolderText = (previewText(outputs, "package_folder") ?? "").trim();
    const folderText = localProjectPath(project, remoteFolderText);
    if (!reports.production || !reports.package || !folderText) throw new Error("ComfyUI finished, but the production-plan or prompt-package report was not in its results.");
    if (ready?.trim().toLowerCase() !== "true") throw new Error(`ComfyUI's location check did not report ready_to_produce. ${reports.resolve}`);

    // Plan stability: the package must have been built from the saved story, untouched.
    const after = await readStory(storyFile);
    if (storyFileHash(after.bytes) !== storyHash) throw new Error(`${storyFile} changed while the package was written. Open the Plan page to see the current plan.`);

    const production = parseProductionReport(reports.production);
    if (!production) throw new Error("The production-plan report could not be read.");
    const packageReport = parsePackageReport(reports.package);

    // render_package.json must have been written by this run and point at the folder ComfyUI reported.
    const packageAfter = existsSync(packageFile) ? (await fs.stat(packageFile)).mtimeMs : 0;
    if (!packageAfter || packageAfter <= packageBefore) {
      throw new Error(`ComfyUI finished, but ${packageFile} was not written by this run. Check that the ComfyUI output folder in Settings belongs to the running ComfyUI.`);
    }
    const saved = parseJson<{ folder?: unknown; project?: unknown }>(await fs.readFile(packageFile, "utf-8"));
    if (!saved || typeof saved.folder !== "string" || !samePath(localProjectPath(project, saved.folder), folderText)) throw new Error(`${packageFile} does not name the folder ComfyUI just wrote (${remoteFolderText}).`);
    const savedFolder = saved.folder as string;
    // Keep local artifacts local-authoritative so switching back to This PC
    // later does not leave a remote machine path in the package manifest.
    if (savedFolder !== localProjectPath(project, savedFolder)) {
      saved.folder = localProjectPath(project, savedFolder);
      await fs.writeFile(packageFile, JSON.stringify(saved, null, 2));
    }
    const localSavedFolder = localProjectPath(project, savedFolder);
    if (!isInside(project.projectPath, localSavedFolder)) throw new Error(`The prompt package folder ${localSavedFolder} is not inside the project folder.`);
    const folder = path.resolve(localSavedFolder);
    let manifestRaw: unknown;
    try { manifestRaw = JSON.parse(await fs.readFile(path.join(folder, "segments.json"), "utf-8")); }
    catch { throw new Error(`${path.join(folder, "segments.json")} is missing or unreadable.`); }
    const manifest = parseManifest(manifestRaw);
    if (packageReport.table.size && packageReport.table.size !== manifest.segments.length) {
      throw new Error(`The prompt-package report lists ${packageReport.table.size} clips but segments.json has ${manifest.segments.length}.`);
    }
    const metas = clipMetadata(manifest.segments, production.shots, packageReport.table);
    const unmatched = metas.filter((meta) => !meta.matched).length;
    const missingPrompts = manifest.segments.filter((segment) => !existsSync(path.join(folder, segment.promptFile))).map((segment) => segment.promptFile);
    if (missingPrompts.length) throw new Error(`The prompt package is missing ${missingPrompts.join(", ")}.`);

    const sectionsUsed = new Set(production.shots.map((shot) => shot.section)).size;
    const resolveLines = reports.resolve.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean);
    const at = now();
    const steps: DecisionRow[] = [
      { label: "Plan reused", value: "story_plan.json loaded unchanged — the story planner did not run", tone: "ok", at },
      { label: "Locations", value: resolveLines.length ? resolveLines.join(" · ") : "No performer-location images were requested", tone: "ok", at },
      { label: "Production plan built", value: `${production.shotCount} shots across ${sectionsUsed} song sections (deterministic, seed ${finalSettings.seed})`, tone: "ok", at },
      { label: "Prompt package written", value: `${manifest.segments.length} clip prompts in ${folder}`, tone: "ok", at },
    ];
    if (unmatched) steps.push({ label: "Clip details", value: `${unmatched} clip(s) could not be matched to a production shot; their section/location are shown as unknown`, tone: "warn", at });
    if (cleanupNote) steps.push({ label: "ComfyUI cleanup", value: cleanupText(cleanupNote) ?? "", tone: cleanupNote.status === "completed" ? "ok" : "fail", at });

    const stored: StoredPackage = {
      folder, packageFile, clipCount: manifest.segments.length, shotCount: production.shotCount, steps, warnings: packageReport.warnings,
      polish: packageReport.polish, reports, clipNotes: Object.fromEntries([...packageReport.clipNotes].map(([key, value]) => [String(key), value])), storyHash,
    };
    db().exec("BEGIN");
    try {
      const insert = db().prepare(`INSERT INTO render_clips (id, project_id, package_run_id, clip_index, shot_number, section_number, song_start, song_end, scene,
        location, outfit, action, transition, overlap_frames, video_name, prompt_file, meta, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
      for (const meta of metas) insert.run(randomUUID(), projectId, runId, meta.index, meta.shot, meta.section, meta.start, meta.end, meta.mode, meta.location,
        meta.outfit, meta.action, meta.transition, meta.overlapFrames, meta.videoName, meta.promptFile, JSON.stringify(extraMeta(meta)), at);
      update("director_runs", runId, { status: "complete", completed_at: at, report: [reports.resolve, reports.production, reports.package].join("\n\n"), plan_json: JSON.stringify(stored), error: null });
      db().prepare("UPDATE martini_projects SET current_package_run_id = ?, status = 'prompt_package_ready', updated_at = ? WHERE id = ?").run(runId, at, projectId);
      addReport(projectId, "prompt_package", steps.map((step) => `${step.label}: ${step.value}`).join("\n"), { reports, folder, clipCount: manifest.segments.length, comfyJobId: jobId }, runId);
      db().exec("COMMIT");
    } catch (error) {
      db().exec("ROLLBACK");
      throw error;
    }
    await syncClipsWithDisk(runId, folder);
  } catch (error) {
    const message = readableProductionError(error instanceof Error ? error.message : String(error), endpoint);
    const partial = [reports.resolve && `Resolve Locations:\n${reports.resolve}`, reports.production && `Build Production Plan:\n${reports.production}`].filter(Boolean).join("\n\n");
    update("director_runs", runId, { status: "failed", error: message, completed_at: now(), report: partial || null });
    addReport(projectId, "prompt_package_error", message + (cleanupNote ? `\n${cleanupText(cleanupNote)}` : ""), { reports }, runId);
  } finally {
    packageActivity.delete(runId);
    notify(projectId);
  }
}

function extraMeta(meta: ClipMeta): ClipMetaExtra & { continuity: string } {
  const shot = meta.productionShot;
  return {
    continuity: meta.continuity, matched: meta.matched, camera: shot?.camera, role: shot?.role, sectionLabel: shot?.sectionLabel,
    storyDriven: shot ? Boolean(shot.storyAction) : undefined, flags: shot?.flags, subject: shot?.subject || undefined,
  };
}

// ----- Render queue ----------------------------------------------------------------------------------------

export function queueRender(projectId: unknown, count: unknown): Promise<ProduceOverview> {
  const requested = validateQueueCount(count);
  return startQueue(projectId, "count", requested, null);
}

/** The explicit "Resume / Queue remaining" action: renders every clip that has no video yet. */
export function queueRemaining(projectId: unknown): Promise<ProduceOverview> {
  return startQueue(projectId, "remaining", Number.MAX_SAFE_INTEGER, null);
}

export function retryClip(projectId: unknown, clipIndex: unknown): Promise<ProduceOverview> {
  return startQueue(projectId, "retry", 1, validateClipIndex(clipIndex));
}

/** Renders one selected missing clip in Fixed index mode. Continue clips need their immediate predecessor on disk. */
export function queueSpecificClip(projectId: unknown, clipIndex: unknown): Promise<ProduceOverview> {
  return startQueue(projectId, "specific", 1, validateClipIndex(clipIndex));
}

export async function stopAfterCurrent(projectId: unknown): Promise<ProduceOverview> {
  const project = projectIdentity(projectId);
  const row = db().prepare("SELECT * FROM render_queues WHERE project_id = ? AND status IN ('running', 'stopping') ORDER BY created_at DESC LIMIT 1").get(project.id) as QueueRow | undefined;
  if (!row) throw new Error("Nothing is rendering for this project.");
  if (row.status === "running") {
    update("render_queues", row.id, { status: "stopping", stop_requested_at: now() });
    addReport(project.id, "render_queue", "Stop after current clip requested. The clip already in ComfyUI will finish; no further clip will start.", { queueId: row.id });
    notify(project.id);
  }
  return produceOverview(project.id);
}

/** Before any new render: settles attempts that were running when Martini Shot closed, using ComfyUI's own queue and history.
 *  Refuses to continue while ComfyUI is still executing one of them (Next missing would otherwise render that clip twice). */
async function reconcileInterrupted(projectId: string, packageRunId: string, folder: string): Promise<void> {
  const rows = (db().prepare("SELECT * FROM render_attempts WHERE package_run_id = ? AND status = 'interrupted' AND prompt_id IS NOT NULL").all(packageRunId) as AttemptRow[]);
  if (!rows.length) return;
  const queue = await comfyQueueIds(rows[0]?.remote_endpoint || undefined);
  const busyRow = rows.find((row) => queue.running.includes(row.prompt_id!) || queue.pending.includes(row.prompt_id!));
  if (busyRow) {
    throw new Error(`ComfyUI is still rendering clip ${busyRow.clip_index}, which started before Martini Shot was closed. Wait for it to finish in ComfyUI, then queue again.`);
  }
  let needsCleanup = false;
  for (const row of rows) {
    const history = await comfyHistory(row.prompt_id!, row.remote_endpoint || undefined);
    const at = now();
    if (history?.status === "success") {
      const saved = savedVideo(history.outputs, "save");
      let output: string | null = null;
      if (saved && row.remote_endpoint) {
        const project = projectIdentity(projectId); const worker = new RemoteRenderStaging(row.remote_endpoint, (await getMachineSettings()).remoteFileApiToken);
        const target = remoteOutputPath(project.slug, project.projectPath, folder, saved.subfolder, saved.filename);
        const stat = await worker.stat(target.remote); if (stat.exists && stat.type === "file" && stat.size) { await worker.download(target.remote, target.local); output = target.local; }
      } else if (saved) output = path.join((await getMachineSettings()).comfyOutputDir, saved.subfolder, saved.filename);
      update("render_attempts", row.id, {
        status: "complete", output_path: output, loader_report: previewText(history.outputs, "clip_report"), rendered_at: at, finished_at: at,
        error: "Finished in ComfyUI while Martini Shot was closed.", cleanup_status: "not_requested",
      });
      addReport(projectId, "render_recovery", `Clip ${row.clip_index} finished in ComfyUI while Martini Shot was closed${output ? `: ${output}` : ""}.`, { attemptId: row.id, promptId: row.prompt_id });
      needsCleanup = true;
    } else if (history?.status === "error") {
      update("render_attempts", row.id, { status: "failed", error: `ComfyUI reported this clip failed while Martini Shot was closed.` });
      needsCleanup = true;
    }
  }
  await syncClipsWithDisk(packageRunId, folder);
  if (needsCleanup) {
    const cleanup = await freeComfyMemory(rows.find((row) => row.remote_endpoint)?.remote_endpoint || undefined);
    addReport(projectId, "render_cleanup", `Cleanup after recovering earlier renders: ${cleanupText(cleanup)}`, cleanup);
    if (cleanup.status !== "completed") throw new Error(`ComfyUI cleanup did not complete, so no new clip was started. ${cleanup.error ?? ""}`);
  }
}

async function startQueue(projectId: unknown, kind: RenderQueueState["kind"], requested: number, retryIndex: number | null): Promise<ProduceOverview> {
  const project = projectIdentity(projectId);
  // Claimed before any await: a second click or IPC call fails here instead of starting a second loop.
  const release = claimProduction("render", project.id);
  try {
    const overview = await produceOverview(project.id);
    const blockers = overview.renderBlockers.filter((blocker) => !((kind === "retry" || kind === "specific") && blocker.startsWith("Every clip")));
    if (blockers.length) throw new Error(blockers.join(" "));
    const pkgRow = currentPackageRow(project.id)!;
    const pkg = overview.package!;
    const machine = await getMachineSettings();
    let endpoint: string;
    if (machine.executionDestination === "remote") {
      const worker = new RemoteRenderStaging(machine.remoteComfyUrl, machine.remoteFileApiToken);
      await worker.checkConnection();
      endpoint = worker.endpoint;
    } else {
      const comfy = await comfyStatus();
      if (!comfy.connected) throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI, wait until it has finished loading, then queue again. (${comfy.message})`);
      endpoint = comfy.endpoint;
    }
    await reconcileInterrupted(project.id, pkgRow.id, pkg.folder);
    const rows = await syncClipsWithDisk(pkgRow.id, pkg.folder);
    const remaining = rows.filter((row) => row.status !== "rendered");
    let target: number;
    if (kind === "retry" || kind === "specific") {
      const row = rows.find((item) => item.clip_index === retryIndex);
      if (!row) throw new Error(`Clip ${retryIndex} is not in this prompt package.`);
      if (row.status === "rendered") throw new Error(`Clip ${retryIndex} is already rendered.`);
      if (kind === "retry" && row.status !== "failed" && row.status !== "interrupted") throw new Error(`Clip ${retryIndex} has not failed; use Render clip ${retryIndex} instead.`);
      if ((row.transition === "Continue" || row.transition === "New angle") && row.overlap_frames > 0) {
        const previous = rows.find((item) => item.clip_index === row.clip_index - 1);
        if (!previous || previous.status !== "rendered") {
          const reason = row.transition === "New angle"
            ? `uses clip ${row.clip_index - 1} as a motion bridge before its internal camera cut`
            : `continues from clip ${row.clip_index - 1}`;
          throw new Error(`Clip ${row.clip_index} can't render yet because it ${reason}, which has not been rendered. Render clip ${row.clip_index - 1} first so Martini Shot has the previous shot to continue from.`);
        }
      }
      target = 1;
    } else {
      target = queueTarget(requested, remaining.length);
      if (!target) throw new Error("Every clip in this package is already rendered.");
    }
    const queueId = randomUUID();
    const at = now();
    db().prepare(`INSERT INTO render_queues (id, project_id, package_run_id, kind, requested, target, retry_clip, completed, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'running', ?)`).run(queueId, project.id, pkgRow.id, kind, Math.min(requested, 2 ** 31 - 1), target, retryIndex, at);
    db().prepare("UPDATE martini_projects SET status = 'rendering', updated_at = ? WHERE id = ?").run(at, project.id);
    addReport(project.id, "render_queue", kind === "retry"
      ? `Retry clip ${retryIndex} queued (that clip only).`
      : kind === "specific"
        ? `Render clip ${retryIndex} queued (that clip only).`
      : `Queued ${target} clip${target === 1 ? "" : "s"}${requested > target && kind === "count" ? ` (asked for ${requested}; ${remaining.length} remained)` : ""}${kind === "remaining" ? " — all remaining clips" : ""}. One ComfyUI render at a time.`,
    { queueId, requested: kind === "remaining" ? "remaining" : requested, target });
    void runQueue(queueId, project.id, pkgRow.id, endpoint)
      .catch((error: unknown) => finishQueue(queueId, project.id, "failed", readableProductionError(error instanceof Error ? error.message : String(error), endpoint)))
      .finally(() => { release(); notify(project.id); });
    notify(project.id);
    return produceOverview(project.id);
  } catch (error) {
    release();
    throw error;
  }
}

function queueRow(id: string): QueueRow {
  return db().prepare("SELECT * FROM render_queues WHERE id = ?").get(id) as QueueRow;
}

function finishQueue(queueId: string, projectId: string, status: RenderQueueState["status"], message: string): void {
  const at = now();
  update("render_queues", queueId, { status, message, finished_at: at });
  const row = queueRow(queueId);
  const left = (db().prepare("SELECT COUNT(*) AS n FROM render_clips WHERE package_run_id = ? AND status <> 'rendered'").get(row.package_run_id) as { n: number }).n;
  db().prepare("UPDATE martini_projects SET status = ?, updated_at = ? WHERE id = ? AND status = 'rendering'").run(left ? "prompt_package_ready" : "stitch_ready", at, projectId);
  addReport(projectId, "render_queue", message, { queueId, status, completed: row.completed, target: row.target });
  notify(projectId);
}

async function runQueue(queueId: string, projectId: string, packageRunId: string, endpoint: string): Promise<void> {
  for (;;) {
    const queue = queueRow(queueId);
    if (queue.completed >= queue.target) {
      finishQueue(queueId, projectId, "complete", `Queue finished: ${queue.completed} clip${queue.completed === 1 ? "" : "s"} rendered.`);
      return;
    }
    if (queue.stop_requested_at) {
      finishQueue(queueId, projectId, "stopped", `Stopped after the current clip as requested. ${queue.completed} of ${queue.target} queued clip${queue.target === 1 ? "" : "s"} rendered; nothing else was started.`);
      return;
    }
    const pkgRow = currentPackageRow(projectId);
    const pkg = pkgRow ? toPackage(pkgRow) : null;
    if (!pkgRow || !pkg || pkgRow.id !== packageRunId) {
      finishQueue(queueId, projectId, "failed", "The prompt package changed while the queue was running. Nothing else was started.");
      return;
    }
    const rows = await syncClipsWithDisk(packageRunId, pkg.folder);
    const singleClip = queue.kind === "retry" || queue.kind === "specific";
    const next = singleClip ? rows.find((row) => row.clip_index === queue.retry_clip && row.status !== "rendered") : rows.find((row) => row.status !== "rendered");
    if (!next) {
      finishQueue(queueId, projectId, "complete", singleClip ? `Clip ${queue.retry_clip} already has a video.` : "Every clip in this package is rendered.");
      return;
    }
    // Other ComfyUI work (e.g. a location check) may be ahead in the app's ComfyUI line; re-check Stop once it is our turn.
    const outcome = await serializeComfyWork(async (): Promise<ClipOutcome | null> => queueRow(queueId).stop_requested_at
      ? null
      : renderClip(queueId, projectId, packageRunId, pkg.folder, next, singleClip ? FIXED_INDEX : NEXT_MISSING, endpoint));
    if (!outcome) continue; // the loop top reports the stop
    if (outcome.ok) {
      update("render_queues", queueId, { completed: queueRow(queueId).completed + 1 });
      notify(projectId);
      if (!outcome.continue) {
        finishQueue(queueId, projectId, "failed", outcome.message);
        return;
      }
      continue;
    }
    finishQueue(queueId, projectId, "failed", outcome.message);
    return;
  }
}

type ClipOutcome = { ok: boolean; continue: boolean; message: string };

async function renderClip(queueId: string, projectId: string, packageRunId: string, folder: string, clip: ClipRow, mode: string, endpoint: string): Promise<ClipOutcome> {
  const attemptId = randomUUID();
  const attemptNumber = clip.attempts + 1;
  const seed = randomInt(0, Math.min(MAX_NOISE_SEED, 2 ** 48 - 1));
  const startedAt = now();
  db().prepare(`INSERT INTO render_attempts (id, project_id, package_run_id, queue_id, clip_index, attempt, loader_mode, noise_seed, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(attemptId, projectId, packageRunId, queueId, clip.clip_index, attemptNumber, mode, seed, startedAt);
  update("render_clips", clip.id, { status: "rendering", attempts: attemptNumber, last_attempt_id: attemptId, error: null, updated_at: startedAt });
  attemptPhase.set(attemptId, "waiting");
  notify(projectId);
  const phase = (value: NonNullable<RenderAttempt["phase"]>) => { if (attemptPhase.get(attemptId) !== value) { attemptPhase.set(attemptId, value); notify(projectId); } };
  // Step events can arrive many times a second (tiled decodes); refresh the page at most every 400 ms, but always on a new node.
  let lastStepNotice = 0;
  const step = (value: StepProgress) => {
    const previous = attemptStep.get(attemptId);
    attemptStep.set(attemptId, value);
    const at = Date.now();
    if (previous?.node !== value.node || value.value === value.max || at - lastStepNotice > 400) { lastStepNotice = at; notify(projectId); }
  };
  const recordCleanup = (evidence: CleanupEvidence) => {
    update("render_attempts", attemptId, { cleanup_status: evidence.status, cleanup: JSON.stringify(evidence) });
    notify(projectId);
  };
  let loaderReport: string | null = null;
  let previewClientId: string | undefined;
  try {
    // The saved Martini Shot render package, passed to Load Render Clip exactly as Write Prompt Package wrote it.
    const packageFile = path.join(projectIdentity(projectId).projectPath, "render_package.json");
    const renderPackage = parseJson<Record<string, unknown>>(await fs.readFile(packageFile, "utf-8").catch(() => null));
    if (!renderPackage || typeof renderPackage.folder !== "string" || !samePath(renderPackage.folder, folder)) {
      throw new Error(`render_package.json no longer points at this package's folder (${folder}). Write the prompt package again.`);
    }
    const jobId = randomUUID();
    update("render_attempts", attemptId, { comfy_job_id: jobId });
    const packageSettings = parseJson<PackageSettings>((db().prepare("SELECT settings FROM director_runs WHERE id = ?").get(packageRunId) as { settings: string } | undefined)?.settings ?? null);
    const direction = packageSettings?.direction;
    const settings = await getMachineSettings();
    const remote = settings.executionDestination === "remote";
    let worker: RemoteRenderStaging | null = null;
    if (remote) {
      worker = new RemoteRenderStaging(settings.remoteComfyUrl, settings.remoteFileApiToken);
      const evidence = await worker.stageProject(projectIdentity(projectId).projectPath, projectIdentity(projectId).slug, folder);
      update("render_attempts", attemptId, { remote_endpoint: worker.endpoint, staging_evidence: JSON.stringify(evidence) });
      addReport(projectId, "render_clip", `Clip ${clip.clip_index}: staged ${evidence.fileCount} files to remote render worker (${evidence.uploaded} uploaded, ${evidence.skipped} unchanged).`, evidence);
    }
    previewClientId = settings.livePreviews ? randomUUID() : undefined;
    if (previewClientId) notifyPreview({ projectId, clipIndex: clip.clip_index, endpoint, clientId: previewClientId });
    // The local manifest stays authoritative and contains a local absolute path.
    // The remote loader accepts an output-relative path, so send only a cloned
    // wire value for this prompt; never rewrite the local render_package.json.
    const remotePackage = remote ? {
      ...renderPackage,
      folder: `martini_shot/${projectIdentity(projectId).slug}/${path.relative(projectIdentity(projectId).projectPath, folder).split(path.sep).join("/")}`,
    } : renderPackage;
    const values = {
      render_package: remotePackage, loader_mode: mode, clip_index: clip.clip_index, noise_seed: seed,
      aspect_ratio: direction?.aspectRatio ?? "4:3", render_megapixels: direction?.renderMegapixels ?? 1,
      // steps come from the project's current Direction, not the package, so a change applies to the next clip
      render_steps: renderSteps(projectId),
    };
    let outputs: unknown;
    let cleanup: CleanupEvidence | null = null;
    let cleanupFailed = false;
    try {
      const run = await runWorkflowTemplate(development, "05-render-next-clip.json", values, projectId, undefined, {
        endpoint: remote ? worker!.endpoint : undefined,
        jobId, waitWhileQueued: true, clientId: previewClientId,
        onPreview: previewClientId ? (frame) => notifyPreviewFrame({ projectId, clipIndex: clip.clip_index, ...frame }) : undefined,
        onSubmitted: (promptId) => {
          update("render_attempts", attemptId, { prompt_id: promptId, status: "running", submitted_at: now() });
          addReport(projectId, "render_clip", `Clip ${clip.clip_index}: workflow queued in ComfyUI (${mode}, attempt ${attemptNumber}).`, { attemptId, promptId });
          notify(projectId);
        },
        onProgress: (progress) => {
          if (progress.phase === "cleanup") update("render_attempts", attemptId, { status: "cleanup" });
          phase(progress.phase);
          if (progress.step) step(progress.step);
        },
        onCleanup: recordCleanup,
      });
      outputs = run.outputs;
      cleanup = run.cleanup;
    } catch (error) {
      if (error instanceof ComfyWorkflowError) {
        loaderReport = previewText(error.outputs, "clip_report");
        cleanup = error.cleanup;
        if (!error.completed) throw error;
        // Rendered, but /free could not be confirmed: keep the clip, stop the queue.
        outputs = error.outputs;
        cleanupFailed = true;
      } else throw error;
    }

    loaderReport = previewText(outputs, "clip_report");
    const loader = parseLoaderReport(loaderReport);
    const saved = savedVideo(outputs, "save");
    if (!saved) throw new Error("ComfyUI finished, but Save Video reported no file.");
    let output: string;
    if (worker) {
      const remoteOutput = remoteOutputPath(projectIdentity(projectId).slug, projectIdentity(projectId).projectPath, folder, saved.subfolder, saved.filename);
      const stat = await worker.stat(remoteOutput.remote);
      if (!stat.exists || stat.type !== "file" || !stat.size) throw new Error("Remote SaveVideo output is missing or invalid.");
      await worker.download(remoteOutput.remote, remoteOutput.local);
      output = remoteOutput.local;
    } else {
      const outputDir = (await getMachineSettings()).comfyOutputDir;
      output = path.resolve(outputDir, saved.subfolder, saved.filename);
      if (!existsSync(output)) throw new Error(`ComfyUI saved ${saved.subfolder}/${saved.filename}, but it is not under the output folder in Settings (${outputDir}).`);
      if (!isInside(folder, output)) throw new Error(`ComfyUI saved the clip outside the package folder: ${output}.`);
    }
    if (!findVideo(await readFolder(folder), clip.video_name)) throw new Error("Downloaded clip did not pass local video validation.");
    const renderedIndex = loader?.clip ?? clip.clip_index;
    const at = now();
    update("render_attempts", attemptId, {
      status: "complete", output_path: output, loader_report: loaderReport, rendered_at: at, finished_at: at,
      error: renderedIndex !== clip.clip_index ? `ComfyUI's loader picked clip ${renderedIndex} instead of clip ${clip.clip_index}.` : null,
    });
    const target = renderedIndex === clip.clip_index ? clip : clipRows(packageRunId).find((row) => row.clip_index === renderedIndex) ?? clip;
    update("render_clips", target.id, { status: "rendered", output_path: output, error: null, rendered_at: at, updated_at: at, last_attempt_id: attemptId });
    if (target.id !== clip.id) update("render_clips", clip.id, { status: "pending", updated_at: at });
    addReport(projectId, "render_clip", `Clip ${renderedIndex} rendered: ${output}`, { attemptId, loaderReport, seed });
    addReport(projectId, "render_cleanup", `Clip ${renderedIndex}: ${cleanupText(cleanup) ?? "cleanup not reported"}`, cleanup);
    if (cleanupFailed) {
      return { ok: true, continue: false, message: `Clip ${renderedIndex} rendered, but ComfyUI cleanup could not be confirmed (${cleanup?.error ?? "unknown"}). Automatic continuation stopped; queue the remaining clips when ComfyUI is responsive.` };
    }
    return { ok: true, continue: true, message: "" };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = readableProductionError(raw, endpoint);
    const cleanup = error instanceof ComfyWorkflowError ? error.cleanup : null;
    const at = now();
    update("render_attempts", attemptId, { status: "failed", error: message, loader_report: loaderReport, finished_at: at });
    update("render_clips", clip.id, { status: "failed", error: message, updated_at: at });
    addReport(projectId, "render_clip_error", `Clip ${clip.clip_index} failed (attempt ${attemptNumber}): ${message}`, { attemptId, loaderReport, raw });
    if (cleanup) addReport(projectId, "render_cleanup", `Clip ${clip.clip_index}: ${cleanupText(cleanup)}`, cleanup);
    return { ok: false, continue: false, message: `Clip ${clip.clip_index} failed, so the queue stopped. Its diagnostics are kept; use Retry clip ${clip.clip_index} when ready.` };
  } finally {
    if (previewClientId) notifyPreview(null);
    attemptPhase.delete(attemptId);
    attemptStep.delete(attemptId);
    notify(projectId);
  }
}

// ----- Clip detail -----------------------------------------------------------------------------------------

export async function clipDetail(projectId: unknown, clipIndex: unknown): Promise<ClipDetail> {
  const index = validateClipIndex(clipIndex);
  const project = getProject(projectId);
  const pkgRow = currentPackageRow(project.id);
  const pkg = pkgRow ? toPackage(pkgRow) : null;
  if (!pkgRow || !pkg) throw new Error("There is no prompt package yet.");
  const row = clipRows(pkgRow.id).find((item) => item.clip_index === index);
  if (!row) throw new Error(`Clip ${index} is not in this prompt package.`);
  const stored = parseJson<StoredPackage>(pkgRow.plan_json);
  const notes = stored?.clipNotes[String(index)] ?? [];
  const plans = await planOverview(project.id);
  const locations = await locationsOverview(project.id);
  const attempts = (db().prepare("SELECT * FROM render_attempts WHERE package_run_id = ? AND clip_index = ? ORDER BY started_at DESC").all(pkgRow.id, index) as AttemptRow[]).map(toAttempt);
  const meta = parseJson<ClipMetaExtra>(row.meta) ?? {};

  const decisions: DecisionRow[] = [];
  if (plans.planRun) {
    const cache = CACHE_TEXT[plans.planRun.cacheResult ?? "unknown"] ?? CACHE_TEXT.unknown;
    decisions.push({ label: "Plan cache", value: cache.text, tone: cache.tone, at: plans.planRun.completedAt });
  }
  decisions.push(locationEvidence(row, plans.planRun?.report ?? "", locations));
  decisions.push(row.outfit
    ? { label: "Outfit selection", value: `${row.outfit}${meta.sectionLabel ? ` (section ${row.section_number})` : ""}`, tone: "ok", at: pkg.writtenAt }
    : { label: "Outfit selection", value: meta.matched === false ? "Not matched to a production shot" : "No outfit reference for this shot", tone: "none", at: null });
  decisions.push({ label: "Candidate selection", value: "Not part of this production path — Build Production Plan uses the story plan's actions directly", tone: "none", at: null });
  decisions.push({ ...actionValidation(notes), at: notes.length ? pkg.writtenAt : null });
  const promptPath = path.join(pkg.folder, row.prompt_file);
  let prompt: string | null = null;
  if (isInside(pkg.folder, promptPath)) prompt = await fs.readFile(promptPath, "utf-8").catch(() => null);
  const creativeSource = await readCreatives(pkg.folder);
  const creative = creativeSource?.[String(index)];
  const allRows = clipRows(pkgRow.id);
  const chain = clipChain(allRows, index);
  decisions.push(prompt !== null
    ? { label: "Prompt written", value: `${row.prompt_file}${meta.storyDriven ? " — from the story plan's action" : ""}${meta.camera ? ` · camera: ${meta.camera}` : ""}`, tone: "ok", at: pkg.writtenAt }
    : { label: "Prompt written", value: `${row.prompt_file} is missing from the package folder`, tone: "fail", at: null });
  decisions.push({ label: "Continuity", value: continuityFor(row), tone: "info", at: null });
  const last = attempts[0];
  if (last) {
    const renderTone: DecisionRow["tone"] = last.status === "complete" ? "ok" : last.status === "failed" || last.status === "interrupted" ? "fail" : "pending";
    const renderText = last.status === "complete" ? `Completed (attempt ${last.attempt})${last.outputPath ? ` → ${path.basename(last.outputPath)}` : ""}`
      : last.status === "failed" ? `Failed (attempt ${last.attempt}): ${last.error ?? ""}`
        : last.status === "interrupted" ? `Interrupted (attempt ${last.attempt})`
          : last.phase === "running" ? "Rendering in ComfyUI…" : last.phase === "queued" ? "Queued in ComfyUI…" : last.status === "cleanup" ? "Rendered; cleaning up" : "Sending to ComfyUI…";
    decisions.push({ label: "Render", value: renderText, tone: renderTone, at: last.finishedAt ?? last.submittedAt ?? last.startedAt });
    if (last.cleanup !== "not_requested") {
      decisions.push({
        label: "ComfyUI cleanup", value: last.cleanupDetail ?? last.cleanup,
        tone: last.cleanup === "completed" ? "ok" : last.cleanup === "failed" ? "fail" : "pending", at: last.finishedAt,
      });
    }
  } else {
    decisions.push({ label: "Render", value: "Not rendered yet", tone: "none", at: null });
  }
  return {
    index, decisions, prompt, attempts, warnings: notes,
    creativeText: typeof creative?.action === "string" ? creative.action : null,
    creativeRevision: typeof creative?.revision === "number" ? creative.revision : null,
    shot: creative && creativeSource ? shotSettings(creative, refOptions(creativeSource, allRows)) : null,
    followers: chain.followers, continuesFrom: chain.continuesFrom, rerenderWith: chain.rerenderWith,
  };
}

// ----- Clip shot settings ----------------------------------------------------------------------------------

const SWAP_ROLES: ClipRefRole[] = ["person", "outfit", "location"];
const text = (value: unknown): string => (typeof value === "string" ? value : "");

async function readCreatives(folder: string): Promise<Record<string, CreativeRecord> | null> {
  return fs.readFile(path.join(folder, "clip_creatives.json"), "utf-8")
    .then((source) => parseJson<Record<string, CreativeRecord>>(source))
    .catch(() => null);
}

const joined = (transition: string | null) => transition === "Continue" || transition === "New angle";

/** Which clips a change to this clip touches: the clips that continue it without a hard cut (they share its outfit,
 *  performer, and place), the clip it continues from, and the clips whose videos must render again. */
export function clipChain(rows: ClipRow[], index: number): { followers: number[]; continuesFrom: number | null; rerenderWith: number[] } {
  const ordered = [...rows].sort((a, b) => a.clip_index - b.clip_index);
  const position = ordered.findIndex((row) => row.clip_index === index);
  const followers: number[] = [];
  for (let next = position + 1; position >= 0 && next < ordered.length && joined(ordered[next].transition); next++) followers.push(ordered[next].clip_index);
  const continuesFrom = position > 0 && joined(ordered[position].transition) ? ordered[position - 1].clip_index : null;
  const rerenderWith = withContinuations([index], ordered.map((row) => ({ index: row.clip_index, transition: row.transition ?? "", overlapFrames: row.overlap_frames }))).clips;
  return { followers, continuesFrom, rerenderWith };
}

/** The performer, outfit, and location images already in this package, named from the production plan where it can. */
function refOptions(creatives: Record<string, CreativeRecord>, rows: ClipRow[]): ClipRefOption[] {
  const byIndex = new Map(rows.map((row) => [row.clip_index, row]));
  const options = new Map<string, ClipRefOption>();
  const counts: Record<ClipRefRole, number> = { person: 0, outfit: 0, location: 0 };
  const fallback: Record<ClipRefRole, string> = { person: "Performer", outfit: "Outfit", location: "Location" };
  for (const [key, record] of Object.entries(creatives).sort(([a], [b]) => Number(a) - Number(b))) {
    const row = byIndex.get(Number(key));
    const meta = parseJson<ClipMetaExtra>(row?.meta) ?? {};
    for (const ref of record.refs ?? []) {
      const role = ref.role as ClipRefRole;
      const file = text(ref.file);
      if (!SWAP_ROLES.includes(role) || !file) continue;
      const named = role === "outfit" ? row?.outfit : role === "location" ? row?.location : meta.subject;
      const id = `${role}:${file}`;
      const existing = options.get(id);
      if (existing) {
        if (!existing.name && named) existing.name = named;
        continue;
      }
      options.set(id, { role, file, name: named ?? "", ...(role === "location" ? { locationText: text(record.location_text) } : {}) });
    }
  }
  const list = [...options.values()];
  for (const option of list) if (!option.name) option.name = `${fallback[option.role]} ${++counts[option.role]}`;
  // Two images under one name (e.g. the same outfit name for different pictures) stay distinguishable.
  for (const option of list) {
    const twins = list.filter((other) => other.role === option.role && other.name === option.name);
    if (twins.length > 1) twins.forEach((twin, position) => { twin.name = `${twin.name} (${position + 1})`; });
  }
  return list;
}

function shotSettings(record: CreativeRecord, options: ClipRefOption[]): ClipShotSettings {
  const scene = (text(record.scene) || "") as ClipMode;
  const named = text(record.camera_name);
  const camera = (named === "Continue" || (CLIP_CAMERAS as readonly string[]).includes(named) ? named : record.ask_camera ? "LLM picks (experimental)" : "Custom") as ClipShotSettings["camera"];
  const refs: ClipShotSettings["refs"] = {};
  for (const ref of record.refs ?? []) {
    const role = ref.role as ClipRefRole;
    if (SWAP_ROLES.includes(role) && text(ref.file)) refs[role] = text(ref.file);
  }
  const lipSync = Boolean(text(record.lip_sync_text));
  return {
    scene, camera, cameraText: text(record.camera_sentence), soundscape: text(record.soundscape),
    soundscapeEditable: scene !== "Dance" || Boolean(record.soundscape_locked),
    lipSync, lipSyncAvailable: scene !== "B-roll" && (lipSync || Boolean(text(record.lip_sync_saved) || text(record.lip_sync_option))),
    ending: text(record.parsed?.ending), endingOverridden: Boolean(text(record.ending_override)), locationText: text(record.location_text),
    refs, options: options.filter((option) => option.role in refs),
  };
}

type ProjectPlace = { slug: string; projectPath: string };

/** The package folder as the ComfyUI that runs a workflow sees it: the local path, or the remote worker's
 *  output-relative mirror (martini_shot/<slug>/...), which runWorkflowTemplate stages before it runs. */
async function comfyFolder(project: ProjectPlace, folder: string): Promise<string> {
  if ((await getMachineSettings()).executionDestination !== "remote") return folder;
  return `martini_shot/${remotePackageRoot(project.slug, folder, project.projectPath)}`;
}

const videoOf = (row: ClipRow) => (name: string) => {
  const lower = name.toLowerCase();
  const base = row.video_name.toLowerCase();
  return lower.endsWith(".mp4") && (lower === `${base}.mp4` || lower.startsWith(`${base}_`));
};

/** Moves the videos of these clips to `archive` and marks them for rendering. Returns how many files moved.
 *  In remote mode the worker's mirror is moved too: it is never deleted by staging, so an old video left there
 *  would be downloaded back by the next workflow and the clip would look rendered again. */
async function supersedeClips(project: ProjectPlace, folder: string, rows: ClipRow[], indexes: number[], archive: string): Promise<number> {
  const chosen = rows.filter((item) => indexes.includes(item.clip_index));
  const machine = await getMachineSettings();
  if (machine.executionDestination === "remote") {
    const worker = new RemoteRenderStaging(machine.remoteComfyUrl, machine.remoteFileApiToken);
    const remoteFolder = remotePackageRoot(project.slug, folder, project.projectPath);
    const remoteArchive = remotePackageRoot(project.slug, archive, project.projectPath);
    const listing = (await worker.stat(remoteFolder)).exists ? await worker.list(remoteFolder) : [];
    for (const row of chosen) {
      for (const entry of listing.filter((item) => item.type === "file" && videoOf(row)(item.name))) {
        await worker.move(`${remoteFolder}/${entry.name}`, `${remoteArchive}/${entry.name}`);
      }
    }
  }
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  let moved = 0;
  for (const row of chosen) {
    for (const name of names.filter(videoOf(row))) {
      await fs.mkdir(archive, { recursive: true });
      await fs.rename(path.join(folder, name), path.join(archive, name));
      moved += 1;
    }
    update("render_clips", row.id, { status: "pending", output_path: null, error: null, rendered_at: null, updated_at: now() });
  }
  return moved;
}

const REVISION_MODES: ClipRevisionMode[] = ["Try another take", "Apply manual direction", "Apply shot settings"];
const CLIP_SCENES: ClipMode[] = ["Dance", "Performance", "Freeform", "B-roll"];

/** Checks the renderer's changes and turns them into the revision node's JSON (snake_case keys). */
function revisionChanges(raw: unknown, shot: ClipShotSettings | null): { node: Record<string, unknown>; changes: ClipChanges; swaps: boolean } {
  if (raw === undefined || raw === null) return { node: {}, changes: {}, swaps: false };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Shot changes must be an object.");
  const value = raw as Record<string, unknown>;
  const changes: ClipChanges = {};
  const node: Record<string, unknown> = {};
  const optionalText = (key: keyof ClipChanges): string | undefined => {
    if (value[key] === undefined) return undefined;
    if (typeof value[key] !== "string" || (value[key] as string).length > 4000) throw new Error(`${key} must be text of at most 4000 characters.`);
    return value[key] as string;
  };
  if (value.scene !== undefined) {
    if (!CLIP_SCENES.includes(value.scene as ClipMode)) throw new Error("Unknown scene type.");
    changes.scene = node.scene = value.scene as ClipMode;
  }
  if (value.camera !== undefined) {
    const camera = value.camera as { name?: unknown; text?: unknown } | null;
    if (!camera || !(CLIP_CAMERAS as readonly string[]).includes(camera.name as string)) throw new Error("Unknown camera choice.");
    if (camera.text !== undefined && (typeof camera.text !== "string" || camera.text.length > 1000)) throw new Error("The custom camera must be text of at most 1000 characters.");
    changes.camera = node.camera = { name: camera.name as ClipCamera, text: camera.text as string | undefined };
  }
  const soundscape = optionalText("soundscape");
  if (soundscape !== undefined) changes.soundscape = node.soundscape = soundscape;
  const ending = optionalText("ending");
  if (ending !== undefined) changes.ending = node.ending = ending;
  if (value.lipSync !== undefined) {
    if (typeof value.lipSync !== "boolean") throw new Error("lipSync must be true or false.");
    changes.lipSync = node.lip_sync = value.lipSync;
  }
  let locationText = optionalText("locationText");
  let swaps = false;
  if (value.refs !== undefined) {
    if (!value.refs || typeof value.refs !== "object" || Array.isArray(value.refs)) throw new Error("refs must be an object.");
    const refs: Partial<Record<ClipRefRole, string>> = {};
    for (const [role, file] of Object.entries(value.refs as Record<string, unknown>)) {
      const option = shot?.options.find((item) => item.role === role && item.file === file);
      if (!option) throw new Error(`${String(file)} is not a ${role} image in this prompt package.`);
      if (shot?.refs[option.role] === file) continue;
      refs[option.role] = option.file;
      // a different location brings its own description unless the user wrote one
      if (option.role === "location" && locationText === undefined && option.locationText !== undefined) locationText = option.locationText;
    }
    if (Object.keys(refs).length) { changes.refs = node.refs = refs; swaps = true; }
  }
  if (locationText !== undefined) { changes.locationText = node.location_text = locationText; swaps = true; }
  return { node, changes, swaps };
}

/** Changes one clip through ComfyUI: a new LLM take (with an optional note), a hand-written direction, or shot settings
 * without the LLM. The story and package stay in place. A reference swap is carried into the clips that continue this one,
 * which the renderer must confirm. The changed clips, and those that reuse their frames, are marked for re-render. */
export async function reviseClipPrompt(projectId: unknown, clipIndex: unknown, request: unknown): Promise<ProduceOverview> {
  const project = projectIdentity(projectId);
  const index = validateClipIndex(clipIndex);
  const value = (request && typeof request === "object" ? request : {}) as Partial<ClipRevisionRequest>;
  const mode = value.mode as ClipRevisionMode;
  if (!REVISION_MODES.includes(mode)) throw new Error("Choose Try another take, Apply manual direction, or Apply shot settings.");
  const creativeText = typeof value.creativeText === "string" ? value.creativeText : "";
  if (creativeText.length > 8000) throw new Error("The direction is too long (at most 8000 characters).");
  if (mode === "Apply manual direction" && !creativeText.trim()) throw new Error("Enter a replacement creative direction first.");
  const release = claimProduction("package", project.id);
  try {
    const overview = await produceOverview(project.id);
    const pkgRow = currentPackageRow(project.id);
    const pkg = overview.package;
    if (!pkgRow || !pkg) throw new Error("There is no prompt package yet.");
    if (overview.packageStale.length) throw new Error("The director plan changed after this package. Write a new prompt package before revising one of its clips.");
    const settings = parseJson<PackageSettings>(pkgRow.settings);
    if (mode === "Try another take" && !settings?.directorLlm) throw new Error("This prompt package does not record its local director LLM. Write a fresh prompt package first.");
    const comfy = await comfyStatus();
    if (!comfy.connected) throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI and wait for it to finish loading.`);
    const rows = await syncClipsWithDisk(pkgRow.id, pkg.folder);
    const row = rows.find((item) => item.clip_index === index);
    if (!row) throw new Error(`Clip ${index} is not in this prompt package.`);
    const creatives = await readCreatives(pkg.folder);
    const record = creatives?.[String(index)];
    const shot = record && creatives ? shotSettings(record, refOptions(creatives, rows)) : null;
    const { node, changes, swaps } = revisionChanges(value.changes, shot);
    if (Object.keys(node).length && !shot) throw new Error("This older prompt package has no editable clip source. Write a fresh prompt package first.");
    const chain = clipChain(rows, index);
    const carried = swaps ? chain.followers : [];
    if (carried.length && value.confirmDownstream !== true) {
      throw new Error(`This change carries into clip${carried.length === 1 ? "" : "s"} ${formatRanges(carried)}, which continue this shot. Confirm it first.`);
    }
    if (carried.length) node.propagate = carried;

    const take = mode === "Try another take";
    const packageFolder = await comfyFolder(project, pkg.folder);
    const run = await serializeComfyWork(() => runWorkflowTemplate(development, take ? "04b-revise-clip-prompt.json" : "04c-apply-clip-settings.json", {
      package_folder: packageFolder, clip_index: index, revision_mode: mode, creative_text: creativeText, changes: JSON.stringify(node),
      seed: settings?.seed ?? 0, ...(take ? { director_llm: settings!.directorLlm } : {}),
    }, project.id));
    const report = previewText(run.outputs, "revision_report") ?? "Clip prompt revised.";

    // keep the clip table in step with the package: names shown on Produce and Results
    const option = (role: ClipRefRole) => (changes.refs?.[role] ? shot?.options.find((item) => item.role === role && item.file === changes.refs![role]) : undefined);
    for (const target of rows.filter((item) => item.clip_index === index || carried.includes(item.clip_index))) {
      const fields: Record<string, unknown> = {};
      const meta = parseJson<ClipMetaExtra>(target.meta) ?? {};
      if (option("outfit")) fields.outfit = option("outfit")!.name;
      if (option("location")) fields.location = option("location")!.name;
      if (option("person")) meta.subject = option("person")!.name;
      if (target.clip_index === index && changes.scene) fields.scene = changes.scene;
      if (target.clip_index === index && changes.camera) meta.camera = changes.camera.name === "Custom" ? changes.camera.text || "Custom" : changes.camera.name;
      if (option("person") || (target.clip_index === index && changes.camera)) fields.meta = JSON.stringify(meta);
      if (Object.keys(fields).length) update("render_clips", target.id, { ...fields, updated_at: now() });
    }

    const changed = withContinuations([index, ...carried], rows.map((item) => ({ index: item.clip_index, transition: item.transition ?? "", overlapFrames: item.overlap_frames })));
    const archive = path.join(pkg.folder, "superseded", `prompt-revision-${archiveStamp(now())}`);
    const moved = await supersedeClips(project, pkg.folder, rows, changed.clips, archive);
    db().prepare("UPDATE martini_projects SET status = 'prompt_package_ready', updated_at = ? WHERE id = ?").run(now(), project.id);
    addReport(project.id, "clip_prompt_revision", `${report}\nClip${changed.clips.length === 1 ? "" : "s"} ${formatRanges(changed.clips)} now need rendering.`
      + (changed.added.length ? ` ${formatRanges(changed.added)} added for motion continuity.` : "")
      + (moved ? ` ${moved} earlier video file${moved === 1 ? " was" : "s were"} moved to ${archive}.` : ""),
    { clip: index, mode, changes, carried, dependentClips: changed.added, archive: moved ? archive : null, report });
    return produceOverview(project.id);
  } finally {
    release();
    notify(project.id);
  }
}

/** Renders a finished clip again with a new noise seed and the same prompt. Its video, and those of the clips that reuse
 * its frames, move to the package's superseded folder first. */
export async function rerenderClip(projectId: unknown, clipIndex: unknown): Promise<ProduceOverview> {
  const project = projectIdentity(projectId);
  const index = validateClipIndex(clipIndex);
  let chosen: number[];
  let othersPending: boolean;
  const release = claimProduction("render", project.id);
  try {
    const overview = await produceOverview(project.id);
    const pkgRow = currentPackageRow(project.id);
    const pkg = overview.package;
    if (!pkgRow || !pkg) throw new Error("There is no prompt package to re-render.");
    if (overview.packageStale.length) throw new Error(`${overview.packageStale.join(" ")} Write a new prompt package before re-rendering.`);
    if (overview.latestPackageRun?.status === "queued" || overview.latestPackageRun?.status === "running") throw new Error("A prompt package is being written.");
    const rows = await syncClipsWithDisk(pkgRow.id, pkg.folder);
    const row = rows.find((item) => item.clip_index === index);
    if (!row) throw new Error(`Clip ${index} is not in this prompt package.`);
    if (row.status !== "rendered") throw new Error(`Clip ${index} has no video yet; use Render clip ${index} instead.`);
    chosen = clipChain(rows, index).rerenderWith;
    othersPending = rows.some((item) => item.status !== "rendered" && !chosen.includes(item.clip_index));
    const archive = path.join(pkg.folder, "superseded", `rerender-${archiveStamp(now())}`);
    if (!isInside(project.projectPath, archive)) throw new Error("The package folder is outside the project folder.");
    const moved = await supersedeClips(project, pkg.folder, rows, chosen, archive);
    db().prepare("UPDATE martini_projects SET status = 'prompt_package_ready', updated_at = ? WHERE id = ?").run(now(), project.id);
    addReport(project.id, "rerender", `Re-render clip ${index} with a new seed`
      + (chosen.length > 1 ? ` (clip${chosen.length === 2 ? "" : "s"} ${formatRanges(chosen.filter((item) => item !== index))} reuse its frames and render again too)` : "")
      + `. ${moved} earlier video file${moved === 1 ? "" : "s"} moved to ${archive}. The prompt was not changed.`, { clips: chosen, archive, moved });
  } finally {
    release();
  }
  notify(project.id);
  // With nothing else waiting, render the whole chain in order; otherwise only this clip, so unrelated clips don't start.
  return othersPending ? queueSpecificClip(project.id, index) : queueRemaining(project.id);
}

function locationEvidence(row: ClipRow, planReport: string, locations: Awaited<ReturnType<typeof locationsOverview>>): DecisionRow {
  const name = row.location ?? "";
  if (!name) return { label: "Location evidence", value: "No location named for this shot", tone: "none", at: null };
  const key = name.toLowerCase();
  const requested = locations.requested.find((item) => item.name.toLowerCase() === key);
  if (requested) {
    return { label: "Location evidence", value: `${name} — ${requested.modeLabel}${requested.candidates[0] ? ` (${requested.candidates[0].fileName})` : ""}`, tone: requested.passedToMiniMax ? "ok" : "warn", at: requested.checkedAt };
  }
  const supplied = locations.supplied.find((item) => item.name.toLowerCase() === key);
  if (supplied) {
    const observed = reportBlock(planReport, "Location observations:").map((line) => line.trim()).find((line) => line.toLowerCase().startsWith(`${key}:`));
    return { label: "Location evidence", value: `${name} — supplied, image-backed${observed ? ` · ${observed.slice(name.length + 1).trim()}` : ""}`, tone: supplied.available ? "ok" : "fail", at: null };
  }
  if (row.scene === "B-roll") return { label: "Location evidence", value: `${name} — text-only B-roll (allowed)`, tone: "info", at: null };
  return { label: "Location evidence", value: `${name} — text-only`, tone: "warn", at: null };
}

/** The package folder (only this folder is ever opened). */
export function packageFolderFor(projectId: unknown): string {
  const project = getProject(projectId);
  const pkgRow = currentPackageRow(project.id);
  const pkg = pkgRow ? toPackage(pkgRow) : null;
  if (!pkg) throw new Error("There is no prompt package yet.");
  if (!isInside(project.projectPath, pkg.folder)) throw new Error("The package folder is outside the project folder.");
  return pkg.folder;
}

/** A rendered clip's output path, for Copy path. Only clips of the current package. */
export function clipOutputPath(projectId: unknown, clipIndex: unknown): string {
  const index = validateClipIndex(clipIndex);
  const project = getProject(projectId);
  const pkgRow = currentPackageRow(project.id);
  const row = pkgRow ? clipRows(pkgRow.id).find((item) => item.clip_index === index) : null;
  if (!row?.output_path) throw new Error(`Clip ${index} has no rendered file yet.`);
  return row.output_path;
}

// ----- Re-render unchanged plan (Ticket 06, started from Results) -----------------------------------------------

/** Re-renders all or chosen clips of the current prompt package without touching the story, director plan, location choices, or
 *  prompts. The chosen clips' current videos are moved (never deleted) to <package>\superseded\<time>\ so Load Render Clip's
 *  Next missing mode renders them again; clips that continue from a chosen clip are included so continuity holds. Final videos
 *  in the package folder are not touched. Then the normal Produce queue starts for exactly those clips. */
export async function rerenderUnchanged(projectId: unknown, request: unknown): Promise<RerenderResult> {
  const project = projectIdentity(projectId);
  const scope = (request as { scope?: unknown } | null)?.scope;
  if (scope !== "all" && scope !== "clips") throw new Error("Choose all clips or enter clip numbers.");
  let release = claimProduction("render", project.id);
  let chosen: { clips: number[]; added: number[] };
  let archive: string;
  try {
    const overview = await produceOverview(project.id);
    const pkgRow = currentPackageRow(project.id);
    const pkg = overview.package;
    if (!pkgRow || !pkg) throw new Error("There is no prompt package to re-render.");
    if (overview.packageStale.length) throw new Error(`${overview.packageStale.join(" ")} Re-rendering would not use the unchanged plan; write a new prompt package on Produce instead.`);
    if (overview.latestPackageRun?.status === "queued" || overview.latestPackageRun?.status === "running") throw new Error("A prompt package is being written.");
    const comfy = await comfyStatus();
    if (!comfy.connected) throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI and wait for it to finish loading; nothing was changed.`);
    const rows = await syncClipsWithDisk(pkgRow.id, pkg.folder);
    const selected = scope === "all" ? rows.map((row) => row.clip_index) : parseClipSelection((request as { clips?: unknown }).clips, rows.length);
    chosen = withContinuations(selected, rows.map((row) => ({ index: row.clip_index, transition: row.transition ?? "", overlapFrames: row.overlap_frames })));
    archive = path.join(pkg.folder, "superseded", archiveStamp(now()));
    if (!isInside(project.projectPath, archive)) throw new Error("The package folder is outside the project folder.");
    const moved = await supersedeClips(project, pkg.folder, rows, chosen.clips, archive);
    db().prepare("UPDATE martini_projects SET status = 'prompt_package_ready', updated_at = ? WHERE id = ?").run(now(), project.id);
    addReport(project.id, "rerender", `Re-render unchanged plan: clip${chosen.clips.length === 1 ? "" : "s"} ${formatRanges(chosen.clips)}`
      + (chosen.added.length ? ` (${formatRanges(chosen.added)} added because they continue from a re-rendered clip)` : "")
      + `. ${moved} earlier video file${moved === 1 ? "" : "s"} moved to ${archive}. The story, director plan, location choices, and prompt package were kept; finished final videos were not touched.`,
    { clips: chosen.clips, added: chosen.added, archive, moved });
  } finally {
    release();
    release = () => undefined;
  }
  notify(project.id);
  // The existing Produce queue renders exactly the clips that are now missing, one ComfyUI job at a time.
  let queueError: string | null = null;
  try { await queueRemaining(project.id); } catch (error) { queueError = error instanceof Error ? error.message : String(error); }
  return { produce: await produceOverview(project.id), clips: chosen.clips, addedForContinuity: chosen.added, archivedTo: archive, queueError };
}
