// Final stitch, results, and the autonomous-director report (Ticket 06), owned by Electron main. The renderer reaches it only
// through typed IPC.
//  - Stitch final video runs workflows/06-stitch-video.json once (Open Project -> Project Status, and Finalize Video on the saved
//    render_package.json). It is submitted only after Martini Shot has confirmed every clip of the current package is rendered,
//    because Finalize Video would otherwise make a partial "test stitch". runWorkflowTemplate sends POST /free afterwards.
//  - Every attempt is a final_results row. Later plans, packages, and re-renders never change earlier rows, and Finalize Video
//    never overwrites a file (final.mp4, final_2.mp4, …), so earlier videos and their reports stay available.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { CleanupState, DirectorReport, FinalVideo, ResultsOutcome, ResultsOverview, StitchStatus, TestBatch, TestVideo } from "./contracts";
import {
  ComfyWorkflowError, comfyHistory, comfyQueueIds, comfyStatus, freeComfyMemory, runWorkflowTemplate, serializeComfyWork,
  type CleanupEvidence, type WorkflowProgress,
} from "./comfy-client";
import { db, getMachineSettings } from "./db";
import { remoteRenderPackage, remoteReportedPath } from "./remote-render-staging";
import { stitchSelection, type StitchSelection } from "./postprocess-service";
import { locationsOverview } from "./location-service";
import { previewText, surrealSetting } from "./plan-rules";
import { planOverview, planRunById } from "./plan-service";
import { claimProduction, productionBusy } from "./production-lock";
import { parseManifest, readableProductionError } from "./production-rules";
import {
  attemptRows, cleanupText, currentPackageRow, packageRow, syncClipsWithDisk, toPackage, type ClipRow, type PackageRow, type PackageSettings,
  type StoredPackage,
} from "./production-service";
import { getProject, projectIdentity } from "./project-service";
import { isInside } from "./project-rules";
import {
  buildDirectorReport, clipsChangedSince, finalState, mp4Duration, nextTestBatch, outcomeFor, parseFinalizeReport, reportFileName, stitchBlockers, testRuns,
  requiredEventStatuses, stitchWorkflowValues, summarizeClips, type ReportInput, type RequiredEventStatus, type SummaryClip,
} from "./results-rules";

type FinalRow = {
  id: string; project_id: string; package_run_id: string; plan_run_id: string | null; status: StitchStatus; comfy_job_id: string | null;
  prompt_id: string | null; video_path: string | null; output_folder: string | null; file_size: number | null; duration_seconds: number | null;
  video_info: string | null; stitch_report: string | null; project_status: string | null; clip_summary: string | null; cleanup_status: CleanupState;
  cleanup: string | null; report_data: string | null; report_body: string | null; report_path: string | null; error: string | null;
  started_at: string; submitted_at: string | null; completed_at: string | null; clip_selection?: string | null;
};
type StoredSummary = ReturnType<typeof summarizeClips>;
type StoredReport = { report: DirectorReport; outcome: ResultsOutcome | null };

const now = () => new Date().toISOString();
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

let development = false;
let notify: (projectId: string) => void = () => undefined;
const activity = new Map<string, NonNullable<FinalVideo["activity"]>>();

