// Creative direction and director planning, owned by Electron main. The renderer reaches it only through typed IPC.
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DirectionRecord, PlanCacheResult, PlanData, PlanOverview, PlanRun, PlanRunStatus } from "./contracts";
import { comfyStatus, nodeInputOptions, runWorkflowTemplate, serializeComfyWork, type WorkflowProgress } from "./comfy-client";
import { db, getMachineSettings } from "./db";
import {
  DEFAULT_DIRECTION, MAX_SEED, assetFingerprint, cacheEvidence, cachedNodes, chooseDirectorLlm, parseStoryPlan, planFreshness, planInputs,
  planWorkflowValues, previewText, storySignature, validateDirection, type PlanInputs, type RawStoryPlan,
} from "./plan-rules";
import { productionBusy } from "./production-lock";
import { ensureComfyProjectSaved, getProject, projectAssetsForPlanning, projectIdentity, suppliedLocationNames } from "./project-service";

type DirectionRow = {
  project_id: string; creative_brief: string; story_wheel: number; min_locations: number; request_location_images: number;
  motif_weight: number; production_settings: string; plan_seed: number; updated_at: string | null;
};
type RunRow = {
  id: string; project_id: string; kind: "create" | "reroll" | null; status: PlanRunStatus; seed: number | null; settings: string;
  report: string | null; created_at: string; comfy_job_id: string | null; cache_result: PlanCacheResult | null; cache_details: string | null;
  story_changed: number | null; result_seed: number | null; plan_json: string | null; error: string | null; completed_at: string | null;
};

const PLAN_STAGE = "story_plan";
const LLM_LOADER = "MiniMaxH3PromptLLMLoader";
const now = () => new Date().toISOString();

let development = false;
let notify: (projectId: string) => void = () => undefined;
const activity = new Map<string, NonNullable<PlanRun["activity"]>>();

export function configurePlanService(options: { isDevelopment: boolean; onChange(projectId: string): void }): void {
  development = options.isDevelopment;
  notify = options.onChange;
  // A plan that was in progress when the app closed is no longer being watched.
  db().prepare(`UPDATE director_runs SET status = 'interrupted', completed_at = ?,
    error = 'Martini Shot was closed while this plan was running. ComfyUI may still have finished it; run Create director plan again (finished planning steps are reused from the director cache).'
    WHERE stage = ? AND status IN ('queued', 'running')`).run(now(), PLAN_STAGE);
}

// ----- Direction -------------------------------------------------------------------------------------------

