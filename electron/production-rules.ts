// Pure production-plan, prompt-package, and render-queue rules (Ticket 05). No Electron or SQLite imports so they can be
// unit-tested with plain Node. Everything here reads what the MartiniShot / MiniMaxPrompBuilder nodes actually write:
//  - Martini Shot Build Production Plan report: "Built deterministic production plan: N shots." + one "why" line per shot;
//  - Martini Shot Write Prompt Package report: the Music Video Director report (clip table, [segment_NN] notes);
//  - segments.json in the package folder (manifest v2) and the SaveVideo files next to it.
import type { ClipMode, DecisionRow } from "./contracts";

/** Write Prompt Package `render_name`; the Director adds _2, _3… when a folder of that name already has files. */
export const RENDER_NAME = "render-01";
/** MartiniShotLoadRenderClip modes (MiniMaxPrompBuilder video_nodes.LOADER_MODES). */
export const NEXT_MISSING = "Next missing";
export const FIXED_INDEX = "Fixed index";
/** Load Render Clip's clip_index range. */
export const MAX_CLIP_INDEX = 999;
export const MAX_QUEUE_COUNT = 10_000;
/** RandomNoise accepts 0..0xffffffffffffffff; stay inside JavaScript's safe integers. */
export const MAX_NOISE_SEED = Number.MAX_SAFE_INTEGER;
/** find_video ignores files smaller than this (half-written saves). */
export const MIN_VIDEO_BYTES = 1024;

const SCENES = ["Dance", "Performance", "Freeform", "B-roll"] as const;
const TRANSITIONS = ["Hard cut", "New angle", "Continue"] as const;

// ----- Renderer input ---------------------------------------------------------------------------------------

export function validateQueueCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new Error("Enter a whole number of clips, 1 or more.");
  if (raw > MAX_QUEUE_COUNT) throw new Error(`Queue at most ${MAX_QUEUE_COUNT} clips at a time.`);
  return raw;
}

export function validateClipIndex(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CLIP_INDEX) throw new Error("Unknown clip.");
  return raw;
}

/** A count at or above the remaining clips means "render everything that is left". */
export function queueTarget(requested: number, remaining: number): number {
  return Math.max(0, Math.min(requested, remaining));
}

// ----- Build Production Plan report -------------------------------------------------------------------------

export type ProductionShot = {
  /** Start in seconds, from the "m:ss.sss" column. */
  start: number;
  section: number;
  sectionLabel: string;
  role: string;
  energy: number;
  scene: ClipMode;
  transition: string;
  camera: string;
  location: string;
  outfit: string;
  subject: string;
  /** The story planner's action for this section (marked with * in the report). */
  storyAction: string;
  /** A rules-chosen action when there is no story action. */
  action: string;
  forcedCut: boolean;
  flags: string[];
};

const WHY_LINE = /^\s*([F*])?\s*(\d+):(\d{2}(?:\.\d+)?) \| section (\d+) (.*) \(([^()]*), energy (-?\d+(?:\.\d+)?)\) \| (Dance|Performance|Freeform|B-roll)\s+(Hard cut|New angle|Continue)\s* \| (.*)$/;

/** Parses MartiniShotBuildProductionPlan's report. Returns null when the header is missing (not a production report). */
export function parseProductionReport(report: string): { shotCount: number; shots: ProductionShot[] } | null {
  const header = report.match(/Built deterministic production plan: (\d+) shots?\./);
  if (!header) return null;
  const shots: ProductionShot[] = [];
  for (const line of report.split(/\r?\n/)) {
    const match = line.match(WHY_LINE);
    if (!match) continue;
    const parts = match[10].split(" | ");
    const shot: ProductionShot = {
      start: Number(match[2]) * 60 + Number(match[3]), section: Number(match[4]), sectionLabel: match[5].trim(), role: match[6].trim(),
      energy: Number(match[7]), scene: match[8] as ClipMode, transition: match[9], camera: (parts.shift() ?? "").trim(), location: "",
      outfit: "", subject: "", storyAction: "", action: "", forcedCut: match[1] === "F", flags: [],
    };
    const place = (parts.shift() ?? "").trim();
    shot.location = place === "no location" ? "" : place;
    let last: "storyAction" | "action" | null = null;
    for (const raw of parts) {
      const part = raw.trim();
      if (part.startsWith("outfit: ")) { shot.outfit = part.slice(8); last = null; }
      else if (part.startsWith("subject: ")) { shot.subject = part.slice(9); last = null; }
      else if (part.startsWith("story action: ")) { shot.storyAction = part.slice(14); last = "storyAction"; }
      else if (part.startsWith("action: ")) { shot.action = part.slice(8); last = "action"; }
      else if (/^(TRIGGER |hard cut moves to |same location: |story action superseded|invented location$|B-roll-only location$)/.test(part)) { shot.flags.push(part); last = null; }
      else if (last) shot[last] += ` | ${part}`; // an action that itself contained " | "
      else shot.flags.push(part);
    }
    shots.push(shot);
  }
  return { shotCount: Number(header[1]), shots };
}