export function configureResultsService(options: { isDevelopment: boolean; onChange(projectId: string): void }): void {
  development = options.isDevelopment;
  notify = options.onChange;
  // Nothing is watching a stitch that was running when the app closed. Stitch final video checks ComfyUI's history for it first.
  db().prepare(`UPDATE final_results SET status = 'interrupted', completed_at = ?,
    error = 'Martini Shot was closed while this video was being stitched. ComfyUI may still have finished it; Stitch final video checks for that before submitting anything new.'
    WHERE status IN ('queued', 'running')`).run(now());
  db().prepare(`UPDATE test_stitches SET status = 'interrupted', completed_at = ?,
    error = 'Martini Shot was closed while these test videos were being stitched. Any test files ComfyUI finished are in the package folder; stitch a new batch to record them.'
    WHERE status IN ('queued', 'running')`).run(now());
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function update(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (keys.length) db().prepare(`UPDATE final_results SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => fields[key]) as never[], id);
}

function addReport(projectId: string, category: string, body: string, data?: unknown, runId?: string): void {
  db().prepare("INSERT INTO project_reports (id, project_id, category, body, data, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), projectId, category, body, data === undefined ? null : JSON.stringify(data), runId ?? null, now());
}

function finalRows(projectId: string): FinalRow[] {
  return db().prepare("SELECT * FROM final_results WHERE project_id = ? ORDER BY started_at DESC").all(projectId) as FinalRow[];
}

function finalRow(projectId: unknown, finalId: unknown): FinalRow {
  const project = projectIdentity(projectId);
  if (typeof finalId !== "string" || !/^[0-9a-f-]{36}$/i.test(finalId)) throw new Error("Unknown final video.");
  const row = db().prepare("SELECT * FROM final_results WHERE id = ? AND project_id = ?").get(finalId, project.id) as FinalRow | undefined;
  if (!row) throw new Error("That final video is not recorded for this project.");
  return row;
}

/** The recorded final video file, only when it is an existing .mp4 inside the project folder. */
function verifiedVideo(row: FinalRow, projectPath: string): string | null {
  if (!row.video_path || !row.video_path.toLowerCase().endsWith(".mp4") || !isInside(projectPath, row.video_path)) return null;
  return existsSync(row.video_path) ? path.resolve(row.video_path) : null;
}

/** With a post-processing selection, each clip's output is the file the stitch joins (original or processed), so changing a
 *  selection shows as "clips changed since" the last final video. */
function summaryClips(rows: ClipRow[], selection?: Pick<StitchSelection, "files"> | null): SummaryClip[] {
  const chosen = new Map((selection?.files ?? []).map((file) => [file.index, file.absolute]));
  return rows.map((row) => ({ index: row.clip_index, status: row.status, attempts: row.attempts, outputPath: chosen.get(row.clip_index) ?? row.output_path }));
}

function toFinal(row: FinalRow, projectPath: string, currentPackageId: string | null, currentClips: SummaryClip[]): FinalVideo {
  const video = verifiedVideo(row, projectPath);
  const summary = parseJson<StoredSummary>(row.clip_summary);
  const current = row.package_run_id === currentPackageId;
  return {
    id: row.id, status: row.status, activity: activity.get(row.id) ?? null, packageRunId: row.package_run_id, planRunId: row.plan_run_id,
    packageCurrent: current,
    clipsChangedSince: row.status === "complete" && current ? clipsChangedSince(summary?.outputs, currentClips, samePath) : false,
    videoPath: row.video_path, fileName: row.video_path ? path.basename(row.video_path) : null, outputFolder: row.output_folder, fileExists: Boolean(video),
    fileSizeBytes: row.file_size, durationSeconds: row.duration_seconds, videoInfo: row.video_info,
    videoUrl: video ? `martini-asset://final/${row.id}?v=${row.file_size ?? 0}` : null,
    stitchReport: row.stitch_report, promptId: row.prompt_id, cleanup: row.cleanup_status, cleanupDetail: cleanupText(parseJson<CleanupEvidence>(row.cleanup)),
    clipSummary: summary ? { total: summary.total, rendered: summary.rendered, failed: summary.failed, missing: summary.missing, retried: summary.retried, attempts: summary.attempts } : null,
    reportPath: row.report_path, error: row.error, startedAt: row.started_at, submittedAt: row.submitted_at, completedAt: row.completed_at,
  };
}

// ----- Readiness --------------------------------------------------------------------------------------------

async function readRenderPackage(projectPath: string): Promise<Record<string, unknown> | null> {
  const value = parseJson<Record<string, unknown>>(await fs.readFile(path.join(projectPath, "render_package.json"), "utf-8").catch(() => null));
  return value && typeof value.folder === "string" ? value : null;
}

async function manifestCount(folder: string): Promise<number | null> {
  try { return parseManifest(JSON.parse(await fs.readFile(path.join(folder, "segments.json"), "utf-8"))).segments.length; } catch { return null; }
}

function packageWriting(projectId: string): boolean {
  const row = db().prepare("SELECT status FROM director_runs WHERE project_id = ? AND stage = 'prompt_package' ORDER BY created_at DESC LIMIT 1").get(projectId) as { status: string } | undefined;
  return row?.status === "queued" || row?.status === "running";
}

async function readiness(projectId: string) {
  const project = getProject(projectId);
  const pkgRow = currentPackageRow(project.id);
  const pkg = pkgRow ? toPackage(pkgRow) : null;
  const rows = pkgRow && pkg ? await syncClipsWithDisk(pkgRow.id, pkg.folder) : [];
  const renderPackage = await readRenderPackage(project.projectPath);
  const busy = productionBusy();
  const blockers = stitchBlockers({
    projectFolderExists: project.folderExists, projectPath: project.projectPath,
    pkg: pkg ? { folder: pkg.folder, clipCount: pkg.clipCount } : null,
    renderPackageFolder: renderPackage ? String(renderPackage.folder) : undefined,
    manifestClipCount: pkg ? await manifestCount(pkg.folder) : null, samePath,
    // A stitch in progress is reported as the "stitching" state, not as a blocker.
    busy: busy && !(busy.kind === "stitch" && busy.projectId === project.id) ? { kind: busy.kind, sameProject: busy.projectId === project.id } : null,
    packageWriting: packageWriting(project.id),
    clips: rows.map((row) => ({ index: row.clip_index, status: row.status, error: row.error, attempts: row.attempts })),
  });
  // Enabled post-processing must resolve to a current processed file or an explicit original before anything is joined.
  const selection = pkgRow ? await stitchSelection(project.id) : null;
  if (selection) blockers.push(...selection.unresolved.slice(0, 12), ...(selection.unresolved.length > 12 ? [`…and ${selection.unresolved.length - 12} more clips on Post-processing.`] : []));
  return { project, pkgRow, pkg, rows, renderPackage, blockers, selection };
}

// ----- Report input -----------------------------------------------------------------------------------------

/** Required-event allocation from the package's director_context.json, with prompt coverage read from the current prompt
 *  files (so a revised clip is reflected). null when the package has no readable director context. */
async function packageEvents(folder: string): Promise<RequiredEventStatus[] | null> {
  try {
    const context = JSON.parse(await fs.readFile(path.join(folder, "director_context.json"), "utf-8")) as unknown;
    const segments = parseManifest(JSON.parse(await fs.readFile(path.join(folder, "segments.json"), "utf-8"))).segments;
    const prompts = new Map<number, string>();
    for (const segment of segments) prompts.set(segment.index, await fs.readFile(path.join(folder, segment.promptFile), "utf-8").catch(() => ""));
    return requiredEventStatuses(context, segments, (index) => prompts.get(index) ?? "");
  } catch {
    return null;
  }
}

async function reportInput(projectId: string, pkgRow: PackageRow | null, stitch: FinalRow | null, kind: DirectorReport["kind"]): Promise<ReportInput> {
  const project = getProject(projectId);
  const names = (role: string) => project.assets.filter((asset) => asset.role === role).map((asset) => asset.displayName);
  const song = project.assets.find((asset) => asset.role === "song");
  const plans = await planOverview(project.id);
  const settings = parseJson<PackageSettings>(pkgRow?.settings);
  const planInfo = settings ? planRunById(settings.planRunId) : plans.planRun ? planRunById(plans.planRun.id) : null;
  const stored = parseJson<StoredPackage>(pkgRow?.plan_json);
  const rows = pkgRow ? (db().prepare("SELECT * FROM render_clips WHERE package_run_id = ? ORDER BY clip_index").all(pkgRow.id) as ClipRow[]) : [];
  const run = planInfo?.run ?? null;
  return {
    projectName: project.name, generatedAt: now(), kind, formatWhen,
    inputs: {
      song: song ? { name: song.displayName, durationSeconds: song.durationSeconds ?? planInfo?.plan?.durationSeconds ?? null } : null,
      performers: names("performer"), outfits: names("outfit"), suppliedLocations: names("location"),
    },
    direction: { creativeBrief: planInfo?.inputs?.creativeBrief ?? "", motifWeight: settings?.motifWeight ?? plans.direction.motifWeight },
    planRun: run ? {
      kind: run.kind, cacheResult: run.cacheResult, cacheDetails: run.cacheDetails, seed: run.seedUsed ?? run.seedRequested, directorLlm: run.directorLlm,
      completedAt: run.completedAt, storyChanged: run.storyChanged,
    } : null,
    plan: planInfo?.plan ?? null,
    planIsCurrent: !run || run.id === plans.planRun?.id,
    package: pkgRow && stored ? {
      folder: stored.folder, clipCount: stored.clipCount, shotCount: stored.shotCount, writtenAt: pkgRow.completed_at ?? pkgRow.created_at,
      motifWeight: settings?.motifWeight ?? null, warnings: stored.warnings, polish: stored.polish, resolveReport: stored.reports.resolve,
      surrealMotifs: settings?.direction ? surrealSetting(settings.direction) : null, requiredEvents: await packageEvents(stored.folder),
      isCurrent: currentPackageRow(project.id)?.id === pkgRow.id,
    } : null,
    clipNotes: stored?.clipNotes ?? {},
    clips: rows.map((row) => ({
      index: row.clip_index, section: row.section_number, mode: row.scene ?? "", location: row.location ?? "", outfit: row.outfit ?? "",
      status: row.status, attempts: row.attempts, error: row.error,
    })),
    attempts: pkgRow ? attemptRows(pkgRow.id).map((row) => ({ status: row.status, cleanup: row.cleanup_status })) : [],
    stitch: stitch ? {
      status: stitch.status, videoPath: stitch.video_path, videoInfo: stitch.video_info, stitchReport: stitch.stitch_report, durationSeconds: stitch.duration_seconds,
      fileSizeBytes: stitch.file_size, completedAt: stitch.completed_at, error: stitch.error, cleanup: stitch.cleanup_status,
      cleanupDetail: cleanupText(parseJson<CleanupEvidence>(stitch.cleanup)), promptId: stitch.prompt_id, projectStatus: stitch.project_status,
    } : null,
  };
}

// ----- Overview ---------------------------------------------------------------------------------------------

export async function resultsOverview(projectId: unknown): Promise<ResultsOverview> {
  const ready = await readiness(projectIdentity(projectId).id);
  const { project, pkgRow, pkg, rows, blockers, selection } = ready;
  const comfy = await comfyStatus();
  const plans = await planOverview(project.id);
  const settings = parseJson<PackageSettings>(pkgRow?.settings);
  const current = summaryClips(rows, selection);
  const all = finalRows(project.id);
  const finals = all.map((row) => toFinal(row, project.projectPath, pkgRow?.id ?? null, current));
  const latestIndex = pkgRow ? all.findIndex((row) => row.package_run_id === pkgRow.id) : -1;
  const latestRowForPkg = latestIndex >= 0 ? all[latestIndex] : null;
  const latest = latestIndex >= 0 ? finals[latestIndex] : null;
  const active = latest?.status === "queued" || latest?.status === "running";
  const state = finalState({ active, blockers, latest: latest ? { status: latest.status, fileExists: latest.fileExists, clipsChangedSince: latest.clipsChangedSince } : null });
  const shownIndex = finals.findIndex((final) => final.status === "complete" && final.fileExists);
  const shown = shownIndex >= 0 ? finals[shownIndex] : null;

  const notes: string[] = [];
  const stale = Boolean(pkgRow && settings && settings.planRunId !== plans.planRun?.id);
  if (stale) notes.push("This prompt package was written from an earlier director plan. A stitch uses its clips and tells that earlier story; the report says so.");
  if (latest?.status === "complete" && latest.clipsChangedSince) notes.push(`Clips changed after ${latest.fileName ?? "the last video"} was stitched. Stitch again to include them; the earlier video is kept.`);
  if (latest?.status === "complete" && !latest.fileExists) notes.push(`${latest.videoPath ?? "The recorded final video"} is no longer on disk. Its record and report are kept; stitch again to make a new file.`);
  if (selection?.usesProcessed) notes.push(`Stitching uses post-processed versions of clip${selection.files.filter((file) => file.processed).length === 1 ? "" : "s"} ${selection.files.filter((file) => file.processed).map((file) => file.index).join(", ")} (Post-processing). Mixed sizes are normalized to the largest clip.`);
  if (shown && !shown.packageCurrent) notes.push(`The video shown was made from an earlier prompt package (${shown.fileName}). It stays available below.`);

  const stitchUnavailable = !comfy.connected
    ? `ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI yourself and wait until it has finished loading, then stitch. (${comfy.message})`
    : null;
  const canStitch = (state === "ready" || state === "failed") && !stitchUnavailable;

  // Report: the saved snapshot of the finished video for this package, else a live report of the current package.
  let report: DirectorReport;
  let outcome: ResultsOutcome | null;
  const snapshotRow = state === "complete" ? latestRowForPkg : !pkgRow && shownIndex >= 0 ? all[shownIndex] : null;
  const snapshot = parseJson<StoredReport>(snapshotRow?.report_data);
  if (snapshot) ({ report, outcome } = snapshot);
  else {
    const input = await reportInput(project.id, pkgRow, latestRowForPkg, "live");
    report = buildDirectorReport(input);
    outcome = outcomeFor(input);
  }

  const attention: string[] = [];
  for (const row of rows) if (row.status === "failed" || row.status === "interrupted") attention.push(`Clip ${row.clip_index} ${row.status === "failed" ? "failed" : "was interrupted"}${row.error ? `: ${row.error}` : ""}`);
  if (!stale && pkg) {
    const locations = await locationsOverview(project.id).catch(() => null);
    for (const request of locations?.requested ?? []) if (!request.passedToMiniMax) attention.push(`${request.name}: ${request.modeLabel} — ${request.reason}`);
  }
  if (shown?.cleanup === "failed") attention.push(`ComfyUI cleanup after stitching ${shown.fileName} could not be confirmed: ${shown.cleanupDetail ?? ""}`);
  if (latest?.status === "failed" || latest?.status === "interrupted") attention.push(`The last stitch ${latest.status === "failed" ? "failed" : "was interrupted"}: ${latest.error ?? "no error text"}`);

  const filmstrip: ResultsOverview["filmstrip"] = [];
  if (shown?.packageCurrent) {
    const rendered = rows.filter((row) => row.status === "rendered");
    const picks = rendered.length <= 5 ? rendered : [0, 1, 2, 3, 4].map((i) => rendered[Math.round((i * (rendered.length - 1)) / 4)]);
    for (const row of picks) filmstrip.push({ index: row.clip_index, start: row.song_start, url: `martini-asset://clip/${project.id}/${row.clip_index}?v=${encodeURIComponent(row.rendered_at ?? "")}` });
  }

  const busy = productionBusy();
  let rerenderReason: string | null = null;
  if (!pkg) rerenderReason = "There is no prompt package to re-render.";
  else if (stale) rerenderReason = "The director plan changed after this package was written, so it is no longer the unchanged plan. Write a new prompt package on Produce.";
  else if (busy) rerenderReason = busy.kind === "stitch" ? "The final video is being stitched." : busy.kind === "render" ? "Clips are already rendering." : busy.kind === "postprocess" ? "Clips are being post-processed." : "A prompt package is being written.";
  else if (!comfy.connected) rerenderReason = "ComfyUI is not reachable.";
  let rerollReason: string | null = plans.blockers[0] ?? null;
  if (!plans.plan) rerollReason = "There is no director plan yet. Create one on the Plan page.";

  return {
    projectId: project.id, projectName: project.name, state, blockers, notes, canStitch, stitchUnavailable,
    comfy: { connected: comfy.connected, endpoint: comfy.endpoint, message: comfy.message },
    package: pkgRow && pkg ? { runId: pkgRow.id, folder: pkg.folder, clipCount: pkg.clipCount, writtenAt: pkg.writtenAt, stale } : null,
    counts: {
      total: rows.length, rendered: rows.filter((row) => row.status === "rendered").length,
      failed: rows.filter((row) => row.status === "failed" || row.status === "interrupted").length,
      missing: rows.filter((row) => row.status !== "rendered" && row.status !== "failed" && row.status !== "interrupted").length,
    },
    final: shown, latestAttempt: latest, history: finals, outcome, report, filmstrip, attention,
    rerender: { available: !rerenderReason, reason: rerenderReason, clipCount: rows.length },
    reroll: { available: !rerollReason, reason: rerollReason },
    tests: await testsInfo(ready, comfy.connected),
  };
}

// ----- Stitch -----------------------------------------------------------------------------------------------

function setActivity(finalId: string, projectId: string, phase: NonNullable<FinalVideo["activity"]>["phase"], queuePosition?: number): void {
  const previous = activity.get(finalId);
  if (previous?.phase === phase && previous.queuePosition === queuePosition) return;
  activity.set(finalId, { phase, since: previous?.phase === phase ? previous.since : now(), queuePosition });
  notify(projectId);
}

/** Starts Stitch final video in the background and returns at once. Progress and the result are announced through onChange. */
export async function startStitch(projectId: unknown): Promise<ResultsOverview> {
  const project = projectIdentity(projectId);
  // Claimed before any await: a second click cannot submit a second stitch, and no render or package can start meanwhile.
  const release = claimProduction("stitch", project.id);
  try {
    const overview = await resultsOverview(project.id);
    if (overview.state === "complete") throw new Error(`This package already has a final video made from exactly these clips: ${overview.latestAttempt?.videoPath}. Nothing was submitted.`);
    if (overview.blockers.length) throw new Error(`Nothing was submitted to ComfyUI.\n${overview.blockers.join("\n")}`);
    if (overview.stitchUnavailable) throw new Error(overview.stitchUnavailable);
    const pkgRow = currentPackageRow(project.id)!;
    if (await serializeComfyWork(() => recoverInterrupted(project.id, pkgRow))) {
      release();
      return resultsOverview(project.id);
    }
    const finalId = randomUUID();
    const settings = parseJson<PackageSettings>(pkgRow.settings);
    db().prepare(`INSERT INTO final_results (id, project_id, package_run_id, plan_run_id, status, started_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
      .run(finalId, project.id, pkgRow.id, settings?.planRunId ?? null, now());
    activity.set(finalId, { phase: "waiting", since: now() });
    addReport(project.id, "final_video", "Stitch final video started: every clip is rendered. One ComfyUI workflow (06-stitch-video.json).", { finalId }, finalId);
    void serializeComfyWork(() => executeStitch(finalId, project.id, pkgRow.id, overview.comfy.endpoint))
      .catch(() => undefined)
      .finally(() => { release(); notify(project.id); });
    notify(project.id);
    return resultsOverview(project.id);
  } catch (error) {
    release();
    throw error;
  }
}

/** A stitch that was running when Martini Shot closed: if ComfyUI is still on it, refuse; if it finished, record its video
 *  (after the usual checks) and run the /free cycle that was missed, instead of stitching a duplicate. */
async function recoverInterrupted(projectId: string, pkgRow: PackageRow): Promise<boolean> {
  const rows = (db().prepare("SELECT * FROM final_results WHERE package_run_id = ? AND status = 'interrupted' AND prompt_id IS NOT NULL ORDER BY started_at DESC").all(pkgRow.id) as FinalRow[]);
  if (!rows.length) return false;
  const queue = await comfyQueueIds();
  if (rows.some((row) => queue.running.includes(row.prompt_id!) || queue.pending.includes(row.prompt_id!))) {
    throw new Error("ComfyUI is still stitching a video that started before Martini Shot was closed. Wait for it to finish, then try again.");
  }
  let recovered = false;
  let ranInComfy = false;
  for (const row of rows) {
    const history = await comfyHistory(row.prompt_id!);
    if (history) ranInComfy = true;
    if (history?.status !== "success") {
      update(row.id, { prompt_id: null });
      continue;
    }
    try {
      await recordVideo(row.id, projectId, pkgRow, history.outputs, new Set(), parseJson<Pick<StitchSelection, "files">>(row.clip_selection ?? null));
      update(row.id, { error: "Finished in ComfyUI while Martini Shot was closed.", cleanup_status: "not_requested" });
      recovered = true;
    } catch (error) {
      update(row.id, { prompt_id: null, error: `Finished in ComfyUI while Martini Shot was closed, but its result could not be used: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (!ranInComfy) return false;
  const cleanup = await freeComfyMemory();
  addReport(projectId, "final_video", `Cleanup after checking an interrupted stitch: ${cleanupText(cleanup)}`, cleanup);
  if (cleanup.status !== "completed") throw new Error(`ComfyUI cleanup did not complete, so nothing new was submitted. ${cleanup.error ?? ""}`);
  return recovered;
}

async function mp4Files(folder: string): Promise<Set<string>> {
  try { return new Set((await fs.readdir(folder)).filter((name) => name.toLowerCase().endsWith(".mp4")).map((name) => name.toLowerCase())); }
  catch { return new Set(); }
}

function readDuration(file: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const handle = fd;
    const size = statSync(file).size;
    return mp4Duration((offset, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      const read = buffer.length ? readSync(handle, buffer, 0, buffer.length, offset) : 0;
      return buffer.subarray(0, read);
    }, size);
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** Checks ComfyUI's result and stores the final video, its metadata, the clip summary, and the report snapshot. */
async function recordVideo(finalId: string, projectId: string, pkgRow: PackageRow, outputs: unknown, before: Set<string>, selection: Pick<StitchSelection, "files"> | null = null): Promise<void> {
  const project = projectIdentity(projectId);
  const pkg = toPackage(pkgRow);
  if (!pkg) throw new Error("The prompt package record is unreadable.");
  const stitchReport = previewText(outputs, "stitch_report") ?? previewText(outputs, "finalize");
  const videoText = (previewText(outputs, "video_path") ?? "").trim();
  const projectStatus = previewText(outputs, "status_json");
  update(finalId, { stitch_report: stitchReport, project_status: projectStatus });
  if (!stitchReport || !videoText) throw new Error("ComfyUI finished, but Finalize Video's video path or report was not in its results.");
  const parsed = parseFinalizeReport(stitchReport);
  // A remote worker reports its own path; the file itself was copied into the local package after the run.
  const remote = (await getMachineSettings()).executionDestination === "remote";
  const video = remote ? remoteReportedPath(project.slug, project.projectPath, pkg.folder, videoText) : path.resolve(videoText);
  if (parsed.partial) {
    update(finalId, { video_path: video, output_folder: path.dirname(video) });
    throw new Error(`Finalize Video made a partial test stitch instead of the full video: ${parsed.partial} The partial file is ${video}.`);
  }
  if (!video.toLowerCase().endsWith(".mp4") || !samePath(path.dirname(video), pkg.folder) || !isInside(project.projectPath, video)) {
    throw new Error(`Finalize Video reported ${video}, which is not an MP4 in this package's folder (${pkg.folder}).`);
  }
  if (!existsSync(video)) throw new Error(`Finalize Video reported ${video}, but the file is not there. Check that the ComfyUI output folder in Settings belongs to the running ComfyUI.`);
  if (before.has(path.basename(video).toLowerCase())) throw new Error(`ComfyUI returned ${path.basename(video)}, which existed before this stitch; it did not write a new video.`);
  const rows = db().prepare("SELECT * FROM render_clips WHERE package_run_id = ? ORDER BY clip_index").all(pkgRow.id) as ClipRow[];
  if (parsed.segments !== null && parsed.segments !== rows.length) throw new Error(`Finalize Video stitched ${parsed.segments} clips, but the package has ${rows.length}.`);
  const size = statSync(video).size;
  const duration = readDuration(video);
  const at = now();
  update(finalId, {
    status: "complete", video_path: video, output_folder: pkg.folder, file_size: size, duration_seconds: duration, video_info: parsed.info,
    clip_summary: JSON.stringify(summarizeClips(summaryClips(rows, selection))), completed_at: at, error: null,
  });
  const row = db().prepare("SELECT * FROM final_results WHERE id = ?").get(finalId) as FinalRow;
  const input = await reportInput(projectId, pkgRow, row, "snapshot");
  const report = buildDirectorReport(input);
  const stored: StoredReport = { report, outcome: outcomeFor(input) };
  let reportPath: string | null = path.join(pkg.folder, reportFileName(path.basename(video)));
  try { await fs.writeFile(reportPath, report.markdown, { encoding: "utf-8", flag: "wx" }); }
  catch { reportPath = null; } // An existing file of that name is left alone; Export report writes it on request.
  update(finalId, { report_data: JSON.stringify(stored), report_body: report.markdown, report_path: reportPath });
  db().prepare("UPDATE martini_projects SET status = 'complete', updated_at = ? WHERE id = ?").run(at, projectId);
  addReport(projectId, "final_video", `Final video stitched: ${video}${parsed.info ? ` (${parsed.info})` : ""}.`, { finalId, reportPath }, finalId);
}

async function executeStitch(finalId: string, projectId: string, pkgRowId: string, endpoint: string): Promise<void> {
  let cleanup: CleanupEvidence | null = null;
  try {
    update(finalId, { status: "running" });
    // Checked again now that it is this job's turn in the app's ComfyUI line: nothing may have changed in between.
    const ready = await readiness(projectId);
    if (ready.pkgRow?.id !== pkgRowId) throw new Error("The prompt package changed before the stitch started. Nothing was submitted.");
    if (ready.blockers.length) throw new Error(`Nothing was submitted to ComfyUI.\n${ready.blockers.join("\n")}`);
    const pkgRow = packageRow(pkgRowId)!;
    const folder = toPackage(pkgRow)!.folder;
    const before = await mp4Files(folder);
    const jobId = randomUUID();
    update(finalId, { comfy_job_id: jobId });
    let outputs: unknown;
    let cleanupFailed = false;
    try {
      // A remote worker reads the staged mirror of the package, not this PC's folder.
      const remote = (await getMachineSettings()).executionDestination === "remote";
      const wirePackage = remote ? remoteRenderPackage(ready.renderPackage!, ready.project.slug, ready.project.projectPath) : ready.renderPackage!;
      // Only when a clip uses a processed artifact: the selected-clip stitch. Otherwise the unchanged original stitch.
      const selected = ready.selection?.usesProcessed ? ready.selection : null;
      if (selected) update(finalId, { clip_selection: JSON.stringify({ files: selected.files }) });
      const template = selected ? "06b-stitch-selected.json" : "06-stitch-video.json";
      const values = selected
        ? { ...stitchWorkflowValues(ready.project.slug, wirePackage), clip_selection: JSON.stringify(selected.files.map((file) => ({ index: file.index, path: file.path }))) }
        : stitchWorkflowValues(ready.project.slug, wirePackage);
      const run = await runWorkflowTemplate(development, template, values, projectId, undefined, {
        jobId,
        onSubmitted: (promptId) => { update(finalId, { prompt_id: promptId, submitted_at: now() }); notify(projectId); },
        onProgress: (progress: WorkflowProgress) => setActivity(finalId, projectId, progress.phase, progress.queuePosition),
        onCleanup: (evidence) => { update(finalId, { cleanup_status: evidence.status, cleanup: JSON.stringify(evidence) }); notify(projectId); },
      });
      outputs = run.outputs;
      cleanup = run.cleanup;
    } catch (error) {
      if (!(error instanceof ComfyWorkflowError)) throw error;
      cleanup = error.cleanup;
      update(finalId, { stitch_report: previewText(error.outputs, "stitch_report"), project_status: previewText(error.outputs, "status_json") });
      if (!error.completed) throw error;
      // The video was written; only /free could not be confirmed. Keep the video and say so.
      outputs = error.outputs;
      cleanupFailed = true;
    }
    await recordVideo(finalId, projectId, pkgRow, outputs, before, ready.selection?.usesProcessed ? ready.selection : null);
    if (cleanupFailed) addReport(projectId, "final_video", `The final video was stitched, but ComfyUI cleanup could not be confirmed: ${cleanup?.error ?? "unknown"}.`, cleanup, finalId);
  } catch (error) {
    const message = readableProductionError(error instanceof Error ? error.message : String(error), endpoint);
    update(finalId, { status: "failed", error: message, completed_at: now() });
    addReport(projectId, "final_video_error", message + (cleanup ? `\n${cleanupText(cleanup)}` : ""), { finalId }, finalId);
  } finally {
    activity.delete(finalId);
    notify(projectId);
  }
}

// ----- Test videos ------------------------------------------------------------------------------------------

type TestRow = {
  id: string; project_id: string; package_run_id: string; batch: number; status: StitchStatus; comfy_job_id: string | null; prompt_id: string | null;
  clip_selection: string | null; videos: string | null; report: string | null; error: string | null; started_at: string; completed_at: string | null;
};
type StoredTestVideo = { first: number; last: number; path: string; fps: string | null; size: number | null; duration: number | null; processed: number[] };

/** Projects whose Stitch test videos click is being handled (a double click must not make two batches). */
const testsStarting = new Set<string>();

function testRows(projectId: string): TestRow[] {
  return db().prepare("SELECT * FROM test_stitches WHERE project_id = ? ORDER BY started_at DESC").all(projectId) as TestRow[];
}

function updateTest(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (keys.length) db().prepare(`UPDATE test_stitches SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => fields[key]) as never[], id);
}

/** A recorded test video file, only when it is an existing test_*.mp4 inside the project folder. */
function verifiedTestVideo(file: string, projectPath: string): string | null {
  if (!/^test_\d+_\d+_\d+\.mp4$/i.test(path.basename(file)) || !isInside(projectPath, file)) return null;
  return existsSync(file) ? path.resolve(file) : null;
}

function toTestBatch(row: TestRow, projectPath: string, currentPackageId: string | null): TestBatch {
  const videos: TestVideo[] = (parseJson<StoredTestVideo[]>(row.videos) ?? []).map((video, n) => {
    const file = verifiedTestVideo(video.path, projectPath);
    return {
      first: video.first, last: video.last, fileName: path.basename(video.path), path: video.path, exists: Boolean(file),
      url: file ? `martini-asset://test/${row.id}/${n}?v=${video.size ?? 0}` : null, durationSeconds: video.duration, sizeBytes: video.size,
      fps: video.fps, processed: video.processed ?? [],
    };
  });
  return {
    id: row.id, batch: row.batch, status: row.status, packageCurrent: row.package_run_id === currentPackageId, error: row.error, report: row.report,
    startedAt: row.started_at, completedAt: row.completed_at, videos,
  };
}

/** What Stitch test videos would do now, for the Results overview. Tests may run while clips are still rendering: they
 *  wait their turn in the app's ComfyUI line and only read finished clips. */
async function testsInfo(ready: Awaited<ReturnType<typeof readiness>>, comfyConnected: boolean): Promise<ResultsOverview["tests"]> {
  const { project, pkgRow, pkg, rows, renderPackage, selection } = ready;
  const batches = testRows(project.id).map((row) => toTestBatch(row, project.projectPath, pkgRow?.id ?? null));
  const empty = { runs: [] as Array<[number, number]>, singles: [] as number[], nextBatch: 1, batches };
  if (!pkgRow || !pkg) return { ...empty, available: false, reason: "There is no prompt package yet." };
  const files = new Set((selection?.files ?? []).map((file) => file.index));
  const rendered = new Set(rows.filter((row) => row.status === "rendered" && files.has(row.clip_index)).map((row) => row.clip_index));
  const { runs, singles } = testRuns(rows.map((row) => row.clip_index), rendered);
  const nextBatch = nextTestBatch([...await mp4Files(pkg.folder)], testRows(project.id).filter((row) => row.package_run_id === pkgRow.id).map((row) => row.batch));
  const active = batches.some((batch) => batch.packageCurrent && (batch.status === "queued" || batch.status === "running"));
  const reason = active ? "Test videos are being stitched."
    : !renderPackage || !samePath(String(renderPackage.folder), pkg.folder) ? "render_package.json does not point at this package. Write the prompt package again on Produce."
      : packageWriting(project.id) ? "A prompt package is being written."
        : !runs.length ? `No two neighbouring clips are rendered yet${singles.length ? ` (single clips: ${singles.join(", ")})` : ""}.`
          : !comfyConnected ? "ComfyUI is not reachable."
            : null;
  return { available: !reason, reason, runs, singles, nextBatch, batches };
}

/** Starts Stitch test videos in the background: one batch, one ComfyUI workflow (06c-stitch-tests.json). */
export async function startTestStitch(projectId: unknown): Promise<ResultsOverview> {
  const project = projectIdentity(projectId);
  if (testsStarting.has(project.id)) throw new Error("Test videos are already being stitched.");
  testsStarting.add(project.id);
  let testId: string | null = null;
  try {
    const overview = await resultsOverview(project.id);
    if (!overview.tests.available) throw new Error(`No test videos were stitched: ${overview.tests.reason}`);
    const ready = await readiness(project.id);
    const pkgRow = ready.pkgRow!;
    const rendered = new Set(ready.rows.filter((row) => row.status === "rendered").map((row) => row.clip_index));
    const files = (ready.selection?.files ?? []).filter((file) => rendered.has(file.index)).map((file) => ({ index: file.index, path: file.path }));
    testId = randomUUID();
    db().prepare(`INSERT INTO test_stitches (id, project_id, package_run_id, batch, status, clip_selection, started_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
      .run(testId, project.id, pkgRow.id, overview.tests.nextBatch, JSON.stringify(files), now());
    addReport(project.id, "final_video", `Stitch test videos started (batch ${overview.tests.nextBatch}): clips ${overview.tests.runs.map(([a, b]) => `${a}-${b}`).join(", ")}.`, { testId });
    const id = testId;
    void serializeComfyWork(() => executeTestStitch(id, project.id, pkgRow.id, overview.tests.nextBatch, files)).catch(() => undefined).finally(() => notify(project.id));
    notify(project.id);
    return resultsOverview(project.id);
  } finally {
    testsStarting.delete(project.id);
  }
}

async function executeTestStitch(testId: string, projectId: string, pkgRowId: string, batch: number, files: Array<{ index: number; path: string }>): Promise<void> {
  try {
    updateTest(testId, { status: "running" });
    notify(projectId);
    const project = getProject(projectId);
    const pkgRow = packageRow(pkgRowId);
    const pkg = pkgRow ? toPackage(pkgRow) : null;
    if (!pkgRow || !pkg || currentPackageRow(projectId)?.id !== pkgRowId) throw new Error("The prompt package changed before the test stitch started. Nothing was submitted.");
    const renderPackage = await readRenderPackage(project.projectPath);
    if (!renderPackage) throw new Error("render_package.json is missing. Nothing was submitted.");
    const remote = (await getMachineSettings()).executionDestination === "remote";
    const wirePackage = remote ? remoteRenderPackage(renderPackage, project.slug, project.projectPath) : renderPackage;
    const run = await runWorkflowTemplate(development, "06c-stitch-tests.json", { ...stitchWorkflowValues(project.slug, wirePackage), clip_selection: JSON.stringify(files), batch }, projectId, undefined, {
      jobId: randomUUID(), onSubmitted: (promptId) => { updateTest(testId, { prompt_id: promptId }); notify(projectId); },
    });
    const report = previewText(run.outputs, "stitch_report");
    const reported = parseJson<Array<{ first: number; last: number; path: string; fps?: string; processed?: number[] }>>(previewText(run.outputs, "videos"));
    if (!reported || !reported.length) throw new Error("ComfyUI finished, but the test stitch reported no videos.");
    const videos: StoredTestVideo[] = reported.map((video) => {
      const local = remote ? remoteReportedPath(project.slug, project.projectPath, pkg.folder, video.path) : path.resolve(video.path);
      const expected = `test_${video.first}_${video.last}_${batch}.mp4`;
      if (path.basename(local).toLowerCase() !== expected.toLowerCase() || !samePath(path.dirname(local), pkg.folder)) {
        throw new Error(`The test stitch reported ${local}, not ${expected} in this package's folder.`);
      }
      if (!existsSync(local)) throw new Error(`The test stitch reported ${local}, but the file is not there.`);
      return { first: video.first, last: video.last, path: local, fps: video.fps ?? null, size: statSync(local).size, duration: readDuration(local), processed: video.processed ?? [] };
    });
    updateTest(testId, { status: "complete", videos: JSON.stringify(videos), report, completed_at: now(), error: null });
    addReport(projectId, "final_video", `Test videos stitched (batch ${batch}): ${videos.map((video) => path.basename(video.path)).join(", ")}.`, { testId });
  } catch (error) {
    const message = readableProductionError(error instanceof Error ? error.message : String(error), (await comfyStatus()).endpoint);
    const outputs = error instanceof ComfyWorkflowError ? error.outputs : null;
    updateTest(testId, { status: "failed", error: message, report: outputs ? previewText(outputs, "stitch_report") : null, completed_at: now() });
    addReport(projectId, "final_video_error", `Test stitch failed: ${message}`, { testId });
  } finally {
    notify(projectId);
  }
}

