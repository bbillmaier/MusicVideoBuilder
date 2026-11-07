// Pure final-stitch, results, and director-report rules (Ticket 06). No Electron or SQLite imports so they can be unit-tested
// with plain Node. Everything here reads what the nodes actually write:
//  - MiniMaxH3StitchSongSegments (behind Martini Shot Finalize Video): "Stitched N segments into <path>",
//    "<w>x<h> <codec> at <fps> fps, original song audio", and "TEST STITCH of clips …" when clips were missing;
//  - Write Prompt Package's "Polish:" lines, e.g. "required event 'lightning strike': section(s) 13";
//  - the MP4 header (moov/mvhd) for the duration.
import type {
  CleanupState, ClipSummary, DirectorReport, FinalState, PlanCacheResult, PlanData, ReportItem, ReportSection, ResultsOutcome, StitchStatus,
  StoryPhase,
} from "./contracts";
import { STORY_PHASES } from "./contracts";
import { actionValidation, MAX_CLIP_INDEX } from "./production-rules";

/** Finalize Video's output_name. With overwrite off, an existing final.mp4 makes the node write final_2.mp4, final_3.mp4, … */
export const FINAL_OUTPUT_NAME = "final";

export function stitchWorkflowValues(projectSlugValue: string, renderPackage: Record<string, unknown>): Record<string, unknown> {
  return { project_name: projectSlugValue, render_package: renderPackage };
}

// ----- Finalize Video report --------------------------------------------------------------------------------

export type FinalizeReport = { segments: number | null; target: string | null; info: string | null; partial: string | null };

export function parseFinalizeReport(report: string | null): FinalizeReport {
  const lines = (report ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const stitched = lines.map((line) => line.match(/^Stitched (\d+) segments into (.+)$/)).find(Boolean) ?? null;
  const info = lines.find((line) => /^\d+x\d+ \S+ at [\d.]+ fps/.test(line)) ?? null;
  const partial = lines.find((line) => line.startsWith("TEST STITCH")) ?? null;
  return { segments: stitched ? Number(stitched[1]) : null, target: stitched ? stitched[2].trim() : null, info, partial };
}

// ----- Readiness --------------------------------------------------------------------------------------------

/** Unbroken runs of rendered clips in clip order (same rule as the node's test_runs): runs of 2+ become test videos,
 *  single clips are skipped. */
export function testRuns(order: number[], rendered: Set<number>): { runs: Array<[number, number]>; singles: number[] } {
  const runs: Array<[number, number]> = []; const singles: number[] = []; let current: number[] = [];
  for (const index of [...order, null]) {
    if (index !== null && rendered.has(index)) { current.push(index); continue; }
    if (current.length >= 2) runs.push([current[0], current[current.length - 1]]);
    else singles.push(...current);
    current = [];
  }
  return { runs, singles };
}

/** The next test batch number for a package: one more than any batch recorded or any test_<a>_<b>_<n>.mp4 in its folder. */
export function nextTestBatch(fileNames: string[], recorded: number[]): number {
  const fromFiles = fileNames.map((name) => /^test_\d+_\d+_(\d+)\.mp4$/i.exec(name)).filter(Boolean).map((match) => Number(match![1]));
  return Math.max(0, ...fromFiles, ...recorded) + 1;
}

export type ReadinessClip = { index: number; status: string; error: string | null; attempts: number };
export type ReadinessInput = {
  projectFolderExists: boolean;
  projectPath: string;
  pkg: { folder: string; clipCount: number } | null;
  /** The folder render_package.json names; undefined when the file is missing or unreadable. */
  renderPackageFolder: string | undefined;
  /** Clips in segments.json; null when it is missing or unreadable. */
  manifestClipCount: number | null;
  samePath(a: string, b: string): boolean;
  busy: { kind: "package" | "render" | "stitch" | "postprocess"; sameProject: boolean } | null;
  packageWriting: boolean;
  clips: ReadinessClip[];
};

/** Collapses clip numbers into "4–9, 12". */
export function formatRanges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(", ");
}

const shorten = (text: string, max = 180) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Exact reasons Finalize Video must not be submitted. Empty means every clip of the package has a video and the saved
 *  render package points at it. Finalize Video itself would otherwise make a partial "test stitch" from the first run of
 *  rendered clips, which Martini Shot never asks for. */