function directionRow(projectId: string): DirectionRow {
  const existing = db().prepare("SELECT * FROM project_direction WHERE project_id = ?").get(projectId) as DirectionRow | undefined;
  if (existing) return existing;
  // A per-project seed, fixed until a deliberate reroll, so an unchanged Create director plan hits the director cache.
  db().prepare(`INSERT INTO project_direction (project_id, creative_brief, story_wheel, min_locations, request_location_images, motif_weight, plan_seed)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(projectId, DEFAULT_DIRECTION.creativeBrief, DEFAULT_DIRECTION.storyWheel ? 1 : 0, DEFAULT_DIRECTION.minLocations,
    DEFAULT_DIRECTION.requestLocationImages ? 1 : 0, DEFAULT_DIRECTION.motifWeight, randomInt(0, 2 ** 31));
  return db().prepare("SELECT * FROM project_direction WHERE project_id = ?").get(projectId) as DirectionRow;
}

function toDirection(row: DirectionRow): DirectionRecord {
  let saved: Partial<DirectionRecord> = {};
  try { saved = JSON.parse(row.production_settings || "{}") as Partial<DirectionRecord>; } catch { /* Existing projects retain defaults. */ }
  return {
    creativeBrief: row.creative_brief, storyWheel: Boolean(row.story_wheel), minLocations: row.min_locations,
    requestLocationImages: Boolean(row.request_location_images), motifWeight: row.motif_weight,
    danceStyle: saved.danceStyle ?? "K-Pop", targetShotSeconds: saved.targetShotSeconds ?? 8, minShotSeconds: saved.minShotSeconds ?? 3,
    maxShotSeconds: saved.maxShotSeconds ?? 10, cutRateVsEnergy: saved.cutRateVsEnergy ?? 0.5, brollAmount: saved.brollAmount ?? 0.3,
    performanceVsDance: saved.performanceVsDance ?? 0.4, freeformAmount: saved.freeformAmount ?? 0, locationVariety: saved.locationVariety ?? 0.5,
    chorusConsistency: saved.chorusConsistency ?? true, outfitChangeRate: saved.outfitChangeRate ?? 0.3, continueBias: saved.continueBias ?? 0.5,
    hardCutsChangeLocation: saved.hardCutsChangeLocation ?? true, lipSync: saved.lipSync ?? false,
    aspectRatio: saved.aspectRatio ?? "4:3", renderMegapixels: saved.renderMegapixels ?? 1,
    planSeed: row.plan_seed, updatedAt: row.updated_at,
  };
}

export function saveDirection(projectId: unknown, raw: unknown): Promise<PlanOverview> {
  const project = projectIdentity(projectId);
  const direction = validateDirection(raw);
  directionRow(project.id);
  const productionSettings = { danceStyle: direction.danceStyle, targetShotSeconds: direction.targetShotSeconds, minShotSeconds: direction.minShotSeconds,
    maxShotSeconds: direction.maxShotSeconds, cutRateVsEnergy: direction.cutRateVsEnergy, brollAmount: direction.brollAmount,
    performanceVsDance: direction.performanceVsDance, freeformAmount: direction.freeformAmount, locationVariety: direction.locationVariety,
    chorusConsistency: direction.chorusConsistency, outfitChangeRate: direction.outfitChangeRate, continueBias: direction.continueBias,
    hardCutsChangeLocation: direction.hardCutsChangeLocation, lipSync: direction.lipSync,
    aspectRatio: direction.aspectRatio, renderMegapixels: direction.renderMegapixels };
  db().prepare(`UPDATE project_direction SET creative_brief = ?, story_wheel = ?, min_locations = ?, request_location_images = ?, motif_weight = ?, production_settings = ?, updated_at = ?
    WHERE project_id = ?`).run(direction.creativeBrief, direction.storyWheel ? 1 : 0, direction.minLocations, direction.requestLocationImages ? 1 : 0,
    direction.motifWeight, JSON.stringify(productionSettings), now(), project.id);
  notify(project.id);
  return planOverview(project.id);
}

// ----- Overview --------------------------------------------------------------------------------------------

function runRows(projectId: string): RunRow[] {
  return db().prepare("SELECT * FROM director_runs WHERE project_id = ? AND stage = ? ORDER BY created_at DESC LIMIT 20").all(projectId, PLAN_STAGE) as RunRow[];
}

function runRow(id: string | null): RunRow | null {
  if (!id) return null;
  return (db().prepare("SELECT * FROM director_runs WHERE id = ? AND stage = ?").get(id, PLAN_STAGE) as RunRow | undefined) ?? null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function toRun(row: RunRow): PlanRun {
  const inputs = parseJson<PlanInputs>(row.settings);
  return {
    id: row.id, kind: row.kind === "reroll" ? "reroll" : "create", status: row.status, activity: activity.get(row.id) ?? null,
    cacheResult: row.cache_result, cacheDetails: parseJson<string[]>(row.cache_details) ?? [],
    storyChanged: row.story_changed === null ? null : Boolean(row.story_changed), seedRequested: row.seed, seedUsed: row.result_seed,
    directorLlm: inputs?.directorLlm ?? null, report: row.report, error: row.error, startedAt: row.created_at, completedAt: row.completed_at,
  };
}

async function currentInputs(projectId: string, direction: DirectionRecord, savedLlm?: string): Promise<PlanInputs> {
  const llm = savedLlm ?? (await getMachineSettings()).directorLlm;
  return planInputs(direction, llm, assetFingerprint(projectAssetsForPlanning(projectId)));
}

export async function planOverview(projectId: unknown): Promise<PlanOverview> {
  const project = getProject(projectId);
  const direction = toDirection(directionRow(project.id));
  const current = db().prepare("SELECT current_plan_run_id FROM martini_projects WHERE id = ?").get(project.id) as { current_plan_run_id: string | null };
  const planRow = runRow(current.current_plan_run_id);
  const latestRow = runRows(project.id)[0] ?? null;
  const plan = parseJson<PlanData>(planRow?.plan_json ?? null);
  const plannedInputs = parseJson<PlanInputs>(planRow?.settings ?? null);
  const settingsLlm = (await getMachineSettings()).directorLlm;
  const freshness = planFreshness(plan ? plannedInputs : null, await currentInputs(project.id, direction, comparableLlm(settingsLlm, plannedInputs?.directorLlm)));
  const blockers: string[] = [];
  if (!project.folderExists) blockers.push(`The project folder is missing: ${project.projectPath}.`);
  if (project.missing.length) blockers.push(`Starter assets are incomplete: ${project.missing.join(", ").toLowerCase()}. Add them on Projects.`);
  if (latestRow && (latestRow.status === "queued" || latestRow.status === "running")) blockers.push("A director plan is already being made.");
  const production = productionBusy();
  if (production?.projectId === project.id) {
    blockers.push(production.kind === "render"
      ? "Clips are rendering from the current plan. Use Stop after current clip on Produce and let it finish before planning again."
      : production.kind === "stitch" ? "The final video is being stitched from the current plan. Wait for it to finish."
        : "A prompt package is being written from the current plan. Wait for it to finish.");
  }
  return {
    projectId: project.id, projectName: project.name, direction, freshness, plan, planRun: planRow ? toRun(planRow) : null,
    latestRun: latestRow ? toRun(latestRow) : null, blockers,
  };
}

// ----- Director LLM ----------------------------------------------------------------------------------------

/** Saved setting -> the Prompt LLM Loader option it resolved to on the running ComfyUI (last seen). */
const resolvedLlmCache = new Map<string, string>();

/** The loader option the saved Settings value stands for, without asking ComfyUI (the overview must work offline).
 *  An old free-text value that is not a loader option is assumed unchanged since the plan was made. */
function comparableLlm(saved: string, planned: string | undefined): string {
  return resolvedLlmCache.get(saved) ?? (saved.includes("|") ? saved : planned ?? saved);
}

export async function directorLlmOptions(): Promise<{ options: string[]; selected: string | null; error: string | null }> {
  const saved = (await getMachineSettings()).directorLlm;
  try {
    const options = (await nodeInputOptions(LLM_LOADER, "model")).filter((option) => option.includes("|"));
    const selected = chooseDirectorLlm(saved, options);
    if (selected) resolvedLlmCache.set(saved, selected);
    return { options, selected, error: options.length ? null : "ComfyUI found no local LLM it can run in models\\text_encoders." };
  } catch (error) {
    return { options: [], selected: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// ----- Planning --------------------------------------------------------------------------------------------

function readableFailure(error: unknown, endpoint: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|ECONNRESET|aborted|network/i.test(message)) {
    return `Lost contact with ComfyUI at ${endpoint}. If ComfyUI stopped or crashed, start it again and run Create director plan; finished planning steps are reused from the director cache.`;
  }
  return message;
}

function setActivity(runId: string, projectId: string, phase: NonNullable<PlanRun["activity"]>["phase"], queuePosition?: number): void {
  const previous = activity.get(runId);
  if (previous?.phase === phase && previous.queuePosition === queuePosition) return;
  activity.set(runId, { phase, since: previous?.phase === phase ? previous.since : now(), queuePosition });
  notify(projectId);
}

/** Starts Create director plan (`reroll` false) or Reroll plan (`reroll` true) in the background and returns at once.
 *  Progress, success, and failure are persisted in director_runs and announced through `onChange`. */
export async function startPlan(projectId: unknown, reroll: boolean): Promise<PlanOverview> {
  const overview = await planOverview(projectId);
  if (overview.blockers.length) throw new Error(overview.blockers.join(" "));
  const comfy = await comfyStatus();
  if (!comfy.connected) {
    throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI, wait until it has finished loading, then try again. (${comfy.message})`);
  }
  const runId = randomUUID();
  const inputs = await currentInputs(overview.projectId, overview.direction);
  db().prepare(`INSERT INTO director_runs (id, project_id, stage, seed, settings, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`)
    .run(runId, overview.projectId, PLAN_STAGE, inputs.seed, JSON.stringify(inputs), reroll ? "reroll" : "create", now());
  activity.set(runId, { phase: "waiting", since: now() });
  void serializeComfyWork(() => executePlan(runId, overview.projectId, reroll, comfy.endpoint)).catch(() => undefined);
  return planOverview(overview.projectId);
}