function testRow(projectId: unknown, testId: unknown): TestRow {
  const project = projectIdentity(projectId);
  if (typeof testId !== "string" || !/^[0-9a-f-]{36}$/i.test(testId)) throw new Error("Unknown test batch.");
  const row = db().prepare("SELECT * FROM test_stitches WHERE id = ? AND project_id = ?").get(testId, project.id) as TestRow | undefined;
  if (!row) throw new Error("That test batch is not recorded for this project.");
  return row;
}

/** For the martini-asset://test/<testId>/<n> protocol: the n-th recorded video of that batch, or null. */
export function testVideoFile(testId: string, n: number): string | null {
  const row = db().prepare("SELECT * FROM test_stitches WHERE id = ?").get(testId) as TestRow | undefined;
  const video = row ? parseJson<StoredTestVideo[]>(row.videos)?.[n] : undefined;
  if (!row || !video) return null;
  try { return verifiedTestVideo(video.path, projectIdentity(row.project_id).projectPath); } catch { return null; }
}

export function testVideoPath(projectId: unknown, testId: unknown, n: unknown): string {
  const row = testRow(projectId, testId);
  const video = typeof n === "number" && Number.isInteger(n) ? parseJson<StoredTestVideo[]>(row.videos)?.[n] : undefined;
  const file = video ? verifiedTestVideo(video.path, projectIdentity(row.project_id).projectPath) : null;
  if (!file) throw new Error(`${video?.path ?? "This test video"} is no longer on disk.`);
  return file;
}