export function stitchBlockers(input: ReadinessInput): string[] {
  const blockers: string[] = [];
  if (!input.projectFolderExists) blockers.push(`The project folder is missing: ${input.projectPath}.`);
  if (!input.pkg) {
    blockers.push("There is no prompt package yet. Write it on Produce, then render every clip.");
    return blockers;
  }
  if (input.packageWriting) blockers.push("A prompt package is being written. Wait for it to finish.");
  if (input.busy) {
    if (!input.busy.sameProject) blockers.push("Another project is using ComfyUI right now. Stitch when it has finished.");
    else if (input.busy.kind === "render") blockers.push("Clips are still rendering on Produce. Stitch when the queue has finished.");
    else if (input.busy.kind === "package") blockers.push("A prompt package is being written. Wait for it to finish.");
    else if (input.busy.kind === "postprocess") blockers.push("Clips are being post-processed. Stitch when the Post-processing queue has finished.");
  }
  if (input.renderPackageFolder === undefined) {
    blockers.push(`render_package.json is missing or unreadable in ${input.projectPath}. Write the prompt package again on Produce.`);
  } else if (!input.samePath(input.renderPackageFolder, input.pkg.folder)) {
    blockers.push(`render_package.json points at ${input.renderPackageFolder}, not this package's folder (${input.pkg.folder}). Write the prompt package again on Produce so Finalize Video stitches the right clips.`);
  }
  if (input.manifestClipCount === null) blockers.push(`segments.json in ${input.pkg.folder} is missing or unreadable.`);
  else if (input.manifestClipCount !== input.pkg.clipCount) {
    blockers.push(`segments.json lists ${input.manifestClipCount} clips but Martini Shot recorded ${input.pkg.clipCount}. Write the prompt package again on Produce.`);
  }
  if (!input.clips.length) blockers.push("The prompt package has no clips.");
  const failed = input.clips.filter((clip) => clip.status === "failed");
  const interrupted = input.clips.filter((clip) => clip.status === "interrupted");
  const vanished = input.clips.filter((clip) => clip.status === "pending" && clip.error && /no longer in the package folder/.test(clip.error));
  const active = input.clips.filter((clip) => clip.status === "rendering" || clip.status === "queued");
  const pending = input.clips.filter((clip) => clip.status === "pending" && !vanished.includes(clip));
  const lines: string[] = [];
  for (const clip of failed) lines.push(`Clip ${clip.index} failed${clip.attempts ? ` (attempt ${clip.attempts})` : ""}${clip.error ? `: ${shorten(clip.error)}` : "."} Retry it on Produce.`);
  for (const clip of interrupted) lines.push(`Clip ${clip.index} was interrupted while rendering. Retry it on Produce.`);
  for (const clip of vanished) lines.push(`Clip ${clip.index}'s rendered file is no longer in the package folder. Render it again on Produce.`);
  const limit = 12;
  blockers.push(...lines.slice(0, limit));
  if (lines.length > limit) blockers.push(`…and ${lines.length - limit} more failed or missing clips (see Produce).`);
  if (active.length) blockers.push(`Rendering now: clip${active.length === 1 ? "" : "s"} ${formatRanges(active.map((clip) => clip.index))}.`);
  if (pending.length) blockers.push(`Not rendered yet: clip${pending.length === 1 ? "" : "s"} ${formatRanges(pending.map((clip) => clip.index))}. Queue them on Produce.`);
  return blockers;
}

export type LatestStitch = { status: StitchStatus; fileExists: boolean; clipsChangedSince: boolean } | null;

export function finalState(input: { active: boolean; blockers: string[]; latest: LatestStitch }): FinalState {
  if (input.active) return "stitching";
  const latest = input.latest;
  if (latest?.status === "complete" && latest.fileExists && !latest.clipsChangedSince) return "complete";
  if (input.blockers.length) return "blocked";
  if (latest && (latest.status === "failed" || latest.status === "interrupted")) return "failed";
  return "ready";
}

export type SummaryClip = { index: number; status: string; attempts: number; outputPath: string | null };

export function summarizeClips(clips: SummaryClip[]): ClipSummary & { outputs: Record<string, string | null> } {
  return {
    total: clips.length,
    rendered: clips.filter((clip) => clip.status === "rendered").length,
    failed: clips.filter((clip) => clip.status === "failed" || clip.status === "interrupted").map((clip) => clip.index),
    missing: clips.filter((clip) => clip.status !== "rendered" && clip.status !== "failed" && clip.status !== "interrupted").map((clip) => clip.index),
    retried: clips.filter((clip) => clip.attempts > 1).map((clip) => clip.index),
    attempts: clips.reduce((sum, clip) => sum + clip.attempts, 0),
    outputs: Object.fromEntries(clips.map((clip) => [String(clip.index), clip.outputPath])),
  };
}

/** True when the package's clips are no longer exactly the files this video was stitched from. */
export function clipsChangedSince(stitched: Record<string, string | null> | undefined, current: SummaryClip[], samePath: (a: string, b: string) => boolean): boolean {
  if (!stitched) return false;
  if (Object.keys(stitched).length !== current.length) return true;
  return current.some((clip) => {
    const then = stitched[String(clip.index)];
    return clip.status !== "rendered" || !clip.outputPath || !then || !samePath(then, clip.outputPath);
  });
}

// ----- Re-render unchanged plan -----------------------------------------------------------------------------