// ----- Write Prompt Package report --------------------------------------------------------------------------

export type PackageTableRow = { clip: number; shot: number; scene: string; transition: string; frames: number };

export type PackageReport = {
  table: Map<number, PackageTableRow>;
  /** "[segment_NN] NOTE/WARNING: …" lines, by clip number. */
  clipNotes: Map<number, string[]>;
  /** WARNING lines that are not tied to one clip. */
  warnings: string[];
  /** Lines under "Polish:" (style bible, section hooks, camera pass, required event). */
  polish: string[];
  savedLine: string;
};

const TABLE_LINE = /^clip\s+(\d+) \| shot (\d+) (\S+)\s* \| \S+ - \S+ \| (Hard cut|New angle|Continue)\s* \| generate (\d+)/;

export function parsePackageReport(report: string): PackageReport {
  const result: PackageReport = { table: new Map(), clipNotes: new Map(), warnings: [], polish: [], savedLine: "" };
  let inPolish = false;
  for (const line of report.split(/\r?\n/)) {
    if (line.trim() === "Polish:") { inPolish = true; continue; }
    if (inPolish) {
      if (!line.trim()) { inPolish = false; continue; }
      result.polish.push(line.trim());
      continue;
    }
    const row = line.match(TABLE_LINE);
    if (row) {
      result.table.set(Number(row[1]), { clip: Number(row[1]), shot: Number(row[2]), scene: row[3], transition: row[4], frames: Number(row[5]) });
      continue;
    }
    const note = line.match(/^\[segment_(\d+)\] (.*)$/);
    if (note) {
      const clip = Number(note[1]);
      result.clipNotes.set(clip, [...(result.clipNotes.get(clip) ?? []), note[2].trim()]);
      continue;
    }
    if (/^Saved \d+ prompts/.test(line)) result.savedLine = line.trim();
    else if (line.trim().startsWith("WARNING:")) result.warnings.push(line.trim().slice(8).trim());
  }
  return result;
}

/** The action-validation outcome the Director wrote for one clip (validate_actions is on in 04-write-prompt-package.json). */
export function actionValidation(notes: string[]): DecisionRow {
  const failed = notes.filter((note) => note.startsWith("WARNING: action validation could not repair"));
  if (failed.length) return { label: "Action validation", value: `Could not repair: ${failed.map((note) => note.replace(/^WARNING: action validation could not repair: /, "")).join("; ")}`, tone: "warn", at: null };
  const unverified = notes.find((note) => note.startsWith("NOTE: action validation unverified"));
  const unknownText = unverified ? unverified.replace(/^NOTE: action validation unverified: /, "").replace(/\.$/, "") : "";
  const repaired = notes.filter((note) => note.startsWith("NOTE: repaired action validation"));
  if (repaired.length) {
    const fixed = repaired.map((note) => note.replace(/^NOTE: repaired action validation: /, "")).join("; ");
    return { label: "Action validation", value: `Repaired: ${fixed}${unknownText ? ` · still unverified: ${unknownText}` : ""}`, tone: unknownText ? "info" : "ok", at: null };
  }
  const skipped = notes.find((note) => note.startsWith("NOTE: action validation skipped"));
  if (skipped) return { label: "Action validation", value: "Skipped — the LLM returned no requirements receipt", tone: "warn", at: null };
  // Unknown or placeholder receipts are neither conflicts nor valid: they are reported on their own.
  if (unverified) return { label: "Action validation", value: `Unverified — ${unknownText}`, tone: "info", at: null };
  const validated = notes.find((note) => note.startsWith("NOTE: action validation validated"));
  if (validated) return { label: "Action validation", value: `Valid — ${validated.replace(/^NOTE: action validation validated: /, "").replace(/\.$/, "")}`, tone: "ok", at: null };
  // Packages written before receipts were screened for template text ("needs=Supported") said "checked" for any receipt.
  const checked = notes.find((note) => note.startsWith("NOTE: action validation checked"));
  if (checked) return { label: "Action validation", value: `Checked (older package; not screened for placeholder receipts) — ${checked.replace(/^NOTE: action validation checked /, "").replace(/\.$/, "")}`, tone: "none", at: null };
  return { label: "Action validation", value: "No result in the prompt-package report", tone: "none", at: null };
}

