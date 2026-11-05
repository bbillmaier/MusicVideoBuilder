// Project and asset service owned by Electron main. The renderer reaches it only through the typed IPC in main.ts.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AssetChangeResult, AssetIssue, AssetRole, ComfySyncStatus, ProjectAsset, ProjectDetail, ProjectState, ProjectsOverview, ProjectSummary,
} from "./contracts";
import { buildCreateProjectPrompt, createProjectReport, type CreateProjectReference } from "./create-project-workflow";
import { runWorkflowTemplate, serializeComfyWork } from "./comfy-client";
import { db, getMachineSettings } from "./db";
import { productionBusy, timelineApplying } from "./production-lock";
import { projectStorage, relativeProjectPath } from "./project-storage";
import {
  ORIGINALS_FOLDER, ROLE_RULES, copyAsset, friendlyName, isInside, missingRequirements,
  statusAfterAssetChange, storedFileName, validateProjectName,
} from "./project-rules";

type ProjectRow = {
  id: string; name: string; slug: string; project_path: string; status: ProjectState; created_at: string; updated_at: string;
  last_opened_at: string | null; comfy_sync_status: ComfySyncStatus; comfy_sync_error: string | null; comfy_synced_at: string | null;
  comfy_sync_job_id: string | null;
};
type AssetRow = {
  id: string; project_id: string; role: AssetRole; display_name: string; original_path: string; stored_path: string;
  checksum: string | null; sort_order: number; file_size: number | null; duration_seconds: number | null;
};

const ROLE_ORDER = `CASE role WHEN 'song' THEN 0 WHEN 'performer' THEN 1 WHEN 'outfit' THEN 2 ELSE 3 END`;
const now = () => new Date().toISOString();

let notify: (projectId: string) => void = () => undefined;
let development = false;
export function configureProjectService(options: { isDevelopment: boolean; onChange(projectId: string): void }): void {
  development = options.isDevelopment;
  notify = options.onChange;
  // A save interrupted by quitting the app is not in progress any more.
  db().prepare("UPDATE martini_projects SET comfy_sync_status = 'not_saved' WHERE comfy_sync_status = 'saving'").run();
}

// ----- Paths -----------------------------------------------------------------------------------------------

const originalsFolder = (projectPath: string) => `${projectPath}/assets/${ORIGINALS_FOLDER}`;

// Details are synchronous because they are read from SQLite. File operations below
// perform the authoritative async storage check; a relative project path is usable.
function folderExists(projectPath: string): boolean { return path.isAbsolute(projectPath) ? (() => { try { return statSync(projectPath).isDirectory(); } catch { return false; } })() : Boolean(projectPath); }

// ----- Reads -----------------------------------------------------------------------------------------------

