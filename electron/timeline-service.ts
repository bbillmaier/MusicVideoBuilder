// The song timeline on Plan: sections, beats and shot cuts, the no-LLM song analysis that lets it show before a director
// plan exists, and the user's saved timeline (timeline.json), which owns all timing once it exists. Owned by Electron
// main; the renderer reaches it through typed IPC.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SongTimeline, TimelineDraft, TimelineSaveImpact } from "./contracts";
import { comfyStatus, runWorkflowTemplate, serializeComfyWork } from "./comfy-client";
import { directorLlmOptions, planOverview, planSeed, refreshPlanFromFile } from "./plan-service";
import { previewText } from "./plan-rules";
import { currentPackageRow, produceOverview } from "./production-service";
import { productionBusy, timelineApplying } from "./production-lock";
import { ensureComfyProjectSaved, getProject, projectIdentity } from "./project-service";
import { validateDraft } from "./timeline-edit";
import { packageShots, parseAnalysis, previewCuts, sceneOf, timelineSections, type SongAnalysis } from "./timeline-rules";

const SONG_ANALYSIS_FILE = "song_analysis.json";
const SONG_ANALYSIS_VERSION = 1;
const TIMELINE_FILE = "timeline.json";
const TIMELINE_VERSION = 1;
const UNSAVED_FILE = "timeline.unsaved.json";

/** timeline.json, as the Martini Shot nodes read it (nodes._saved_timeline). */
type TimelineFile = {
  version: number; project: string; song: string; song_sha256: string; duration: number; bpm: number | null; beats: number[];
  sections: { start: number; end: number; role: string; label: string; energy: number; loudness: number }[];
  shots: TimelineDraft["shots"]; saved_at: string;
};

let development = false;
let notify: (projectId: string) => void = () => undefined;
/** Projects whose song analysis is queued or running, and the last failure per project. */
const running = new Set<string>();
const failures = new Map<string, string>();
const applyFailures = new Map<string, string>();
/** sha256 of song files, keyed by path, size and mtime, so the overview does not re-hash an unchanged song. */
const hashes = new Map<string, string>();

/** True while the song is being analyzed for this project (it writes song_analysis.json into the project folder). */
export function songAnalysisRunning(projectId: string): boolean {
  return running.has(projectId);
}

export function configureTimelineService(options: { isDevelopment: boolean; onChange(projectId: string): void }): void {
  development = options.isDevelopment;
  notify = options.onChange;
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, "utf-8")); } catch { return null; }
}

async function songHash(file: string): Promise<string | null> {
  let stat;
  try { stat = await fs.stat(file); } catch { return null; }
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  const known = hashes.get(key);
  if (known) return known;
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("data", (chunk) => digest.update(chunk)).on("end", () => resolve()).on("error", reject);
  });
  const value = digest.digest("hex");
  hashes.set(key, value);
  return value;
}

/** The project's stored song (written by ComfyUI) and its fingerprint; null hash when the file is not on this PC. */
async function songFile(projectPath: string): Promise<{ name: string; hash: string | null }> {
  const manifest = await readJson(path.join(projectPath, "project.json")) as { song?: unknown } | null;
  const name = typeof manifest?.song === "string" ? manifest.song : "song.flac";
  return { name, hash: await songHash(path.join(projectPath, "assets", name)) };
}

/** song_analysis.json when it was made from the project's current song file (the same check Plan Story makes). */
async function savedSongAnalysis(projectPath: string): Promise<{ analysis: SongAnalysis | null; note: string | null }> {
  const raw = await readJson(path.join(projectPath, SONG_ANALYSIS_FILE)) as { version?: unknown; song_sha256?: unknown; analysis?: unknown } | null;
  if (!raw) return { analysis: null, note: null };
  const analysis = raw.version === SONG_ANALYSIS_VERSION ? parseAnalysis(raw.analysis) : null;
  if (!analysis) return { analysis: null, note: `${SONG_ANALYSIS_FILE} could not be read. Analyze the song again.` };
  const { hash } = await songFile(projectPath);
  if (hash && hash !== raw.song_sha256) return { analysis: null, note: "The song changed since it was analyzed. Analyze the song again." };
  return { analysis, note: null };
}