// ----- segments.json ----------------------------------------------------------------------------------------

export type ManifestSegment = {
  index: number;
  /** Director shot number. */
  section: number;
  promptFile: string;
  videoName: string;
  songStart: number;
  songEnd: number;
  overlapFrames: number;
  transition: string;
  startFrame: string | null;
  references: string[];
};

const safeName = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && !value.includes("..");

/** Validates the Director's segments.json (v2). Throws a readable error for anything the loader would not accept. */
export function parseManifest(raw: unknown): { fps: number; songDuration: number | null; segments: ManifestSegment[] } {
  const value = raw as { version?: unknown; fps?: unknown; song_duration?: unknown; segments?: unknown } | null;
  if (!value || typeof value !== "object" || !Array.isArray(value.segments)) throw new Error("segments.json has no clip list.");
  if (typeof value.version !== "number" || value.version < 2) throw new Error("segments.json is an older format that Martini Shot does not render.");
  const segments = value.segments.map((item, position): ManifestSegment => {
    const row = item as Record<string, unknown>;
    const index = Number(row.index);
    if (index !== position + 1) throw new Error(`segments.json clip ${position + 1} has index ${String(row.index)}.`);
    if (!safeName(row.prompt_file) || !safeName(row.video_name)) throw new Error(`segments.json clip ${index} has an unusable file name.`);
    return {
      index, section: Number(row.section) || 0, promptFile: String(row.prompt_file), videoName: String(row.video_name),
      songStart: Number(row.song_start) || 0, songEnd: Number(row.song_end) || 0, overlapFrames: Number(row.overlap_frames) || 0,
      transition: typeof row.transition === "string" ? row.transition : "", startFrame: typeof row.start_frame === "string" ? row.start_frame : null,
      references: Array.isArray(row.references) ? row.references.map((ref) => String((ref as { file?: unknown }).file ?? "")).filter(Boolean) : [],
    };
  });
  if (!segments.length) throw new Error("segments.json lists no clips.");
  if (segments.length > MAX_CLIP_INDEX) throw new Error(`The package has ${segments.length} clips; Load Render Clip handles at most ${MAX_CLIP_INDEX}.`);
  return { fps: Number(value.fps) || 24, songDuration: typeof value.song_duration === "number" ? value.song_duration : null, segments };
}

export function continuityText(segment: ManifestSegment): string {
  if (segment.transition === "Continue" && segment.overlapFrames > 0) {
    return `Continues from clip ${segment.index - 1} (last ${segment.overlapFrames} frames)`;
  }
  if (segment.transition === "Continue") return `Continues from clip ${segment.index - 1}`;
  if (segment.transition === "New angle" && segment.overlapFrames > 0) {
    return `New angle after a motion bridge from clip ${segment.index - 1} (last ${segment.overlapFrames} frames)`;
  }
  if (segment.transition === "New angle") return "New angle on the same set";
  if (segment.transition === "Hard cut") return segment.startFrame ? "Hard cut, anchored to a start frame" : "Hard cut — fresh shot";
  return segment.transition || "Not reported";
}

export type ClipMeta = {
  index: number;
  shot: number;
  section: number | null;
  start: number;
  end: number;
  mode: ClipMode;
  location: string;
  outfit: string;
  action: string;
  transition: string;
  continuity: string;
  overlapFrames: number;
  videoName: string;
  promptFile: string;
  matched: boolean;
  /** The matched production shot, for the decisions panel. */
  productionShot: ProductionShot | null;
};

/** Matches each clip to the production shot that contains its song start. The Director may split a long shot into several
 *  continuation clips, so clips are matched by time rather than by number, and confirmed by scene type. */
export function clipMetadata(segments: ManifestSegment[], shots: ProductionShot[], table: Map<number, PackageTableRow>): ClipMeta[] {
  const ordered = [...shots].sort((a, b) => a.start - b.start);
  return segments.map((segment) => {
    const row = table.get(segment.index);
    let shot: ProductionShot | null = null;
    for (const candidate of ordered) if (candidate.start <= segment.songStart + 0.35) shot = candidate;
    const scene = (row?.scene ?? "") as ClipMode;
    const matched = Boolean(shot && (!row || row.scene === shot.scene));
    const use = matched ? shot : null;
    // The package table's scene type is still trustworthy when the production report could not be matched.
    const mode: ClipMode = use ? use.scene : (SCENES as readonly string[]).includes(scene) ? scene : "";
    return {
      index: segment.index, shot: segment.section, section: use?.section ?? null, start: segment.songStart, end: segment.songEnd, mode,
      location: use?.location ?? "", outfit: use?.outfit ?? "", action: use ? use.storyAction || use.action : "",
      transition: segment.transition || row?.transition || "", continuity: continuityText(segment), overlapFrames: segment.overlapFrames,
      videoName: segment.videoName, promptFile: segment.promptFile, matched, productionShot: use,
    };
  });
}