function projectRow(id: unknown): ProjectRow {
  if (typeof id !== "string" || !id) throw new Error("Unknown project.");
  const row = db().prepare("SELECT * FROM martini_projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) throw new Error("That project no longer exists in the local database.");
  return row;
}

function assetRows(projectId: string): AssetRow[] {
  return db().prepare(`SELECT * FROM project_assets WHERE project_id = ? ORDER BY ${ROLE_ORDER}, sort_order, created_at`).all(projectId) as AssetRow[];
}

function toAsset(row: AssetRow): ProjectAsset {
  return {
    id: row.id, role: row.role, displayName: row.display_name, fileName: path.basename(row.original_path),
    originalPath: row.original_path, storedPath: row.stored_path, checksum: row.checksum, fileSize: row.file_size,
    durationSeconds: row.duration_seconds, sortOrder: row.sort_order, available: path.isAbsolute(row.stored_path) ? existsSync(row.stored_path) : Boolean(row.stored_path),
    previewUrl: `martini-asset://asset/${row.id}?v=${(row.checksum || "0").slice(0, 12)}`,
  };
}

function countRoles(assets: { role: AssetRole }[]): Record<AssetRole, number> {
  const counts = { song: 0, performer: 0, outfit: 0, location: 0 } as Record<AssetRole, number>;
  for (const asset of assets) counts[asset.role] += 1;
  return counts;
}

function toSummary(row: ProjectRow, assets: ProjectAsset[]): ProjectSummary {
  const thumb = ["performer", "location", "outfit"].map((role) => assets.find((asset) => asset.role === role)).find(Boolean);
  return {
    id: row.id, name: row.name, slug: row.slug, projectPath: row.project_path, status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at, lastOpenedAt: row.last_opened_at, folderExists: folderExists(row.project_path),
    songDurationSeconds: assets.find((asset) => asset.role === "song")?.durationSeconds ?? null,
    counts: countRoles(assets), thumbnailUrl: thumb?.previewUrl ?? null,
  };
}

function detail(row: ProjectRow): ProjectDetail {
  const assets = assetRows(row.id).map(toAsset);
  const summary = toSummary(row, assets);
  return {
    ...summary, assets, missing: missingRequirements(summary.counts),
    comfySync: { status: row.comfy_sync_status, savedAt: row.comfy_synced_at, error: row.comfy_sync_error, jobId: row.comfy_sync_job_id },
  };
}

export function listProjects(limit = 30): ProjectSummary[] {
  const rows = db().prepare("SELECT * FROM martini_projects ORDER BY COALESCE(last_opened_at, updated_at) DESC LIMIT ?").all(limit) as ProjectRow[];
  return rows.map((row) => toSummary(row, assetRows(row.id).map(toAsset)));
}

export function getProject(id: unknown): ProjectDetail {
  return detail(projectRow(id));
}

/** The most recently opened project whose folder still exists, so a launch never reopens into a broken project. */
export function activeProject(): ProjectDetail | null {
  const rows = db().prepare("SELECT * FROM martini_projects WHERE last_opened_at IS NOT NULL ORDER BY last_opened_at DESC LIMIT 10").all() as ProjectRow[];
  const row = rows.find((candidate) => folderExists(candidate.project_path));
  return row ? detail(row) : null;
}

export async function projectsOverview(): Promise<ProjectsOverview> {
  const settings = await getMachineSettings();
  return { active: activeProject(), recent: listProjects(), projectsRoot: path.join(settings.comfyOutputDir, "martini_shot"), rootError: null };
}

// ----- Project create/open ---------------------------------------------------------------------------------

export async function createProject(rawName: unknown): Promise<ProjectDetail> {
  const { name, slug } = validateProjectName(rawName);
  const existing = db().prepare("SELECT name FROM martini_projects WHERE slug = ?").get(slug) as { name: string } | undefined;
  if (existing) throw new Error(`"${existing.name}" already uses the folder name "${slug}". Open it from Recent projects or choose a different name.`);
  const storage = await projectStorage();
  const projectPath = storage.remote ? slug : storage.localPath!(slug);
  if (storage.remote ? await storage.exists(projectPath) : existsSync(projectPath)) throw new Error(`A project named "${slug}" already exists. Choose a different name so it is not overwritten.`);
  try {
    if (storage.remote) { await storage.mkdir(projectPath); await storage.mkdir(originalsFolder(projectPath)); }
    else { await fs.mkdir(originalsFolder(projectPath), { recursive: true }); }
  } catch (error) {
    throw new Error(`Could not create the project folder ${projectPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const id = randomUUID();
  const timestamp = now();
  db().prepare(`INSERT INTO martini_projects (id, name, slug, project_path, status, created_at, updated_at, last_opened_at, comfy_sync_status)
    VALUES (?, ?, ?, ?, 'new', ?, ?, ?, 'waiting_for_assets')`).run(id, name, slug, projectPath, timestamp, timestamp, timestamp);
  return getProject(id);
}

export function openProject(id: unknown): ProjectDetail {
  const row = projectRow(id);
  if (!folderExists(row.project_path)) {
    throw new Error(`The project folder is missing: ${row.project_path}. It may have been moved, renamed, or deleted outside Martini Shot.`);
  }
  db().prepare("UPDATE martini_projects SET last_opened_at = ? WHERE id = ?").run(now(), row.id);
  return getProject(row.id);
}

export function projectFolder(id: unknown): string {
  const row = projectRow(id);
  if (!folderExists(row.project_path)) throw new Error(`The project folder is missing: ${row.project_path}.`);
  return row.project_path;
}

// ----- Assets ----------------------------------------------------------------------------------------------

function editableProject(id: unknown): ProjectRow {
  const row = projectRow(id);
  if (!folderExists(row.project_path)) throw new Error(`The project folder is missing: ${row.project_path}. Assets cannot be changed until it is restored.`);
  return row;
}

function afterAssetChange(row: ProjectRow, issues: AssetIssue[]): void {
  const counts = countRoles(assetRows(row.id));
  const timestamp = now();
  db().prepare("UPDATE martini_projects SET status = ?, updated_at = ?, comfy_sync_status = ?, comfy_sync_error = NULL WHERE id = ?")
    .run(statusAfterAssetChange(counts), timestamp, missingRequirements(counts).length ? "waiting_for_assets" : "not_saved", row.id);
  if (issues.length) {
    db().prepare("INSERT INTO project_reports (id, project_id, category, body, data, created_at) VALUES (?, ?, 'asset_copy', ?, ?, ?)")
      .run(randomUUID(), row.id, issues.map((issue) => `${issue.file}: ${issue.reason}`).join("\n"), JSON.stringify(issues), timestamp);
  }
  notify(row.id);
  scheduleComfySync(row.id);
}

async function removeStoredCopy(projectPath: string, storedPath: string): Promise<void> {
  // Only the project's own copy may be deleted; the user's original file is never touched.
  if (!isInside(originalsFolder(projectPath), storedPath)) return;
  const storage = await projectStorage();
  if (storage.remote) await storage.remove(storedPath).catch(() => undefined);
  else await fs.rm(storedPath, { force: true }).catch(() => undefined);
}

async function storeAsset(role: AssetRole, source: string, destination: string): Promise<{ storedPath: string; checksum: string; fileSize: number }> {
  const storage = await projectStorage();
  if (!storage.remote) return copyAsset(role, source, path.dirname(destination), path.basename(destination));
  const rule = ROLE_RULES[role];
  const stat = await fs.stat(source).catch(() => { throw new Error(`The file no longer exists: ${source}`); });
  if (!stat.isFile() || !stat.size || stat.size > rule.maxBytes) throw new Error(`${path.basename(source)} is not a supported ${rule.label.toLowerCase()} file.`);
  if (!rule.extensions.includes(path.extname(source).toLowerCase())) throw new Error(`${rule.label}s must be ${rule.extensions.join(", ")}.`);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => { const stream = createReadStream(source); stream.on("data", (chunk: Buffer) => hash.update(chunk)); stream.once("error", reject); stream.once("end", resolve); });
  await storage.uploadFile(source, destination, { overwrite: false });
  return { storedPath: destination, checksum: hash.digest("hex"), fileSize: stat.size };
}

/** Copies the chosen files into the project. A failing file is reported and skipped; the rest still import. */
export async function addAssets(projectId: unknown, role: AssetRole, sources: string[]): Promise<AssetChangeResult> {
  const row = editableProject(projectId);
  if (!sources.length) return { project: getProject(row.id), added: 0, issues: [], cancelled: true };
  if (!ROLE_RULES[role].multiple && sources.length > 1) throw new Error("Choose exactly one song file.");
  const existing = assetRows(row.id);
  const issues: AssetIssue[] = [];
  const accepted: Pick<AssetRow, "role" | "checksum" | "display_name">[] = [];
  let added = 0;
  let order = Math.max(0, ...existing.filter((asset) => asset.role === role).map((asset) => asset.sort_order + 1));
  for (const source of sources) {
    const id = randomUUID();
    try {
      const copy = await storeAsset(role, source, `${originalsFolder(row.project_path)}/${storedFileName(role, id, source)}`);
      // Same file content in the same role, either already saved or earlier in this same selection.
      const duplicate = [...existing, ...accepted].find((asset) => asset.role === role && asset.checksum === copy.checksum);
      if (duplicate && ROLE_RULES[role].multiple) {
        await removeStoredCopy(row.project_path, copy.storedPath);
        issues.push({ file: source, reason: `Already in this project as "${duplicate.display_name}".` });
        continue;
      }
      const timestamp = now();
      db().prepare(`INSERT INTO project_assets (id, project_id, role, display_name, original_path, stored_path, checksum, sort_order, created_at, file_size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, row.id, role, friendlyName(source), source, copy.storedPath, copy.checksum, order++, timestamp, copy.fileSize, timestamp);
      accepted.push({ role, checksum: copy.checksum, display_name: friendlyName(source) });
      added += 1;
      if (!ROLE_RULES[role].multiple) {
        // A project has exactly one song: the new one replaces any previous one.
        for (const old of existing.filter((asset) => asset.role === role)) {
          db().prepare("DELETE FROM project_assets WHERE id = ?").run(old.id);
          await removeStoredCopy(row.project_path, old.stored_path);
        }
      }
    } catch (error) {
      issues.push({ file: source, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (added || issues.length) afterAssetChange(row, issues);
  return { project: getProject(row.id), added, issues, cancelled: false };
}

function ownedAsset(row: ProjectRow, assetId: unknown): AssetRow {
  if (typeof assetId !== "string" || !assetId) throw new Error("Unknown asset.");
  const asset = db().prepare("SELECT * FROM project_assets WHERE id = ? AND project_id = ?").get(assetId, row.id) as AssetRow | undefined;
  if (!asset) throw new Error("That asset is no longer part of this project.");
  return asset;
}

export async function removeAsset(projectId: unknown, assetId: unknown): Promise<ProjectDetail> {
  const row = editableProject(projectId);
  const asset = ownedAsset(row, assetId);
  db().prepare("DELETE FROM project_assets WHERE id = ?").run(asset.id);
  const remaining = assetRows(row.id).filter((item) => item.role === asset.role);
  remaining.forEach((item, index) => db().prepare("UPDATE project_assets SET sort_order = ? WHERE id = ?").run(index, item.id));
  await removeStoredCopy(row.project_path, asset.stored_path);
  afterAssetChange(row, []);
  return getProject(row.id);
}

export function assetRole(projectId: unknown, assetId: unknown): AssetRole {
  return ownedAsset(projectRow(projectId), assetId).role;
}

/** Swaps one asset's file in place, keeping its position. The old project copy is deleted only after the new copy succeeds. */
export async function replaceAsset(projectId: unknown, assetId: unknown, source: string | undefined): Promise<AssetChangeResult> {
  const row = editableProject(projectId);
  const asset = ownedAsset(row, assetId);
  if (!source) return { project: getProject(row.id), added: 0, issues: [], cancelled: true };
  try {
    const copy = await storeAsset(asset.role, source, `${originalsFolder(row.project_path)}/${storedFileName(asset.role, randomUUID(), source)}`);
    db().prepare(`UPDATE project_assets SET display_name = ?, original_path = ?, stored_path = ?, checksum = ?, file_size = ?, duration_seconds = NULL, updated_at = ?
      WHERE id = ?`).run(friendlyName(source), source, copy.storedPath, copy.checksum, copy.fileSize, now(), asset.id);
    await removeStoredCopy(row.project_path, asset.stored_path);
    afterAssetChange(row, []);
    return { project: getProject(row.id), added: 1, issues: [], cancelled: false };
  } catch (error) {
    const issues = [{ file: source, reason: error instanceof Error ? error.message : String(error) }];
    afterAssetChange(row, issues);
    return { project: getProject(row.id), added: 0, issues, cancelled: false };
  }
}

/** Song duration is measured by the renderer's audio decoder and stored for the recent-projects list. */
export function recordSongDuration(projectId: unknown, assetId: unknown, seconds: unknown): void {
  const asset = ownedAsset(projectRow(projectId), assetId);
  if (asset.role !== "song") throw new Error("Only songs have a duration.");
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 6 * 3600) throw new Error("Invalid song duration.");
  if (asset.duration_seconds !== null && Math.abs(asset.duration_seconds - seconds) < 0.01) return;
  db().prepare("UPDATE project_assets SET duration_seconds = ? WHERE id = ?").run(seconds, asset.id);
}

/** Resolves a preview request to the project's stored copy only. */
export function previewFile(assetId: string): string | null {
  const asset = db().prepare("SELECT a.stored_path, p.project_path FROM project_assets a JOIN martini_projects p ON p.id = a.project_id WHERE a.id = ?")
    .get(assetId) as { stored_path: string; project_path: string } | undefined;
  if (!asset || (path.isAbsolute(asset.project_path) ? !isInside(asset.project_path, asset.stored_path) || !existsSync(asset.stored_path) : !asset.stored_path.startsWith(`${asset.project_path}/`))) return null;
  return asset.stored_path;
}

// ----- ComfyUI project file (workflows/01-create-project.json) ---------------------------------------------

const syncState = new Map<string, "running" | "rerun">();

function setSync(projectId: string, status: ComfySyncStatus, fields: { error?: string | null; savedAt?: string; jobId?: string } = {}): void {
  db().prepare(`UPDATE martini_projects SET comfy_sync_status = ?, comfy_sync_error = ?,
    comfy_synced_at = COALESCE(?, comfy_synced_at), comfy_sync_job_id = COALESCE(?, comfy_sync_job_id) WHERE id = ?`)
    .run(status, fields.error ?? null, fields.savedAt ?? null, fields.jobId ?? null, projectId);
  notify(projectId);
}

/** Coalesces bursts of asset edits into one ComfyUI run per project; all ComfyUI work is serialized. */
export function scheduleComfySync(projectId: string): void {
  if (syncState.get(projectId)) { syncState.set(projectId, "rerun"); return; }
  syncState.set(projectId, "running");
  void serializeComfyWork(async () => {
    try {
      do {
        syncState.set(projectId, "running");
        await syncProjectToComfy(projectId);
      } while (syncState.get(projectId) === "rerun");
    } finally { syncState.delete(projectId); }
  }).catch(() => undefined);
}

/** Called from inside serialized ComfyUI work (e.g. before planning): makes sure project.json reflects the current assets.
 *  Returns null when saved, otherwise the reason it is not. */
export async function ensureComfyProjectSaved(projectId: string): Promise<string | null> {
  const row = projectRow(projectId);
  const savedPath = `${row.project_path}/project.json`;
  const savedStorage = await projectStorage();
  if (row.comfy_sync_status !== "saved" || (savedStorage.remote ? !(await savedStorage.exists(savedPath)) : !existsSync(savedPath))) await syncProjectToComfy(projectId);
  const after = projectRow(projectId);
  if (after.comfy_sync_status === "saved") return null;
  return after.comfy_sync_error || (after.comfy_sync_status === "waiting_for_assets" ? missingRequirements(countRoles(assetRows(projectId))).join(". ") : "The project has not been saved through ComfyUI.");
}

/** Supplied location reference names exactly as Martini Shot Project saved them (the asset display names). */
export function suppliedLocationNames(projectId: string): string[] {
  return assetRows(projectId).filter((asset) => asset.role === "location").map((asset) => asset.display_name);
}

export function projectAssetsForPlanning(projectId: string): { role: string; checksum: string | null; displayName: string }[] {
  return assetRows(projectId).map((asset) => ({ role: asset.role, checksum: asset.checksum, displayName: asset.display_name }));
}

export function projectIdentity(id: unknown): { id: string; name: string; slug: string; projectPath: string } {
  const row = projectRow(id);
  return { id: row.id, name: row.name, slug: row.slug, projectPath: row.project_path };
}

async function syncProjectToComfy(projectId: string): Promise<void> {
  let row: ProjectRow;
  try { row = projectRow(projectId); } catch { return; }
  const assets = assetRows(row.id);
  if (missingRequirements(countRoles(assets)).length) { setSync(row.id, "waiting_for_assets"); return; }
  setSync(row.id, "saving");
  try {
    const storage = await projectStorage();
    const missingFiles = [] as AssetRow[];
    for (const asset of assets) if (storage.remote ? !(await storage.exists(asset.stored_path)) : !existsSync(asset.stored_path)) missingFiles.push(asset);
    if (missingFiles.length) throw new Error(`These project copies are missing; replace them: ${missingFiles.map((asset) => asset.display_name).join(", ")}.`);
    const song = assets.find((asset) => asset.role === "song")!;
    const references: CreateProjectReference[] = assets.filter((asset) => asset.role !== "song").map((asset) => ({
      imageFile: storage.remote ? `martini_shot/${asset.stored_path} [output]` : `martini_shot/${row.slug}/${path.relative(row.project_path, asset.stored_path).split(path.sep).join("/")} [output]`, kind: ROLE_RULES[asset.role].comfyKind as CreateProjectReference["kind"], name: asset.display_name,
    }));
    const localSong = `martini_shot/${row.slug}/${path.relative(row.project_path, song.stored_path).split(path.sep).join("/")} [output]`;
    const values = { projectName: row.slug, songFile: storage.remote ? `martini_shot/${song.stored_path} [output]` : localSong, references };
    const run = await runWorkflowTemplate(development, "01-create-project.json", {}, row.id, (template) => buildCreateProjectPrompt(template, values));
    const manifest = `${row.project_path}/project.json`;
    if (storage.remote ? !(await storage.exists(manifest)) : !existsSync(manifest)) {
      throw new Error(`ComfyUI finished, but ${manifest} was not written. Check that the ComfyUI output folder in Settings is the folder the running ComfyUI uses.`);
    }
    const report = createProjectReport(run.outputs);
    if (report) {
      db().prepare("INSERT INTO project_reports (id, project_id, category, body, created_at) VALUES (?, ?, 'comfy_project', ?, ?)").run(randomUUID(), row.id, report, now());
    }
    setSync(row.id, "saved", { savedAt: now(), jobId: run.job.id });
  } catch (error) {
    setSync(row.id, "failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export function retryComfySync(projectId: unknown): ProjectDetail {
  const row = projectRow(projectId);
  scheduleComfySync(row.id);
  return getProject(row.id);
}


// ----- Project delete --------------------------------------------------------------------------------------

/** Why this project cannot be deleted right now, or null. Work that is still writing into the folder must finish first. */
export function projectDeleteBlocker(id: string): string | null {
  const busy = productionBusy();
  if (busy?.projectId === id) return `This project is ${busy.kind === "render" ? "rendering clips" : busy.kind === "package" ? "writing a prompt package" : "stitching the final video"}. Stop it or wait for it to finish, then delete it.`;
  if (timelineApplying.has(id)) return "The song timeline is being applied to the plan. Wait for it to finish, then delete the project.";
  if (syncState.has(id)) return "The project is being saved through ComfyUI. Wait for it to finish, then delete it.";
  const run = db().prepare("SELECT stage FROM director_runs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1").get(id) as { stage: string } | undefined;
  if (run) return "A director step (plan, locations, or prompt package) is still running for this project. Wait for it to finish, then delete it.";
  const final = db().prepare("SELECT id FROM final_results WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1").get(id);
  if (final) return "The final video is being stitched. Wait for it to finish, then delete the project.";
  return null;
}

/** The folder to move to the Recycle Bin, or null when it is already gone. Only a Martini Shot project folder qualifies:
 *  one inside the projects folder, or (after the ComfyUI output folder changed in Settings) a folder named after the project
 *  that holds its assets folder. Anything else is refused rather than deleted. */
export async function projectDeleteTarget(rawId: unknown): Promise<{ id: string; name: string; folder: string | null }> {
  const row = projectRow(rawId);
  const blocker = projectDeleteBlocker(row.id);
  if (blocker) throw new Error(blocker);
  const settings = await getMachineSettings();
  const root = path.join(settings.comfyOutputDir, "martini_shot");
  const folder = path.isAbsolute(row.project_path) ? path.resolve(row.project_path) : (() => { try { return path.join(root, ...relativeProjectPath(row.project_path).split("/")); } catch { return null; } })();
  if (!folder || !existsSync(folder)) return { id: row.id, name: row.name, folder: null };
  const ours = isInside(root, folder) || (path.basename(folder) === row.slug && existsSync(path.join(folder, "assets")));
  if (!ours) throw new Error(`${folder} does not look like a Martini Shot project folder, so it was not deleted. Delete it yourself if you no longer need it.`);
  return { id: row.id, name: row.name, folder };
}

/** Removes the project and everything recorded about it (assets, plans, renders, reports) from the local database. */
export function forgetProject(id: string): void {
  db().prepare("DELETE FROM martini_projects WHERE id = ?").run(id);
  notify(id);
}