/** "3, 7-9" → [3, 7, 8, 9]. Clip numbers are checked against the package. */
export function parseClipSelection(text: unknown, total: number): number[] {
  if (typeof text !== "string" || !text.trim()) throw new Error("Enter the clip numbers to re-render, for example 3, 7-9.");
  if (text.length > 400) throw new Error("That clip list is too long.");
  const result = new Set<number>();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const match = part.match(/^(\d{1,3})(?:[-–](\d{1,3}))?$/);
    if (!match) throw new Error(`"${part}" is not a clip number or range.`);
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (to < from) throw new Error(`"${part}" runs backwards.`);
    if (from < 1 || to > Math.min(total, MAX_CLIP_INDEX)) throw new Error(`This package has clips 1–${total}; "${part}" is outside that.`);
    for (let index = from; index <= to; index++) result.add(index);
  }
  return [...result].sort((a, b) => a - b);
}

/** A continuation or new-angle bridge guided by the previous clip's last frames must be re-rendered with it. */
export function withContinuations(selected: number[], clips: Array<{ index: number; transition: string; overlapFrames: number }>): { clips: number[]; added: number[] } {
  const byIndex = new Map(clips.map((clip) => [clip.index, clip]));
  const chosen = new Set(selected);
  const added: number[] = [];
  for (const index of selected) {
    let next = byIndex.get(index + 1);
    while (next && (next.transition === "Continue" || next.transition === "New angle") && next.overlapFrames > 0) {
      if (!chosen.has(next.index)) { chosen.add(next.index); added.push(next.index); }
      next = byIndex.get(next.index + 1);
    }
  }
  return { clips: [...chosen].sort((a, b) => a - b), added: added.sort((a, b) => a - b) };
}

/** A filesystem-safe stamp for the superseded-clips folder. */
export function archiveStamp(iso: string): string {
  return iso.replace(/[:]/g, "-").replace(/\.\d+Z$/, "Z");
}

/** The report written next to a final video: final_2.mp4 → final_2-director-report.md. */
export function reportFileName(videoFileName: string): string {
  const stem = videoFileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_.-]/g, "_") || "final";
  return `${stem}-director-report.md`;
}

// ----- MP4 duration -----------------------------------------------------------------------------------------

/** Duration in seconds from the MP4's moov/mvhd box, or null when it cannot be read. `read` returns up to `length` bytes. */
export function mp4Duration(read: (offset: number, length: number) => Buffer, size: number): number | null {
  const box = (offset: number): { size: number; type: string; header: number } | null => {
    const head = read(offset, 16);
    if (head.length < 8) return null;
    let boxSize = head.readUInt32BE(0);
    let header = 8;
    if (boxSize === 1) {
      if (head.length < 16) return null;
      boxSize = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (boxSize === 0) boxSize = size - offset;
    if (boxSize < header) return null;
    return { size: boxSize, type: head.toString("latin1", 4, 8), header };
  };
  for (let offset = 0, guard = 0; offset + 8 <= size && guard < 4096; guard++) {
    const top = box(offset);
    if (!top) return null;
    if (top.type === "moov") {
      const end = Math.min(size, offset + top.size);
      for (let child = offset + top.header, inner = 0; child + 8 <= end && inner < 4096; inner++) {
        const sub = box(child);
        if (!sub) return null;
        if (sub.type === "mvhd") {
          const body = read(child + sub.header, 32);
          if (body.length < 20) return null;
          const v1 = body[0] === 1;
          if (v1 && body.length < 32) return null;
          const timescale = body.readUInt32BE(v1 ? 20 : 12);
          const duration = v1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
          return timescale > 0 && duration > 0 ? duration / timescale : null;
        }
        child += sub.size;
      }
      return null;
    }
    offset += top.size;
  }
  return null;
}

// ----- Director report --------------------------------------------------------------------------------------

export const CACHE_TEXT: Record<PlanCacheResult, { text: string; tone: ReportItem["tone"] }> = {
  reused: { text: "HIT — the existing director plan was reused unchanged", tone: "ok" },
  partly_reused: { text: "Partly reused — some planning steps came from the director cache", tone: "info" },
  new: { text: "MISS — the plan was written new by the local LLM", tone: "info" },
  rerolled: { text: "Rerolled — a new story was planned on request", tone: "info" },
  no_llm: { text: "Planned from the song only (no LLM story steps)", tone: "info" },
  unknown: { text: "The planner report did not include cache lines", tone: "none" },
};

export type ReportInput = {
  projectName: string;
  generatedAt: string;
  kind: DirectorReport["kind"];
  formatWhen?(iso: string): string;
  inputs: { song: { name: string; durationSeconds: number | null } | null; performers: string[]; outfits: string[]; suppliedLocations: string[] };
  direction: { creativeBrief: string; motifWeight: number } | null;
  planRun: {
    kind: "create" | "reroll" | null; cacheResult: PlanCacheResult | null; cacheDetails: string[]; seed: number | null; directorLlm: string | null;
    completedAt: string | null; storyChanged: boolean | null;
  } | null;
  plan: PlanData | null;
  planIsCurrent: boolean;
  package: {
    folder: string; clipCount: number; shotCount: number; writtenAt: string; motifWeight: number | null; warnings: string[]; polish: string[];
    resolveReport: string; isCurrent: boolean;
    /** null = unknown (written before the setting existed and no direction was saved with it). */
    surrealMotifs?: boolean | null;
    /** From the package's director_context.json and its current prompt files; null when that file is unreadable. */
    requiredEvents?: RequiredEventStatus[] | null;
  } | null;
  clipNotes: Record<string, string[]>;
  clips: Array<{ index: number; section: number | null; mode: string; location: string; outfit: string; status: string; attempts: number; error: string | null }>;
  attempts: Array<{ status: string; cleanup: CleanupState }>;
  stitch: {
    status: StitchStatus; videoPath: string | null; videoInfo: string | null; stitchReport: string | null; durationSeconds: number | null;
    fileSizeBytes: number | null; completedAt: string | null; error: string | null; cleanup: CleanupState; cleanupDetail: string | null;
    promptId: string | null; projectStatus: string | null;
  } | null;
};

export function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "unknown";
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function fileSize(bytes: number | null): string {
  if (bytes === null) return "unknown";
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** A required event's canonical allocation and whether the current prompt text names it. The rendered video is never
 *  checked, so visual fulfillment is always reported as unverified. */
export type RequiredEventStatus = { event: string; section: number | null; clips: number[]; promptMentions: number[] };

const EVENT_STOP = new Set(["the", "and", "with", "one", "scene", "moment", "shot", "time", "during", "where", "that", "this", "event", "single", "final", "big", "required"]);

function eventStems(text: string): Set<string> {
  const stem = (word: string) => {
    for (const suffix of ["ing", "es", "ed", "er", "s", "e"]) if (word.length > suffix.length + 2 && word.endsWith(suffix)) return word.slice(0, -suffix.length).slice(0, 6);
    return word.slice(0, 6);
  };
  return new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => word.length > 2 && !EVENT_STOP.has(word)).map(stem));
}