/** The user's timeline.json when it is readable and made for the current song (the same check the nodes make). */
async function savedTimeline(projectPath: string): Promise<{ doc: TimelineFile | null; note: string | null }> {
  const raw = await readJson(path.join(projectPath, TIMELINE_FILE)) as TimelineFile | null;
  if (!raw) return { doc: null, note: null };
  const valid = raw.version === TIMELINE_VERSION && typeof raw.duration === "number" && Array.isArray(raw.sections) && raw.sections.length > 0
    && Array.isArray(raw.shots) && raw.shots.length > 0 && Array.isArray(raw.beats);
  if (!valid) return { doc: null, note: `${TIMELINE_FILE} could not be read, so the automatic cuts are shown. Edit and save the timeline again.` };
  const { hash } = await songFile(projectPath);
  if (hash && hash !== raw.song_sha256) return { doc: null, note: "The song changed since the timeline was saved, so the saved timeline is not used." };
  return { doc: raw, note: null };
}

function analysisFromTimeline(doc: TimelineFile): SongAnalysis {
  return {
    duration: doc.duration, bpm: doc.bpm, beats: doc.beats,
    sections: doc.sections.map((section) => ({ ...section, beatStart: 0, beatEnd: 0 })),
  };
}

/** Edits kept from a failed save, when they still fit the current song. */
async function unsavedDraft(projectPath: string): Promise<SongTimeline["unsaved"]> {
  const raw = await readJson(path.join(projectPath, UNSAVED_FILE)) as { song_sha256?: unknown; duration?: unknown; draft?: unknown; saved_at?: unknown } | null;
  if (!raw || typeof raw.duration !== "number") return null;
  const { hash } = await songFile(projectPath);
  if (hash && hash !== raw.song_sha256) return null;
  try { return { draft: validateDraft(raw.draft, raw.duration, 1000), savedAt: typeof raw.saved_at === "string" ? raw.saved_at : "" }; }
  catch { return null; }
}

/** Forgets edits kept from a failed save (Discard on the restore notice, or after they are restored and saved). */
export async function discardUnsavedTimeline(projectId: unknown): Promise<SongTimeline> {
  const project = projectIdentity(projectId);
  await fs.rm(path.join(project.projectPath, UNSAVED_FILE), { force: true });
  applyFailures.delete(project.id);
  notify(project.id);
  return songTimeline(project.id);
}