async function executePlan(runId: string, projectId: string, reroll: boolean, endpoint: string): Promise<void> {
  const update = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db().prepare(`UPDATE director_runs SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => fields[key]) as never[], runId);
  };
  try {
    db().prepare("UPDATE director_runs SET status = 'running' WHERE id = ?").run(runId);
    const project = projectIdentity(projectId);

    setActivity(runId, projectId, "saving_project");
    const saveProblem = await ensureComfyProjectSaved(projectId);
    if (saveProblem) throw new Error(`The project could not be saved through ComfyUI, so there is nothing to plan from yet: ${saveProblem}`);

    // Inputs are re-read now: the direction may have been edited while the job waited for the queue.
    const direction = toDirection(directionRow(projectId));
    const llms = await directorLlmOptions();
    if (!llms.selected) throw new Error(llms.error || "No local director LLM is available in ComfyUI.");
    const inputs = await currentInputs(projectId, direction, llms.selected);
    update({ seed: inputs.seed, settings: JSON.stringify(inputs) });

    const previousRow = runRow((db().prepare("SELECT current_plan_run_id FROM martini_projects WHERE id = ?").get(projectId) as { current_plan_run_id: string | null }).current_plan_run_id);
    const previousPlan = parseJson<PlanData>(previousRow?.plan_json ?? null);
    const planFile = path.join(project.projectPath, "story_plan.json");
    const before = existsSync(planFile) ? statSync(planFile).mtimeMs : 0;
    const jobId = randomUUID();
    update({ comfy_job_id: jobId });

    const run = await runWorkflowTemplate(development, "02-plan-story.json", planWorkflowValues(project.slug, inputs, reroll), projectId, undefined, {
      jobId,
      onProgress: (progress: WorkflowProgress) => setActivity(runId, projectId, progress.phase, progress.queuePosition),
    });

    const report = previewText(run.outputs, "report");
    if (!report) throw new Error("ComfyUI finished, but the Plan Story report was not in its results. Nothing was changed in Martini Shot.");
    update({ report });
    db().prepare("INSERT INTO project_reports (id, project_id, category, body, run_id, created_at) VALUES (?, ?, 'story_plan', ?, ?, ?)")
      .run(randomUUID(), projectId, report, runId, now());

    // Evidence that this run wrote the plan: story_plan.json changed, or ComfyUI says it reused its in-memory result.
    const reusedByComfy = cachedNodes(run.messages).includes("plan");
    const after = existsSync(planFile) ? statSync(planFile).mtimeMs : 0;
    // A recovered remote file has the remote filesystem timestamp. Its clock may
    // be behind this PC, so timestamp ordering is not valid cross-machine evidence.
    const remoteRun = (await getMachineSettings()).executionDestination === "remote";
    if (!after || (!remoteRun && !reusedByComfy && after <= before)) {
      throw new Error(`ComfyUI finished, but ${planFile} was not written by this run. Check that the ComfyUI output folder in Settings belongs to the running ComfyUI.`);
    }
    let raw: RawStoryPlan;
    try { raw = JSON.parse(await fs.readFile(planFile, "utf-8")) as RawStoryPlan; }
    catch (error) { throw new Error(`Could not read ${planFile}: ${error instanceof Error ? error.message : String(error)}`); }
    if (raw.project && raw.project !== project.slug) throw new Error(`${planFile} belongs to project "${String(raw.project)}", not "${project.slug}".`);
    const plan = parseStoryPlan(raw, { projectPath: project.projectPath, suppliedLocations: suppliedLocationNames(projectId), report });

    const evidence = cacheEvidence(report);
    const details = reusedByComfy ? [...evidence.details, "ComfyUI reused its in-memory result for Plan Story"] : evidence.details;
    const resultSeed = plan.seed;
    if (resultSeed < 0 || resultSeed > MAX_SEED) throw new Error(`story_plan.json has an invalid seed (${resultSeed}).`);
    // After a reroll the planner chose a new seed: keep it, so the next unchanged Create director plan reuses this plan.
    const finalInputs: PlanInputs = { ...inputs, seed: resultSeed };
    const storyChanged = previousPlan ? storySignature(previousPlan) !== storySignature(plan) : null;
    db().exec("BEGIN");
    try {
      update({
        status: "complete", completed_at: now(), cache_result: evidence.result, cache_details: JSON.stringify(details),
        story_changed: storyChanged === null ? null : storyChanged ? 1 : 0, result_seed: resultSeed, plan_json: JSON.stringify(plan),
        settings: JSON.stringify(finalInputs), error: null,
      });
      db().prepare("UPDATE project_direction SET plan_seed = ? WHERE project_id = ?").run(resultSeed, projectId);
      db().prepare("UPDATE martini_projects SET current_plan_run_id = ?, status = 'planned', updated_at = ? WHERE id = ?").run(runId, now(), projectId);
      db().exec("COMMIT");
    } catch (error) {
      db().exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const message = readableFailure(error, endpoint);
    update({ status: "failed", error: message, completed_at: now() });
    db().prepare("INSERT INTO project_reports (id, project_id, category, body, run_id, created_at) VALUES (?, ?, 'story_plan_error', ?, ?, ?)")
      .run(randomUUID(), projectId, message, runId, now());
  } finally {
    activity.delete(runId);
    notify(projectId);
  }
}

/** A specific plan run (e.g. the one a prompt package was written from), with its saved plan and the inputs it was made from. */
export function planRunById(id: string | null | undefined): { run: PlanRun; plan: PlanData | null; inputs: PlanInputs | null } | null {
  const row = runRow(id ?? null);
  if (!row) return null;
  return { run: toRun(row), plan: parseJson<PlanData>(row.plan_json), inputs: parseJson<PlanInputs>(row.settings) };
}