/** Same rule as director_context.event_mentioned in the nodes: most of the event's content words appear in the text. */
export function eventMentioned(event: string, text: string): boolean {
  const wanted = eventStems(event);
  if (!wanted.size) return false;
  const found = eventStems(text);
  const hits = [...wanted].filter((word) => found.has(word)).length;
  return hits * 2 >= wanted.size + (wanted.size > 2 ? 1 : 0);
}

/** Allocation from director_context.json (production_shots[].required_events, keyed by shot number = segments.json's
 *  section), prompt coverage from the current prompt files, so a later revision is reflected. */
export function requiredEventStatuses(context: unknown, segments: Array<{ index: number; section: number }>, promptText: (index: number) => string): RequiredEventStatus[] {
  const value = context as { required_events?: Array<{ id?: string; event?: string; section?: number }>; production_shots?: Array<{ number?: number; required_events?: Array<{ id?: string }> }> } | null;
  if (!value || !Array.isArray(value.required_events)) return [];
  return value.required_events.filter((event) => typeof event?.event === "string" && event.event.trim()).map((event) => {
    const shots = (value.production_shots ?? []).filter((shot) => (shot.required_events ?? []).some((item) => item.id === event.id)).map((shot) => Number(shot.number));
    const clips = segments.filter((segment) => shots.includes(segment.section)).map((segment) => segment.index);
    return { event: String(event.event), section: typeof event.section === "number" ? event.section : null, clips, promptMentions: clips.filter((clip) => eventMentioned(String(event.event), promptText(clip))) };
  });
}

/** Older packages: "required event 'lightning strike': section(s) 13" from Write Prompt Package's Polish lines. That
 *  line searched optional hook text, so it is shown only when the package has no director context to read. */
export function requiredEventAllocation(polish: string[]): { event: string; sections: string | null } | null {
  for (const line of polish) {
    const match = line.match(/^required event '(.+)': section\(s\) (.+)$/);
    if (match) return { event: match[1], sections: match[2].trim() === "NOT ALLOCATED" ? null : match[2].trim() };
  }
  return null;
}

/** Story Wheel phases in order with the song sections in each, e.g. Arrival → "1–3". */
export function wheelRanges(plan: PlanData): Array<{ phase: StoryPhase; sections: string }> {
  return STORY_PHASES.map((phase) => ({ phase, sections: formatRanges(plan.sections.filter((section) => section.wheelPhase === phase).map((section) => section.number)) }))
    .filter((item) => item.sections);
}

const key = (value: string) => value.trim().toLowerCase();

function performerClips(input: ReportInput) {
  return input.clips.filter((clip) => clip.mode !== "B-roll" && clip.location.trim());
}