export async function songTimeline(projectId: unknown): Promise<SongTimeline> {
  const project = getProject(projectId);
  const plans = await planOverview(project.id);
  const song = project.assets.find((asset) => asset.role === "song" && asset.available);
  const notes: string[] = [];

  // The saved timeline owns timing once it exists. Otherwise a director plan's own analysis comes first (every later
  // stage cuts from it, and legacy projects have only it), then the no-LLM song analysis.
  const saved = await savedTimeline(project.projectPath);
  if (saved.note) notes.push(saved.note);
  let analysis: SongAnalysis | null = saved.doc ? analysisFromTimeline(saved.doc) : null;
  let analysisSource: SongTimeline["analysisSource"] = saved.doc ? (plans.plan ? "plan" : "song") : "none";
  if (!analysis && plans.plan) {
    const raw = await readJson(path.join(project.projectPath, "story_plan.json")) as { analysis?: unknown } | null;
    analysis = parseAnalysis(raw?.analysis);
    if (analysis) analysisSource = "plan";
    else notes.push("story_plan.json has no readable song analysis, so the timeline cannot show the plan's sections.");
  }
  if (!analysis && !plans.plan) {
    const songAnalysis = await savedSongAnalysis(project.projectPath);
    analysis = songAnalysis.analysis;
    if (analysis) analysisSource = "song";
    if (songAnalysis.note) notes.push(songAnalysis.note);
  }

  const comfy = await comfyStatus();
  const busy = productionBusy();
  const planRunning = plans.latestRun?.status === "queued" || plans.latestRun?.status === "running";
  const applying = timelineApplying.has(project.id);
  const blocker = plans.plan ? "The director plan's song analysis is missing. Create director plan again to analyze the song."
    : !song ? "Add the project's song on Projects first."
      : project.missing.length ? `Starter assets are incomplete: ${project.missing.join(", ").toLowerCase()}. Add them on Projects.`
        : !comfy.connected ? `ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI to analyze the song.`
          : busy ? "ComfyUI is busy with another Martini Shot job. Analyze the song when it finishes."
            : null;
  const hasPackage = Boolean(plans.plan && currentPackageRow(project.id));
  const editReason = !analysis ? "Analyze the song first."
    : hasPackage ? "A prompt package exists, so the timeline is read-only for now. Editing a timeline that already has prompts and clips comes in a later update."
      : planRunning ? "A director plan is being made. Edit the timeline when it finishes."
        : applying ? "The saved timeline is being applied to the plan."
          : busy?.projectId === project.id ? "This project is busy in production. Edit the timeline when it finishes."
            : null;
  const planSections = (plans.plan?.sections ?? []).map((section) => ({ number: section.number, scene: sceneOf(section.scene), action: section.beat || null }));
  const base = {
    projectId: project.id, songUrl: song?.previewUrl ?? null, analysisSource, notes, planSections,
    cutSettings: {
      targetShotSeconds: plans.direction.targetShotSeconds, minShotSeconds: plans.direction.minShotSeconds,
      maxShotSeconds: plans.direction.maxShotSeconds, cutRateVsEnergy: plans.direction.cutRateVsEnergy,
      cutSeed: plans.plan?.cutSeed ?? null,
    },
    analysis: { running: running.has(project.id), error: failures.get(project.id) ?? null, canStart: !blocker && !running.has(project.id) && !plans.plan, blocker },
    edit: { allowed: !editReason, reason: editReason, applying, error: applyFailures.get(project.id) ?? null },
    unsaved: await unsavedDraft(project.projectPath),
  };
  if (!analysis) {
    return { ...base, duration: project.songDurationSeconds ?? 0, bpm: null, beats: [], sections: [], shots: [], shotSource: "none" };
  }

  // Sections: each one holds the story of the plan section with the same number when the plan was made on (or applied
  // from) these sections. A saved timeline whose sections no longer line up with the plan holds no story yet.
  let sections = timelineSections(analysis, plans.plan?.sections ?? null);
  if (saved.doc && plans.plan) {
    const aligned = plans.plan.sections.length === saved.doc.sections.length
      && plans.plan.sections.every((section, index) => Math.abs(section.start - saved.doc!.sections[index].start) < 0.05);
    if (!aligned) {
      sections = sections.map((section) => ({ ...section, origin: null, scene: null, action: null, phase: null }));
      notes.push("The director plan's sections don't match the saved timeline. Save the timeline again to apply it to the plan.");
    }
  }

  let shots: SongTimeline["shots"] = [];
  let shotSource: SongTimeline["shotSource"] = "preview";
  if (hasPackage) {
    const produce = await produceOverview(project.id);
    if (produce.clips.length && !produce.packageStale.length) {
      shots = packageShots(produce.clips);
      shotSource = "package";
    } else if (produce.packageStale.length) {
      notes.push("The prompt package was written from an earlier plan, so these are the cuts a new package would make.");
    }
  }
  if (shotSource === "preview" && saved.doc) {
    const doc = saved.doc;
    shots = doc.shots.map((shot, index) => {
      const end = index + 1 < doc.shots.length ? doc.shots[index + 1].start : doc.duration;
      const section = Math.max(1, sections.findIndex((item) => shot.start >= item.start - 1e-3 && shot.start < item.end - 1e-3) + 1);
      return {
        number: index + 1, start: shot.start, end, section, scene: shot.scene ?? sections[section - 1]?.scene ?? null,
        transition: index === 0 ? "Hard cut" : shot.transition, clips: [], override: { scene: shot.scene, transition: shot.transition },
      };
    });
    shotSource = "timeline";
    notes.push("Your saved timeline. Shots marked Auto get their scene type and transition from the plan and the director when the prompt package is written.");
  } else if (shotSource === "preview") {
    shots = previewCuts(analysis, base.cutSettings, (number) => sections[number - 1]?.scene ?? null);
    notes.push(plans.plan
      ? "Automatic cuts from your Direction timing settings. Long shots are split into render clips, and the director chooses the remaining scene types and transitions, when the prompt package is written."
      : "Automatic cuts from the song analysis and your Direction timing settings. The director plan adds scene types and actions.");
  }
  return { ...base, duration: analysis.duration, bpm: analysis.bpm, beats: analysis.beats, sections, shots, shotSource };
}

