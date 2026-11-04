// Location requests and resolution (Ticket 04), owned by Electron main. The renderer reaches it only through typed IPC.
// Check for images runs workflows/03-resolve-locations.json (Open Project -> Load Story Plan -> Resolve Locations); it never plans.
import { nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  LocationCheckRun, LocationFileCandidate, LocationPlaceResult, LocationsOverview, LocationStateMode, PlanData, PlanRunStatus,
  RequestedLocationStatus, SuppliedLocationStatus,
} from "./contracts";
import { comfyStatus, runWorkflowTemplate, serializeComfyWork, type WorkflowProgress } from "./comfy-client";
import { db } from "./db";
import {
  LOCATION_IMAGE_EXTENSIONS, MAX_LOCATION_IMAGE_BYTES, REPLACED_FOLDER, candidateSignature, describeRequest, locationsFolder, parseResolveReport,
  plannedRequests, requestedTargetPath, resolveWorkflowValues, scanLocationFolder, shortReportLine, sniffImage, storageSlug, storyFileHash,
  suppliedSections, textOnlyLocations, type FolderEntry, type FolderScan, type PlannedRequest, type ResolvedLine, type StoredRequestState,
} from "./location-rules";
import { previewText, storySignature, parseStoryPlan, type RawStoryPlan } from "./plan-rules";
import { planOverview } from "./plan-service";
import { ensureComfyProjectSaved, getProject, projectIdentity, suppliedLocationNames } from "./project-service";
import { isInside } from "./project-rules";

const CHECK_STAGE = "resolve_locations";
const now = () => new Date().toISOString();

type RequestRow = {
  id: string; project_id: string; plan_run_id: string; source: string; location_name: string; location_slug: string; section_numbers: string;
  broll_sections: string; file_name: string | null; expected_path: string; mode: LocationStateMode; reason: string | null; detail: string | null;
  checked_signature: string | null; check_run_id: string | null; checked_at: string | null; updated_at: string;
};
type CheckRow = {
  id: string; project_id: string; status: PlanRunStatus; settings: string; report: string | null; plan_json: string | null; error: string | null;
  created_at: string; completed_at: string | null; story_changed: number | null;
};
type CheckResult = { summary: string[]; readyToProduce: boolean | null };

let development = false;
let notify: (projectId: string) => void = () => undefined;
const activity = new Map<string, NonNullable<LocationCheckRun["activity"]>>();

export function configureLocationService(options: { isDevelopment: boolean; onChange(projectId: string): void }): void {
  development = options.isDevelopment;
  notify = options.onChange;
  db().prepare(`UPDATE director_runs SET status = 'interrupted', completed_at = ?,
    error = 'Martini Shot was closed while checking for images. Click Check for images again.'
    WHERE stage = ? AND status IN ('queued', 'running')`).run(now(), CHECK_STAGE);
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

// ----- Folder ----------------------------------------------------------------------------------------------

async function readFolder(folder: string): Promise<FolderEntry[]> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const result: FolderEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(folder, entry.name);
    try {
      const stat = await fs.stat(file);
      let head: Uint8Array | null = null;
      const handle = await fs.open(file, "r");
      try {
        const buffer = Buffer.alloc(16);
        const { bytesRead } = await handle.read(buffer, 0, 16, 0);
        head = buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
      result.push({ name: entry.name, isFile: true, size: stat.size, mtimeMs: stat.mtimeMs, head });
    } catch {
      // A locked or vanished file: list it with no readable contents so it shows as a problem rather than disappearing.
      result.push({ name: entry.name, isFile: true, size: 0, mtimeMs: 0, head: null });
    }
  }
  return result;
}