export function outcomeFor(input: ReportInput): ResultsOutcome | null {
  if (!input.package) return null;
  const status = input.package.requiredEvents?.find((item) => item.clips.length);
  const event = input.package.requiredEvents ? null : requiredEventAllocation(input.package.polish);
  return {
    clipsRendered: input.clips.filter((clip) => clip.status === "rendered").length,
    clipsTotal: input.clips.length,
    performerLocations: new Set(performerClips(input).map((clip) => key(clip.location))).size,
    outfits: new Set(input.clips.map((clip) => clip.outfit.trim()).filter(Boolean).map(key)).size,
    requiredEvent: status ? { event: status.event, sections: String(status.section ?? formatRanges(status.clips)) }
      : event?.sections ? { event: event.event, sections: event.sections } : null,
  };
}

function sectionsOf(clips: ReportInput["clips"]): string {
  const sections = clips.map((clip) => clip.section).filter((value): value is number => value !== null);
  return sections.length ? `section${new Set(sections).size === 1 ? "" : "s"} ${formatRanges(sections)}` : "sections not matched";
}

export function buildDirectorReport(input: ReportInput): DirectorReport {
  const when = input.formatWhen ?? ((iso: string) => iso.replace("T", " ").slice(0, 16));
  const sections: ReportSection[] = [];
  const { plan, planRun } = input;

  // Project and inputs.
  const inputs = input.inputs;
  sections.push({
    id: "inputs", title: "Project and inputs",
    summary: `${inputs.performers.length} performer · ${inputs.outfits.length} outfit · ${inputs.suppliedLocations.length} supplied location image${inputs.suppliedLocations.length === 1 ? "" : "s"}`,
    items: [
      { label: "Song", value: inputs.song ? `${inputs.song.name}${inputs.song.durationSeconds ? ` (${clock(inputs.song.durationSeconds)})` : ""}` : "No song recorded", tone: inputs.song ? "info" : "warn" },
      { label: "Performer", value: inputs.performers.join(", ") || "None recorded", tone: inputs.performers.length ? "info" : "warn" },
      { label: "Outfits", value: inputs.outfits.join(", ") || "None supplied", tone: "info" },
      { label: "Supplied locations", value: inputs.suppliedLocations.join(", ") || "None supplied", tone: "info" },
    ],
  });

  // Director plan.
  const planItems: ReportItem[] = [];
  if (planRun) {
    const cache = CACHE_TEXT[planRun.cacheResult ?? "unknown"];
    planItems.push({ label: "Plan", value: planRun.kind === "reroll" ? "Rerolled on request (a new story)" : "Created with Create director plan", tone: "info" });
    planItems.push({ label: "Plan cache", value: cache.text, tone: cache.tone });
    const llmSteps = planRun.cacheDetails.filter((line) => !line.startsWith("location photo "));
    if (llmSteps.length) planItems.push({ label: "Cache steps", value: llmSteps.join(" · "), tone: "info" });
    if (planRun.storyChanged !== null) planItems.push({ label: "Story vs. previous plan", value: planRun.storyChanged ? "Changed" : "Unchanged", tone: "info" });
    if (planRun.seed !== null) planItems.push({ label: "Plan seed", value: String(planRun.seed), tone: "info" });
    if (planRun.directorLlm) planItems.push({ label: "Director LLM", value: planRun.directorLlm, tone: "info" });
    if (planRun.completedAt) planItems.push({ label: "Planned", value: when(planRun.completedAt), tone: "info" });
  } else planItems.push({ label: "Plan", value: "No director plan record was found for this package", tone: "warn" });
  if (plan) {
    const beats = plan.sections.filter((section) => section.beat).length;
    planItems.push({ label: "Sections", value: `${plan.sections.length} song sections${plan.rulesOnly ? " — the deterministic rules chose every scene" : `, ${beats} with a story beat`}`, tone: "info" });
    for (const warning of plan.warnings) planItems.push({ label: "Planner warning", value: warning, tone: "warn" });
  }
  if (!input.planIsCurrent) planItems.push({ label: "Current plan", value: "This video was made from an earlier director plan than the one now on the Plan page", tone: "warn" });
  sections.push({
    id: "plan", title: "Director plan",
    summary: planRun ? CACHE_TEXT[planRun.cacheResult ?? "unknown"].text.split(" — ")[0] : "No record",
    items: planItems,
  });

  // Story wheel.
  if (plan) {
    const ranges = plan.storyWheel ? wheelRanges(plan) : [];
    sections.push({
      id: "wheel", title: "Story wheel",
      summary: ranges.length ? `${ranges.length} phases` : "Off",
      items: ranges.length
        ? ranges.map((range) => ({ label: range.phase, value: `Sections ${range.sections}`, tone: "info" as const }))
        : [{ label: "Story Wheel", value: plan.storyWheel ? "On, but the planner returned no phases" : "Off for this plan", tone: "none" }],
    });
  }

  // Creative direction.
  const creative: ReportItem[] = [];
  const brief = input.direction?.creativeBrief.trim() ?? "";
  if (brief) creative.push({ label: "Creative brief", value: shorten(brief, 400), tone: "info" });
  const contract = plan?.creativeDirection ?? null;
  if (contract?.look) creative.push({ label: "Look", value: contract.look, tone: "ok" });
  if (contract?.motif) creative.push({ label: "Recurring motif", value: contract.motif, tone: "ok" });
  const statuses = input.package?.requiredEvents ?? null;
  if (contract?.event) {
    const status = statuses?.find((item) => key(item.event) === key(contract.event)) ?? statuses?.[0];
    if (status && status.clips.length) {
      const where = `allocated to section ${status.section ?? "?"} (clip${status.clips.length === 1 ? "" : "s"} ${formatRanges(status.clips)})`;
      const prompt = status.promptMentions.length
        ? `the current prompt text names it in clip${status.promptMentions.length === 1 ? "" : "s"} ${formatRanges(status.promptMentions)}`
        : "the current prompt text of those clips does not name it";
      creative.push({ label: "Required one-off event", value: `${contract.event} — ${where}; ${prompt}; the rendered video is not visually verified`, tone: status.promptMentions.length ? "ok" : "warn" });
    } else if (status) creative.push({ label: "Required one-off event", value: `${contract.event} — allocated to section ${status.section ?? "?"}, but no clip in this package carries it`, tone: "warn" });
    else if (statuses) creative.push({ label: "Required one-off event", value: `${contract.event} — not allocated in this package's director context`, tone: "warn" });
    else {
      // No readable director context: fall back to the older Polish line, which only searched optional hook text.
      const allocation = input.package ? requiredEventAllocation(input.package.polish) : null;
      if (allocation?.sections) creative.push({ label: "Required one-off event", value: `${contract.event} — named in the hook for section ${allocation.sections} (older report; prompt text and video not verified)`, tone: "info" });
      else creative.push({ label: "Required one-off event", value: `${contract.event} — the prompt package did not report where it was placed`, tone: "none" });
    }
  }
  // Section scene-type issues are already listed as planner warnings under Director plan.
  for (const issue of (plan?.planningIssues ?? []).filter((item) => !item.startsWith("Section "))) creative.push({ label: "Planning issue", value: issue, tone: "warn" });
  const style = input.package?.polish.find((line) => line.startsWith("style ("));
  if (style) creative.push({ label: "Style pass", value: style, tone: "info" });
  if (input.package?.motifWeight !== null && input.package?.motifWeight !== undefined) {
    const surreal = input.package.surrealMotifs;
    creative.push({ label: "Recurring motif frequency", value: `${input.package.motifWeight}${surreal === true ? " · surreal imagery on" : surreal === false ? " · grounded (surreal imagery off)" : ""}`, tone: "info" });
  }
  if (!creative.length) creative.push({ label: "Creative direction", value: "No brief was given; the director chose the look", tone: "none" });
  sections.push({ id: "creative", title: "Creative direction", summary: contract ? [contract.look && "look", contract.motif && "motif", contract.event && "event"].filter(Boolean).join(" · ") : brief ? "Brief only" : "None given", items: creative });

  // Location coverage.
  const locItems: ReportItem[] = [];
  const supplied = new Set(inputs.suppliedLocations.map(key));
  const requested = plan?.requestedLocations ?? [];
  const resolved = new Map<string, { mode: string; detail: string }>();
  for (const line of (input.package?.resolveReport ?? "").split(/\r?\n/)) {
    for (const request of requested) {
      if (line.startsWith(`  ${request.name}: `)) {
        const detail = line.slice(request.name.length + 4).trim();
        resolved.set(key(request.name), { mode: detail.toLowerCase().startsWith("image-backed") ? "image_backed" : "not", detail });
      }
    }
  }
  const performer = performerClips(input);
  const used = new Map<string, { name: string; clips: ReportInput["clips"] }>();
  for (const clip of performer) {
    const entry = used.get(key(clip.location)) ?? { name: clip.location, clips: [] };
    entry.clips.push(clip);
    used.set(key(clip.location), entry);
  }
  for (const [name, entry] of used) {
    const where = `Used in ${sectionsOf(entry.clips)} (${entry.clips.length} clip${entry.clips.length === 1 ? "" : "s"})`;
    const request = resolved.get(name);
    if (supplied.has(name)) locItems.push({ label: entry.name, value: `${where} · image-backed (supplied photo)`, tone: "ok" });
    else if (request?.mode === "image_backed") locItems.push({ label: entry.name, value: `${where} · ${request.detail} (requested by the director)`, tone: "ok" });
    else if (request) locItems.push({ label: entry.name, value: `${where} · ${request.detail}`, tone: "warn" });
    else if (requested.some((item) => key(item.name) === name)) locItems.push({ label: entry.name, value: `${where} · requested, but the package's location check has no line for it`, tone: "warn" });
    else locItems.push({ label: entry.name, value: `${where} · text-only performer location`, tone: "warn" });
  }
  for (const request of requested) {
    if (used.has(key(request.name))) continue;
    locItems.push({ label: request.name, value: "Requested by the plan, but no clip ended up there", tone: "info" });
  }
  const broll = [...new Set(input.clips.filter((clip) => clip.mode === "B-roll" && clip.location.trim()).map((clip) => clip.location.trim()))];
  if (broll.length) locItems.push({ label: "B-roll (text-only)", value: broll.join(", "), tone: "info" });
  const photos = planRun?.cacheDetails.filter((line) => line.startsWith("location photo ")) ?? [];
  if (photos.length) {
    const hits = photos.filter((line) => /: cache hit$/.test(line)).length;
    const analyzed = photos.filter((line) => /: analyzed$/.test(line)).length;
    locItems.push({ label: "Location evidence", value: `${photos.length} supplied photo${photos.length === 1 ? "" : "s"}: ${hits} from the evidence cache, ${analyzed} analyzed by the local LLM${photos.length - hits - analyzed ? `, ${photos.length - hits - analyzed} without usable analysis` : ""}`, tone: "info" });
  }
  if (!locItems.length) locItems.push({ label: "Locations", value: input.package ? "No clip named a location" : "No prompt package yet", tone: "none" });
  sections.push({ id: "locations", title: "Location coverage", summary: `${used.size} performer location${used.size === 1 ? "" : "s"}`, items: locItems });

  // Production decisions.
  const prodItems: ReportItem[] = [];
  if (input.package) {
    prodItems.push({ label: "Production plan", value: `${input.package.shotCount} shots → ${input.package.clipCount} clips (deterministic from the plan seed)`, tone: "ok" });
    const outfits = new Map<string, ReportInput["clips"]>();
    for (const clip of input.clips) if (clip.outfit.trim()) outfits.set(clip.outfit.trim(), [...(outfits.get(clip.outfit.trim()) ?? []), clip]);
    for (const [outfit, clips] of outfits) prodItems.push({ label: `Outfit: ${outfit}`, value: `${sectionsOf(clips)} (${clips.length} clip${clips.length === 1 ? "" : "s"})`, tone: "info" });
    prodItems.push({ label: "Candidate selection", value: "Not part of this production path — Build Production Plan uses the story plan's actions directly", tone: "none" });
    const results = input.clips.map((clip) => actionValidation(input.clipNotes[String(clip.index)] ?? []).value);
    const count = (prefix: string) => results.filter((value) => value.startsWith(prefix)).length;
    const valid = count("Valid");
    const unverified = count("Unverified");
    const repaired = count("Repaired");
    const unrepaired = count("Could not repair");
    const skipped = count("Skipped");
    const legacy = count("Checked");
    const none = count("No result");
    prodItems.push({
      label: "Action validation", tone: unrepaired || skipped ? "warn" : unverified || legacy ? "info" : valid + repaired ? "ok" : "none",
      value: `${valid} validated, ${unverified} unverified, ${repaired} repaired, ${unrepaired} unresolved${skipped ? `, ${skipped} skipped` : ""}`
        + `${legacy ? `, ${legacy} checked by an older package (receipts not screened)` : ""}${none ? `, ${none} without a result` : ""}`,
    });
    prodItems.push({ label: "Prompt package", value: `Written ${when(input.package.writtenAt)} · ${input.package.folder}${input.package.isCurrent ? "" : " (not the current package)"}`, tone: "ok" });
    for (const warning of input.package.warnings.slice(0, 6)) prodItems.push({ label: "Package warning", value: warning, tone: "warn" });
  } else prodItems.push({ label: "Prompt package", value: "Not written yet", tone: "none" });
  sections.push({ id: "production", title: "Production decisions", summary: input.package ? `${input.package.clipCount} clips` : "No package", items: prodItems });

  // Rendering.
  const renderItems: ReportItem[] = [];
  const rendered = input.clips.filter((clip) => clip.status === "rendered").length;
  const failedClips = input.clips.filter((clip) => clip.status === "failed" || clip.status === "interrupted");
  const retried = input.clips.filter((clip) => clip.attempts > 1);
  renderItems.push({ label: "Clips rendered", value: `${rendered} of ${input.clips.length}`, tone: input.clips.length && rendered === input.clips.length ? "ok" : "warn" });
  if (failedClips.length) renderItems.push({ label: "Failed clips", value: failedClips.map((clip) => `clip ${clip.index}${clip.error ? `: ${shorten(clip.error, 120)}` : ""}`).join(" · "), tone: "fail" });
  renderItems.push({ label: "Render attempts", value: `${input.attempts.length} total${retried.length ? ` · clips retried: ${formatRanges(retried.map((clip) => clip.index))}` : " · no retries"}`, tone: "info" });
  const failedAttempts = input.attempts.filter((attempt) => attempt.status === "failed" || attempt.status === "interrupted").length;
  if (failedAttempts) renderItems.push({ label: "Failed attempts", value: String(failedAttempts), tone: "warn" });
  const asked = input.attempts.filter((attempt) => attempt.cleanup !== "not_requested");
  if (asked.length) {
    const done = asked.filter((attempt) => attempt.cleanup === "completed").length;
    const failedCleanup = asked.filter((attempt) => attempt.cleanup === "failed").length;
    renderItems.push({
      label: "ComfyUI cleanup after renders",
      value: `/free (unload models + free memory) was sent after ${asked.length} render${asked.length === 1 ? "" : "s"}: ${done} completed its cleanup cycle${failedCleanup ? `, ${failedCleanup} could not be confirmed` : ""}${asked.length - done - failedCleanup ? `, ${asked.length - done - failedCleanup} accepted without a confirmed cycle` : ""}. This confirms ComfyUI ran its cleanup, not how much memory Windows got back.`,
      tone: failedCleanup ? "warn" : "ok",
    });
  }
  sections.push({ id: "render", title: "Rendering", summary: `${rendered}/${input.clips.length} clips`, items: renderItems });

  // Final stitch.
  const stitch = input.stitch;
  const stitchItems: ReportItem[] = [];
  if (stitch) {
    const label = stitch.status === "complete" ? "Complete" : stitch.status === "failed" ? "Failed" : stitch.status === "interrupted" ? "Interrupted" : "In progress";
    stitchItems.push({ label: "Stitch", value: `${label}${stitch.completedAt ? ` · ${when(stitch.completedAt)}` : ""}`, tone: stitch.status === "complete" ? "ok" : stitch.status === "failed" || stitch.status === "interrupted" ? "fail" : "pending" });
    if (stitch.videoPath) stitchItems.push({ label: "Final video", value: stitch.videoPath, tone: "info" });
    if (stitch.videoInfo) stitchItems.push({ label: "Encoding", value: `${stitch.videoInfo} (video joined without re-encoding)`, tone: "info" });
    if (stitch.durationSeconds !== null) stitchItems.push({ label: "Duration", value: clock(stitch.durationSeconds), tone: "info" });
    if (stitch.fileSizeBytes !== null) stitchItems.push({ label: "File size", value: fileSize(stitch.fileSizeBytes), tone: "info" });
    if (stitch.error) stitchItems.push({ label: "Error", value: stitch.error, tone: "fail" });
    if (stitch.cleanupDetail) stitchItems.push({ label: "ComfyUI cleanup", value: stitch.cleanupDetail, tone: stitch.cleanup === "completed" ? "ok" : stitch.cleanup === "failed" ? "warn" : "pending" });
  } else stitchItems.push({ label: "Stitch", value: "Not stitched yet", tone: "none" });
  sections.push({ id: "stitch", title: "Final stitch", summary: stitch ? (stitch.status === "complete" ? "Complete" : stitch.status) : "Not yet", items: stitchItems });

  const technical: DirectorReport["technical"] = [];
  if (stitch?.stitchReport) technical.push({ label: "Martini Shot Finalize Video report", body: stitch.stitchReport });
  if (stitch?.projectStatus) technical.push({ label: "Martini Shot Project Status", body: stitch.projectStatus });
  if (stitch?.promptId) technical.push({ label: "ComfyUI prompt ID (stitch)", body: stitch.promptId });
  if (stitch?.error) technical.push({ label: "Stitch error", body: stitch.error });
  if (input.package?.resolveReport) technical.push({ label: "Resolve Locations report (at prompt-package time)", body: input.package.resolveReport });
  if (input.package?.polish.length) technical.push({ label: "Write Prompt Package polish lines", body: input.package.polish.join("\n") });
  if (planRun?.cacheDetails.length) technical.push({ label: "Director cache lines", body: planRun.cacheDetails.join("\n") });

  const report: Omit<DirectorReport, "markdown"> = { generatedAt: input.generatedAt, kind: input.kind, sections, technical };
  return { ...report, markdown: reportMarkdown(input.projectName, report, when) };
}

export function reportMarkdown(projectName: string, report: Omit<DirectorReport, "markdown">, when: (iso: string) => string): string {
  const lines = [
    `# Martini Shot director report — ${projectName}`,
    "",
    `${report.kind === "snapshot" ? "Saved when this video was stitched" : "Built from the current stored results"}: ${when(report.generatedAt)}.`,
    "Everything below comes from Martini Shot's local records and the reports ComfyUI's nodes returned. Nothing was uploaded.",
  ];
  for (const section of report.sections) {
    lines.push("", `## ${section.title} — ${section.summary}`, "");
    for (const item of section.items) lines.push(`- **${item.label}:** ${item.value.replace(/\r?\n/g, " ")}`);
  }
  if (report.technical.length) {
    lines.push("", "## Technical log", "");
    for (const entry of report.technical) lines.push(`### ${entry.label}`, "", "```text", entry.body.replace(/```/g, "'''"), "```", "");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}