/** Starts the no-LLM song analysis (02a-analyze-song.json) in the background; follow it with the plan change event. */
export async function startSongAnalysis(projectId: unknown): Promise<SongTimeline> {
  const project = projectIdentity(projectId);
  const timeline = await songTimeline(project.id);
  if (!timeline.analysis.canStart) {
    throw new Error(timeline.analysis.blocker ?? (timeline.analysis.running ? "The song is already being analyzed." : "The director plan already includes the song analysis."));
  }
  running.add(project.id);
  failures.delete(project.id);
  void serializeComfyWork(async () => {
    try {
      const problem = await ensureComfyProjectSaved(project.id);
      if (problem) throw new Error(`The project could not be saved through ComfyUI, so there is no song to analyze yet: ${problem}`);
      const run = await runWorkflowTemplate(development, "02a-analyze-song.json", { project_name: project.slug }, project.id);
      if (!previewText(run.outputs, "report")) throw new Error("ComfyUI finished, but the Analyze Song report was not in its results.");
      const saved = await savedSongAnalysis(project.projectPath);
      if (!saved.analysis) throw new Error(saved.note ?? `ComfyUI finished, but ${path.join(project.projectPath, SONG_ANALYSIS_FILE)} was not written. Check that the ComfyUI output folder in Settings belongs to the running ComfyUI.`);
    } catch (error) {
      failures.set(project.id, withRestartHint(error));
    } finally {
      running.delete(project.id);
      notify(project.id);
    }
  }).catch(() => undefined);
  notify(project.id);
  return songTimeline(project.id);
}

function withRestartHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /MartiniShot(AnalyzeSong|ApplyTimeline)/.test(message) && /node|class|not found|unknown/i.test(message) && !/restart ComfyUI/i.test(message)
    ? `${message} Restart ComfyUI so it loads the updated Martini Shot nodes.` : message;
}

// ----- Saving ----------------------------------------------------------------------------------------------

async function checkedDraft(projectId: string, raw: unknown) {
  const timeline = await songTimeline(projectId);
  if (!timeline.edit.allowed) throw new Error(timeline.edit.reason ?? "The timeline can't be edited now.");
  const plans = await planOverview(projectId);
  const draft = validateDraft(raw, timeline.duration, plans.plan?.sections.length ?? 0);
  if (!plans.plan) draft.sections.forEach((section) => { section.origin = null; });
  const rewrite = draft.sections.map((section, index) => (section.origin === null ? index + 1 : 0)).filter(Boolean);
  const hasStory = Boolean(plans.plan && !plans.plan.rulesOnly);
  return { timeline, plans, draft, impact: { rewrite: plans.plan ? rewrite : [], usesLlm: hasStory && rewrite.length > 0, planExists: Boolean(plans.plan) } satisfies TimelineSaveImpact };
}

/** What Save timeline would do to the current plan; the Plan page shows it before asking to confirm. */
export async function timelineSaveImpact(projectId: unknown, raw: unknown): Promise<TimelineSaveImpact> {
  const project = projectIdentity(projectId);
  return (await checkedDraft(project.id, raw)).impact;
}