// ----- Files, report export ---------------------------------------------------------------------------------

/** For the martini-asset://final/<id> protocol: the recorded file of that final video, or null. */
export function finalVideoFile(finalId: string): string | null {
  const row = db().prepare("SELECT * FROM final_results WHERE id = ?").get(finalId) as FinalRow | undefined;
  if (!row) return null;
  try { return verifiedVideo(row, projectIdentity(row.project_id).projectPath); } catch { return null; }
}

export function finalVideoPath(projectId: unknown, finalId: unknown): string {
  const row = finalRow(projectId, finalId);
  const video = verifiedVideo(row, projectIdentity(row.project_id).projectPath);
  if (!video) throw new Error(`${row.video_path ?? "This final video"} is no longer on disk.`);
  return video;
}

export function finalOutputFolder(projectId: unknown, finalId: unknown): string {
  const row = finalRow(projectId, finalId);
  const projectPath = projectIdentity(row.project_id).projectPath;
  const folder = row.output_folder ?? (row.video_path ? path.dirname(row.video_path) : null);
  if (!folder || !isInside(projectPath, folder) || !existsSync(folder)) throw new Error("The output folder of this video is no longer inside the project folder.");
  return path.resolve(folder);
}

/** The report text: the saved snapshot of a final video, or (finalId null) a live report of the current package. */
export async function reportText(projectId: unknown, finalId: unknown): Promise<string> {
  if (finalId !== null && finalId !== undefined) {
    const row = finalRow(projectId, finalId);
    if (row.report_body) return row.report_body;
  }
  return (await resultsOverview(projectId)).report.markdown;
}

/** Writes the report as Markdown into the project: next to the video for a final video, else <project>\reports\. */
export async function exportReport(projectId: unknown, finalId: unknown): Promise<string> {
  const project = projectIdentity(projectId);
  let target: string;
  let body: string;
  if (finalId !== null && finalId !== undefined) {
    const row = finalRow(project.id, finalId);
    body = row.report_body ?? (await resultsOverview(project.id)).report.markdown;
    const folder = finalOutputFolder(project.id, row.id);
    target = path.join(folder, reportFileName(row.video_path ? path.basename(row.video_path) : "final.mp4"));
    await fs.writeFile(target, body, "utf-8");
    update(row.id, { report_path: target });
  } else {
    body = (await resultsOverview(project.id)).report.markdown;
    const folder = path.join(project.projectPath, "reports");
    if (!isInside(project.projectPath, folder)) throw new Error("The reports folder is outside the project.");
    await fs.mkdir(folder, { recursive: true });
    target = path.join(folder, `director-report-${now().replace(/[:.]/g, "-")}.md`);
    await fs.writeFile(target, body, "utf-8");
  }
  addReport(project.id, "report_export", `Director report exported to ${target}.`);
  notify(project.id);
  return target;
}