/** Creates the locations folder when needed and scans it. Errors become a readable folderError, never a crash. */
async function scanFolder(projectPath: string, slugs: string[], create: boolean): Promise<{ scan: FolderScan; error: string | null }> {
  const folder = locationsFolder(projectPath);
  const empty: FolderScan = { bySlug: new Map(slugs.map((slug) => [slug, []])), unrecognized: [] };
  try {
    if (create) await fs.mkdir(folder, { recursive: true });
    else if (!existsSync(folder)) return { scan: empty, error: null };
    return { scan: scanLocationFolder(await readFolder(folder), slugs), error: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const reason = code === "EACCES" || code === "EPERM" ? "Windows denied access to it" : error instanceof Error ? error.message : String(error);
    return { scan: empty, error: `Could not open the locations folder ${folder}: ${reason}.` };
  }
}

// ----- Overview --------------------------------------------------------------------------------------------

function storedRows(projectId: string, planRunId: string): RequestRow[] {
  return db().prepare("SELECT * FROM location_requests WHERE project_id = ? AND plan_run_id = ?").all(projectId, planRunId) as RequestRow[];
}

function checkRows(projectId: string): CheckRow[] {
  return db().prepare("SELECT * FROM director_runs WHERE project_id = ? AND stage = ? ORDER BY created_at DESC LIMIT 5").all(projectId, CHECK_STAGE) as CheckRow[];
}

function toCheck(row: CheckRow): LocationCheckRun {
  const result = parseJson<CheckResult>(row.plan_json);
  return {
    id: row.id, status: row.status, activity: activity.get(row.id) ?? null, summary: result?.summary ?? [], report: row.report,
    readyToProduce: result?.readyToProduce ?? null, storyUnchanged: row.story_changed === null ? null : !row.story_changed,
    error: row.error, startedAt: row.created_at, completedAt: row.completed_at,
  };
}

function storedState(row: RequestRow | undefined): StoredRequestState | null {
  return row ? { mode: row.mode, detail: row.detail, checkedSignature: row.checked_signature, checkedAt: row.checked_at, updatedAt: row.updated_at } : null;
}

function previewUrl(projectId: string, slug: string, candidates: LocationFileCandidate[]): string | null {
  const usable = candidates.filter((item) => item.supported && !item.issue);
  if (usable.length !== 1) return null;
  return `martini-asset://location/${projectId}/${slug}?v=${encodeURIComponent(usable[0].modifiedAt)}`;
}

/** Writes the location rows for the current plan so the database reflects what is on screen.
 *  Supplied and text-only rows are refreshed every time; requested rows keep their last check result. */
function syncRows(projectId: string, planRunId: string, plan: PlanData, project: ReturnType<typeof getProject>, requests: PlannedRequest[]): void {
  const database = db();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM location_requests WHERE project_id = ? AND plan_run_id <> ?").run(projectId, planRunId);
    const upsert = database.prepare(`INSERT INTO location_requests (id, project_id, plan_run_id, source, location_name, location_slug, section_numbers, broll_sections,
        file_name, expected_path, mode, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, source, location_slug) DO UPDATE SET location_name = excluded.location_name, section_numbers = excluded.section_numbers,
        broll_sections = excluded.broll_sections, file_name = excluded.file_name, expected_path = excluded.expected_path,
        mode = CASE WHEN location_requests.source = 'requested' THEN location_requests.mode ELSE excluded.mode END,
        reason = CASE WHEN location_requests.source = 'requested' THEN location_requests.reason ELSE excluded.reason END,
        updated_at = CASE WHEN location_requests.section_numbers = excluded.section_numbers AND (location_requests.source = 'requested' OR location_requests.mode = excluded.mode)
          AND location_requests.expected_path = excluded.expected_path THEN location_requests.updated_at ELSE excluded.updated_at END`);
    const timestamp = now();
    const keep: string[] = [];
    for (const asset of project.assets.filter((item) => item.role === "location")) {
      const slug = storageSlug(asset.displayName);
      keep.push(`supplied:${slug}`);
      upsert.run(randomUUID(), projectId, planRunId, "supplied", asset.displayName, slug, JSON.stringify(suppliedSections(plan, asset.displayName)), "[]",
        path.basename(asset.storedPath), asset.storedPath, asset.available ? "image_backed" : "failed",
        asset.available ? "Supplied reference" : "The project copy of this image is missing; replace it on Projects.", timestamp);
    }
    for (const request of requests) {
      if (!request.slug) continue;
      keep.push(`requested:${request.slug}`);
      upsert.run(randomUUID(), projectId, planRunId, "requested", request.name, request.slug, JSON.stringify(request.sections), JSON.stringify(request.brollSections),
        request.fileName, requestedTargetPath(project.projectPath, request.slug), "not_checked", null, timestamp);
    }
    for (const place of textOnlyLocations(plan)) {
      const slug = storageSlug(place.name);
      if (keep.includes(`text_only:${slug}`)) continue;
      keep.push(`text_only:${slug}`);
      upsert.run(randomUUID(), projectId, planRunId, "text_only", place.name, slug, JSON.stringify(place.kind === "performer" ? place.sections : []),
        JSON.stringify(place.kind === "broll" ? place.sections : []), null, "", "text_only", place.reason, timestamp);
    }
    const rows = database.prepare("SELECT id, source, location_slug FROM location_requests WHERE project_id = ?").all(projectId) as { id: string; source: string; location_slug: string }[];
    for (const row of rows) if (!keep.includes(`${row.source}:${row.location_slug}`)) database.prepare("DELETE FROM location_requests WHERE id = ?").run(row.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function locationsOverview(projectId: unknown): Promise<LocationsOverview> {
  const project = getProject(projectId);
  const plans = await planOverview(project.id);
  const plan = plans.plan;
  const planRunId = plans.planRun?.id ?? null;
  const folder = locationsFolder(project.projectPath);
  const requests = plan ? plannedRequests(plan) : [];
  const slugs = requests.map((item) => item.slug).filter((slug): slug is string => Boolean(slug));
  const { scan, error: scanError } = project.folderExists
    ? await scanFolder(project.projectPath, slugs, slugs.length > 0)
    : { scan: scanLocationFolder([], slugs), error: `The project folder is missing: ${project.projectPath}.` };
  if (plan && planRunId) syncRows(project.id, planRunId, plan, project, requests);
  const rows = plan && planRunId ? storedRows(project.id, planRunId) : [];

  const supplied: SuppliedLocationStatus[] = project.assets.filter((asset) => asset.role === "location").map((asset) => ({
    assetId: asset.id, name: asset.displayName, sections: suppliedSections(plan, asset.displayName), previewUrl: asset.previewUrl, available: asset.available,
    mode: asset.available ? "image_backed" : "failed",
    reason: asset.available ? "Supplied reference — passed to MiniMax as an image." : "The project copy of this image is missing. Replace it on Projects.",
  }));

  const requested: RequestedLocationStatus[] = requests.map((request) => {
    if (!request.slug) {
      return {
        name: request.name, slug: "", fileName: "", expectedPath: "", sections: request.sections, brollSections: request.brollSections, storyNote: request.storyNote,
        mode: "failed", modeLabel: "cannot be requested", passedToMiniMax: false, candidates: [], changedSinceCheck: false, checkedAt: null, updatedAt: null, previewUrl: null,
        reason: "This name has no letters or numbers, so no file name can be made for it. Reroll the plan on the Plan page.",
      };
    }
    const row = rows.find((item) => item.source === "requested" && item.location_slug === request.slug);
    const candidates = scan.bySlug.get(request.slug) ?? [];
    return {
      name: request.name, slug: request.slug, fileName: request.fileName, expectedPath: requestedTargetPath(project.projectPath, request.slug),
      sections: request.sections, brollSections: request.brollSections, storyNote: request.storyNote, candidates,
      ...describeRequest(request.fileName, storedState(row), candidates),
      checkedAt: row?.checked_at ?? null, updatedAt: row?.updated_at ?? null, previewUrl: previewUrl(project.id, request.slug, candidates),
    };
  });

  const latest = checkRows(project.id)[0] ?? null;
  const planActive = plans.latestRun?.status === "queued" || plans.latestRun?.status === "running";
  const blockers: string[] = [];
  if (!plan) blockers.push("There is no director plan yet. Create one on the Plan page first.");
  if (planActive) blockers.push("A director plan is being made. Check for images when it finishes.");
  if (!project.folderExists) blockers.push(`The project folder is missing: ${project.projectPath}.`);
  if (latest && (latest.status === "queued" || latest.status === "running")) blockers.push("Already checking for images.");
  if (requested.some((item) => !item.slug)) blockers.push("The plan requests a location without a usable file name. Reroll the plan.");

  const backed = requested.filter((item) => item.passedToMiniMax).length;
  const suppliedReady = supplied.filter((item) => item.available).length;
  return {
    projectId: project.id, projectName: project.name, folder, folderError: scanError,
    plan: plan && planRunId ? { runId: planRunId, durationSeconds: plan.durationSeconds, bpm: plan.bpm, sectionCount: plan.sections.length, stale: plans.freshness.state === "stale" } : null,
    supplied, requested, textOnly: plan ? textOnlyLocations(plan) : [], unrecognizedFiles: scan.unrecognized,
    counts: {
      imageBacked: suppliedReady + backed, performerTotal: supplied.length + requested.length,
      stillNeeded: requested.length - backed, failures: requested.filter((item) => item.mode === "failed" && !item.changedSinceCheck).length + (supplied.length - suppliedReady),
    },
    ready: Boolean(plan) && requested.every((item) => item.passedToMiniMax),
    latestCheck: latest ? toCheck(latest) : null, blockers,
  };
}

// ----- Small actions ---------------------------------------------------------------------------------------

/** The requested location a slug names in the current plan; anything else is refused. */
async function requestFor(projectId: unknown, slug: unknown): Promise<{ overview: LocationsOverview; request: RequestedLocationStatus; projectPath: string }> {
  if (typeof slug !== "string" || !slug) throw new Error("Unknown location.");
  const overview = await locationsOverview(projectId);
  const request = overview.requested.find((item) => item.slug === slug);
  if (!request) throw new Error("That location is not requested by the current plan.");
  return { overview, request, projectPath: projectIdentity(overview.projectId).projectPath };
}

export async function requestedFileNameFor(projectId: unknown, slug: unknown): Promise<string> {
  return (await requestFor(projectId, slug)).request.fileName;
}

/** The project's locations folder, created if needed. Only this folder is ever opened. */
export async function locationFolderFor(projectId: unknown): Promise<string> {
  const project = getProject(projectId);
  if (!project.folderExists) throw new Error(`The project folder is missing: ${project.projectPath}.`);
  const folder = locationsFolder(project.projectPath);
  try { await fs.mkdir(folder, { recursive: true }); }
  catch (error) { throw new Error(`Could not create ${folder}: ${error instanceof Error ? error.message : String(error)}`); }
  return folder;
}

/** Resolves a thumbnail request to the single matching image inside the project's locations folder. */
export async function locationPreviewFile(projectId: string, slug: string): Promise<string | null> {
  try {
    const project = getProject(projectId);
    const folder = locationsFolder(project.projectPath);
    const { scan } = await scanFolder(project.projectPath, [slug], false);
    const usable = (scan.bySlug.get(slug) ?? []).filter((item) => item.supported && !item.issue);
    if (usable.length !== 1) return null;
    const file = path.join(folder, usable[0].fileName);
    return isInside(folder, file) ? file : null;
  } catch { return null; }
}

// ----- Placing an image ------------------------------------------------------------------------------------

/** Copies a user-chosen or dropped image to the request's exact file name (<slug>.png). PNGs are copied byte for byte;
 *  JPG/WEBP/BMP are converted to PNG so the name stays deterministic. Existing images are only moved aside with `replace`. */
export async function placeLocationImage(projectId: unknown, slug: unknown, source: string | undefined, replace: boolean): Promise<LocationPlaceResult> {
  const { request, projectPath, overview } = await requestFor(projectId, slug);
  if (!source) return { overview, placed: null, cancelled: true, replacedFiles: [] };
  if (overview.latestCheck && (overview.latestCheck.status === "queued" || overview.latestCheck.status === "running")) {
    throw new Error("Wait for the current image check to finish before adding an image.");
  }
  if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("Martini Shot could not read that file's location.");
  const ext = path.extname(source).toLowerCase();
  if (!LOCATION_IMAGE_EXTENSIONS.includes(ext)) throw new Error(`Location images must be PNG, JPG, WEBP, or BMP files (got ${ext || "no extension"}).`);
  let stat;
  try { stat = await fs.stat(source); } catch { throw new Error(`The file no longer exists: ${source}`); }
  if (!stat.isFile()) throw new Error(`${source} is not a regular file.`);
  if (stat.size === 0) throw new Error(`${path.basename(source)} is empty.`);
  if (stat.size > MAX_LOCATION_IMAGE_BYTES) throw new Error(`${path.basename(source)} is larger than the 200 MB limit.`);

  const folder = await locationFolderFor(overview.projectId);
  const target = requestedTargetPath(projectPath, request.slug);
  const existing = request.candidates.map((item) => path.join(folder, item.fileName));
  if (existing.some((file) => path.resolve(file).toLowerCase() === path.resolve(source).toLowerCase())) {
    throw new Error(`${path.basename(source)} is already in the drop folder. Click Check for images.`);
  }
  if (existing.length && !replace) {
    throw new Error(`${request.name} already has ${existing.map((file) => path.basename(file)).join(", ")} in the drop folder. Use Replace image to swap it.`);
  }

  let bytes: Buffer;
  try { bytes = await fs.readFile(source); } catch (error) { throw new Error(`Could not read ${source}: ${error instanceof Error ? error.message : String(error)}`); }
  const kind = sniffImage(bytes.subarray(0, 16));
  if (!kind) throw new Error(`${path.basename(source)} is not a readable PNG, JPG, WEBP, or BMP image.`);
  const decoded = nativeImage.createFromBuffer(bytes);
  if (decoded.isEmpty()) {
    throw new Error(kind === "png" || kind === "jpeg"
      ? `${path.basename(source)} could not be decoded; the file may be damaged. Re-save it and try again.`
      : `Martini Shot could not convert this ${kind.toUpperCase()} to PNG. Save it as PNG or JPG first, or put it in the drop folder yourself as ${request.slug}.${kind}.`);
  }
  const output = kind === "png" ? bytes : decoded.toPNG();

  // Move earlier matching images aside first (never deleted), so the resolver sees exactly one file afterwards.
  const replacedFiles: string[] = [];
  if (existing.length) {
    const aside = path.join(folder, REPLACED_FOLDER);
    await fs.mkdir(aside, { recursive: true });
    const stamp = now().replace(/[:.]/g, "-");
    for (const file of existing) {
      const destination = path.join(aside, `${path.parse(file).name}-${stamp}${path.extname(file)}`);
      if (!isInside(folder, file) || !isInside(aside, destination)) throw new Error("Refusing to move files outside the locations folder.");
      await fs.rename(file, destination);
      replacedFiles.push(path.basename(file));
    }
  }
  const partial = `${target}.partial`;
  try {
    await fs.writeFile(partial, output, { flag: "wx" });
    await fs.rename(partial, target);
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new Error(code === "EEXIST" ? "Another copy is in progress. Try again in a moment." : `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  db().prepare("INSERT INTO project_reports (id, project_id, category, body, data, created_at) VALUES (?, ?, 'location_image_added', ?, ?, ?)")
    .run(randomUUID(), overview.projectId, `${request.name}: ${path.basename(source)} saved as ${path.basename(target)}${replacedFiles.length ? ` (moved aside: ${replacedFiles.join(", ")})` : ""}`,
      JSON.stringify({ source, target, converted: kind !== "png", replacedFiles }), now());
  notify(overview.projectId);
  return { overview: await locationsOverview(overview.projectId), placed: path.basename(target), cancelled: false, replacedFiles };
}

// ----- Check for images ------------------------------------------------------------------------------------

function setActivity(runId: string, projectId: string, phase: NonNullable<LocationCheckRun["activity"]>["phase"], queuePosition?: number): void {
  const previous = activity.get(runId);
  if (previous?.phase === phase && previous.queuePosition === queuePosition) return;
  activity.set(runId, { phase, since: previous?.phase === phase ? previous.since : now(), queuePosition });
  notify(projectId);
}

/** Starts Check for images in the background and returns at once. Progress and the result are announced through onChange. */
export async function startLocationCheck(projectId: unknown): Promise<LocationsOverview> {
  const overview = await locationsOverview(projectId);
  if (overview.blockers.length) throw new Error(overview.blockers.join(" "));
  const comfy = await comfyStatus();
  if (!comfy.connected) {
    throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI, wait until it has finished loading, then click Check for images again. Nothing was changed. (${comfy.message})`);
  }
  const runId = randomUUID();
  db().prepare("INSERT INTO director_runs (id, project_id, stage, settings, kind, status, created_at) VALUES (?, ?, ?, ?, 'check', 'queued', ?)")
    .run(runId, overview.projectId, CHECK_STAGE, JSON.stringify({ planRunId: overview.plan!.runId }), now());
  activity.set(runId, { phase: "waiting", since: now() });
  void serializeComfyWork(() => executeCheck(runId, overview.projectId, overview.plan!.runId, comfy.endpoint)).catch(() => undefined);
  return locationsOverview(overview.projectId);
}

function readableFailure(error: unknown, endpoint: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|ECONNRESET|aborted|network/i.test(message)) {
    return `Lost contact with ComfyUI at ${endpoint}. Start ComfyUI again, then click Check for images. The plan and the previous location results are unchanged.`;
  }
  return message;
}

async function readStoryPlan(file: string): Promise<{ bytes: Buffer; raw: RawStoryPlan }> {
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); } catch { throw new Error(`${file} is missing. Create the director plan again on the Plan page.`); }
  try { return { bytes, raw: JSON.parse(bytes.toString("utf-8")) as RawStoryPlan }; }
  catch { throw new Error(`${file} could not be read. Create the director plan again on the Plan page.`); }
}