/** Saves the user's timeline. Without a plan it is only written; the next plan is made on it. With a plan, the plan is
 *  re-applied in the background (02c, or 02b with the LLM when sections were split, merged, created or deleted):
 *  story beats move with their sections and changed sections get new ones. `confirmed` must be true when the LLM runs. */
export async function saveTimeline(projectId: unknown, raw: unknown, confirmed: unknown): Promise<SongTimeline> {
  const project = projectIdentity(projectId);
  const { timeline, plans, draft, impact } = await checkedDraft(project.id, raw);
  if (impact.usesLlm && confirmed !== true) {
    throw new Error(`Saving rewrites the story of section${impact.rewrite.length === 1 ? "" : "s"} ${impact.rewrite.join(", ")} with the LLM. Confirm it first.`);
  }
  const song = await songFile(project.projectPath);
  if (!song.hash) throw new Error(`The project's song (${path.join(project.projectPath, "assets", song.name)}) is not on this PC, so the timeline can't be tied to it.`);
  let llm: string | null = null;
  if (plans.plan) {
    const comfy = await comfyStatus();
    if (!comfy.connected) throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI to apply the timeline to the plan; nothing was saved.`);
    if (impact.usesLlm) {
      const options = await directorLlmOptions();
      if (!options.selected) throw new Error(options.error || "No local director LLM is available in ComfyUI; nothing was saved.");
      llm = options.selected;
    }
  }

  const file = path.join(project.projectPath, TIMELINE_FILE);
  const previous = existsSync(file) ? await fs.readFile(file, "utf-8") : null;
  const doc: TimelineFile = {
    version: TIMELINE_VERSION, project: project.slug, song: song.name, song_sha256: song.hash, duration: timeline.duration, bpm: timeline.bpm,
    beats: timeline.beats, sections: draft.sections.map(({ origin: _origin, ...section }) => section), shots: draft.shots, saved_at: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(doc, null, 2), "utf-8");
  applyFailures.delete(project.id);
  const unsavedFile = path.join(project.projectPath, UNSAVED_FILE);
  // Written before the background apply, removed only when it succeeds: a failed save never loses the user's edits.
  await fs.writeFile(unsavedFile, JSON.stringify({ song_sha256: song.hash, duration: timeline.duration, draft, saved_at: doc.saved_at }, null, 2), "utf-8");
  if (!plans.plan) await fs.rm(unsavedFile, { force: true });
  if (!plans.plan) {
    notify(project.id);
    return songTimeline(project.id);
  }

  timelineApplying.add(project.id);
  const sources = draft.sections.map((section) => section.origin);
  void serializeComfyWork(async () => {
    try {
      const template = llm ? "02b-apply-timeline.json" : "02c-apply-timeline-timing.json";
      const run = await runWorkflowTemplate(development, template, {
        project_name: project.slug, section_sources: JSON.stringify(sources), seed: planSeed(project.id), ...(llm ? { director_llm: llm } : {}),
      }, project.id);
      const report = previewText(run.outputs, "report");
      if (!report) throw new Error("ComfyUI finished, but the Apply Timeline report was not in its results.");
      await refreshPlanFromFile(project.id, report);
      await fs.rm(unsavedFile, { force: true }).catch(() => undefined);
    } catch (error) {
      // story_plan.json is only written at the very end of the node, so the plan is unchanged: put the timeline back too.
      if (previous === null) await fs.rm(file, { force: true }).catch(() => undefined);
      else await fs.writeFile(file, previous, "utf-8").catch(() => undefined);
      applyFailures.set(project.id, `The timeline could not be applied to the plan, so it was not saved. Your edits are kept: use Restore edits to continue. ${withRestartHint(error)}`);
    } finally {
      timelineApplying.delete(project.id);
      notify(project.id);
    }
  }).catch(() => undefined);
  notify(project.id);
  return songTimeline(project.id);
}