// ----- Rendered files ---------------------------------------------------------------------------------------

export type FolderFile = { name: string; size: number; mtimeMs: number };

/** Same rule as MiniMaxPrompBuilder find_video: <name>.mp4 or <name>_*.mp4 (SaveVideo's counter), newest take, at least 1 KB.
 *  ComfyUI additionally checks that the file decodes; Martini Shot cannot, so its loader report has the final word. */
export function findVideo(files: FolderFile[], videoName: string): FolderFile | null {
  const matches = files.filter((file) => {
    const lower = file.name.toLowerCase();
    return (lower === `${videoName.toLowerCase()}.mp4` || (lower.startsWith(`${videoName.toLowerCase()}_`) && lower.endsWith(".mp4"))) && file.size >= MIN_VIDEO_BYTES;
  });
  return matches.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

/** "Clip 3 of 32 (2 already rendered) | Continue" from MartiniShotLoadRenderClip's report. */
export function parseLoaderReport(report: string | null): { clip: number; total: number; rendered: number } | null {
  const match = report?.match(/^Clip (\d+) of (\d+) \((\d+) already rendered\)/m);
  return match ? { clip: Number(match[1]), total: Number(match[2]), rendered: Number(match[3]) } : null;
}

/** The file SaveVideo reported in /history: outputs[node].images[0] = { filename, subfolder, type }. */
export function savedVideo(outputs: unknown, node: string): { filename: string; subfolder: string } | null {
  const images = (outputs as Record<string, { images?: Array<{ filename?: unknown; subfolder?: unknown; type?: unknown }> }> | null)?.[node]?.images;
  const first = Array.isArray(images) ? images[0] : undefined;
  if (!first || typeof first.filename !== "string" || first.type !== "output") return null;
  return { filename: first.filename, subfolder: typeof first.subfolder === "string" ? first.subfolder : "" };
}

// ----- Timing -----------------------------------------------------------------------------------------------

/** A conservative remaining-time estimate: only with at least two finished clips, using the slower of mean and median,
 *  never below what the current clip still plausibly needs. Null when there is not enough evidence. */
export function estimateRemaining(durations: number[], clipsLeft: number, currentElapsed: number): number | null {
  const usable = durations.filter((value) => Number.isFinite(value) && value > 0).slice(-8);
  if (usable.length < 2 || clipsLeft <= 0) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  const perClip = Math.max(mean, median);
  const current = Math.max(perClip * 0.1, perClip - currentElapsed);
  return Math.round(current + perClip * (clipsLeft - 1));
}

// ----- Errors -----------------------------------------------------------------------------------------------

/** Plain-language versions of the errors ComfyUI and the nodes produce for these two workflows. */
export function readableProductionError(message: string, endpoint: string): string {
  if (/fetch failed|ECONNREFUSED|ECONNRESET|aborted|network/i.test(message)) {
    return `Lost contact with ComfyUI at ${endpoint}. Start ComfyUI again and wait for it to finish loading; nothing that already finished was lost.`;
  }
  const missingImages = message.match(/Cannot build production plan until requested performer location images are present: (.*)/);
  if (missingImages) return `Needs location images: ${missingImages[1].trim()}. Add them on Locations and click Check for images.`;
  if (/Value not in list/i.test(message) && /safetensors|unet_name|clip_name|vae_name|model_name|model:/i.test(message)) {
    return `The workflow names a model file this ComfyUI does not have installed. ${message}`;
  }
  if (/Nothing to do: all \d+ clips/.test(message)) return "ComfyUI found every clip already rendered. Nothing was submitted.";
  if (/has not been created for project/.test(message)) return `${message} Create the director plan on the Plan page first.`;
  if (/does not exist\.$/.test(message) && /Martini Shot project/.test(message)) return `${message} Re-save the project from the Projects page.`;
  if (/out of memory|CUDA out of memory|OutOfMemory/i.test(message)) {
    return `ComfyUI ran out of GPU memory while rendering. Close other GPU apps, then retry this clip. (${message})`;
  }
  return message;
}

export const VALID_TRANSITIONS: readonly string[] = TRANSITIONS;