const sameNames = (a: string[], b: string[]) => JSON.stringify(a.map((item) => item.toLowerCase())) === JSON.stringify(b.map((item) => item.toLowerCase()));

async function executeCheck(runId: string, projectId: string, planRunId: string, endpoint: string): Promise<void> {
  const update = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db().prepare(`UPDATE director_runs SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => fields[key]) as never[], runId);
  };
  try {
    update({ status: "running" });
    const project = projectIdentity(projectId);
    const plans = await planOverview(projectId);
    if (!plans.plan || plans.planRun?.id !== planRunId) throw new Error("The director plan changed while this check was waiting. Click Check for images again.");
    const plan = plans.plan;

    // The cached story on disk must be the plan Martini Shot shows; otherwise the resolver would check a different story's locations.
    const storyFile = path.join(project.projectPath, "story_plan.json");
    const before = await readStoryPlan(storyFile);
    const onDisk = parseStoryPlan(before.raw, { projectPath: project.projectPath, suppliedLocations: suppliedLocationNames(projectId), report: "" });
    const planned = plan.requestedLocations.map((item) => item.name);
    if (storySignature(onDisk) !== storySignature(plan) || !sameNames(onDisk.requestedLocations.map((item) => item.name), planned)) {
      throw new Error(`${storyFile} no longer matches the plan shown in Martini Shot (it may have been re-planned directly in ComfyUI). Run Create director plan on the Plan page so both agree; nothing was checked.`);
    }
    const storyHash = storyFileHash(before.bytes);

    setActivity(runId, projectId, "saving_project");
    const saveProblem = await ensureComfyProjectSaved(projectId);
    if (saveProblem) throw new Error(`The project could not be saved through ComfyUI, so the resolver cannot open it: ${saveProblem}`);

    const resolvedFile = path.join(project.projectPath, "resolved_plan.json");
    const resolvedBefore = existsSync(resolvedFile) ? (await fs.stat(resolvedFile)).mtimeMs : 0;
    const jobId = randomUUID();
    update({ comfy_job_id: jobId });
    const run = await runWorkflowTemplate(development, "03-resolve-locations.json", resolveWorkflowValues(project.slug), projectId, undefined, {
      jobId, onProgress: (progress: WorkflowProgress) => setActivity(runId, projectId, progress.phase, progress.queuePosition),
    });

    const report = previewText(run.outputs, "report");
    const readyText = previewText(run.outputs, "ready_to_produce");
    if (!report) throw new Error("ComfyUI finished, but the Resolve Locations report was not in its results. Location states were not changed.");
    update({ report });

    // Plan stability: the resolver must never have touched the cached story.
    const after = await readStoryPlan(storyFile);
    const storyUnchanged = storyFileHash(after.bytes) === storyHash;
    update({ story_changed: storyUnchanged ? 0 : 1 });
    if (!storyUnchanged) throw new Error(`${storyFile} changed during the check. Location states were not updated; open the Plan page to see the current plan.`);

    // The resolver must have written resolved_plan.json for this story in this run.
    const resolvedAfter = existsSync(resolvedFile) ? (await fs.stat(resolvedFile)).mtimeMs : 0;
    if (!resolvedAfter || resolvedAfter <= resolvedBefore) {
      throw new Error(`ComfyUI finished, but ${resolvedFile} was not written by this run. Check that the ComfyUI output folder in Settings belongs to the running ComfyUI.`);
    }
    const resolved = parseJson<{ requested_locations?: unknown; missing_locations?: unknown }>(await fs.readFile(resolvedFile, "utf-8"));
    const resolvedRequests = Array.isArray(resolved?.requested_locations) ? resolved!.requested_locations.map(String) : [];
    const missing = Array.isArray(resolved?.missing_locations) ? resolved!.missing_locations.map(String) : null;
    if (!missing || !sameNames(resolvedRequests, planned)) {
      throw new Error("ComfyUI resolved a different set of locations than the current plan (it may have used an older copy of the story). Click Check for images again.");
    }

    const lines = parseResolveReport(report, planned);
    const requests = plannedRequests(plan);
    const { scan } = await scanFolder(project.projectPath, requests.map((item) => item.slug).filter((slug): slug is string => Boolean(slug)), true);
    const timestamp = now();
    const summary: string[] = [];
    const raw: Record<string, ResolvedLine | null> = {};
    db().exec("BEGIN");
    try {
      for (const request of requests) {
        if (!request.slug) continue;
        // Names sharing one file name resolve identically; use the first reported line.
        const names = plan.requestedLocations.map((item) => item.name).filter((name) => name.toLowerCase() === request.name.toLowerCase() || storageSlug(name) === request.slug);
        const line = names.map((name) => lines.get(name)).find(Boolean);
        raw[request.name] = line ?? null;
        let mode: LocationStateMode = line?.mode ?? "failed";
        const isMissing = names.some((name) => missing.some((item) => item.toLowerCase() === name.toLowerCase()));
        // resolved_plan.json is the source of truth for production: never call a location image-backed that it lists as missing.
        if (mode === "image_backed" && isMissing) mode = "failed";
        if (mode !== "image_backed" && !isMissing) mode = "failed";
        summary.push(shortReportLine(request.name, line));
        const candidates = scan.bySlug.get(request.slug) ?? [];
        const detail = line?.detail ?? "not in the resolver report";
        const reason = describeRequest(request.fileName, { mode, detail, checkedSignature: candidateSignature(candidates), checkedAt: timestamp, updatedAt: timestamp }, candidates).reason;
        db().prepare(`UPDATE location_requests SET mode = ?, reason = ?, detail = ?, checked_signature = ?, check_run_id = ?, checked_at = ?, updated_at = ?
          WHERE project_id = ? AND plan_run_id = ? AND source = 'requested' AND location_slug = ?`)
          .run(mode, reason, detail, candidateSignature(candidates), runId, timestamp, timestamp, projectId, planRunId, request.slug);
      }
      const readyToProduce = readyText === null ? !missing.length : readyText.trim().toLowerCase() === "true";
      const result: CheckResult = { summary: summary.length ? summary : ["No performer-location images were requested."], readyToProduce };
      update({ status: "complete", completed_at: timestamp, plan_json: JSON.stringify(result), error: null });
      db().prepare("INSERT INTO project_reports (id, project_id, category, body, data, run_id, created_at) VALUES (?, ?, 'location_check', ?, ?, ?, ?)")
        .run(randomUUID(), projectId, result.summary.join("\n"), JSON.stringify({ report, readyToProduce: readyText, missing, lines: raw, outputs: run.outputs, comfyJobId: jobId }), runId, timestamp);
      db().prepare(`UPDATE martini_projects SET status = ?, updated_at = ? WHERE id = ? AND status IN ('planned', 'needs_location_images', 'ready_to_produce')`)
        .run(readyToProduce ? "ready_to_produce" : "needs_location_images", timestamp, projectId);
      db().exec("COMMIT");
    } catch (error) {
      db().exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const message = readableFailure(error, endpoint);
    update({ status: "failed", error: message, completed_at: now() });
    db().prepare("INSERT INTO project_reports (id, project_id, category, body, run_id, created_at) VALUES (?, ?, 'location_check_error', ?, ?, ?)")
      .run(randomUUID(), projectId, message, runId, now());
  } finally {
    activity.delete(runId);
    notify(projectId);
  }
}
