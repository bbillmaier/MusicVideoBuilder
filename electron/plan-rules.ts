// Pure creative-direction and story-plan rules. No Electron or SQLite imports so they can be unit-tested with plain Node.
import { createHash } from "node:crypto";
import path from "node:path";
import {
  STORY_PHASES, type CreativeDirection, type LocationMode, type PlanCacheResult, type PlanData, type PlanFreshness, type PlanSection,
  type RequestedLocation, type StoryPhase,
} from "./contracts";
import { projectSlug } from "./project-rules";

export const BRIEF_MAX_LENGTH = 1000;
/** Martini Shot Plan Story accepts min_locations 0–12. */
export const MAX_MIN_LOCATIONS = 12;
/** Plan Story's seed input range. */
export const MAX_SEED = 0xffffffff;
export const RENDER_ASPECT_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "9:21"] as const;

export const DEFAULT_DIRECTION: CreativeDirection = {
  creativeBrief: "", storyWheel: true, minLocations: 0, requestLocationImages: true, motifWeight: 0,
  danceStyle: "K-Pop", targetShotSeconds: 8, minShotSeconds: 3, maxShotSeconds: 10,
  cutRateVsEnergy: 0.5, brollAmount: 0.3, performanceVsDance: 0.4, freeformAmount: 0,
  locationVariety: 0.5, chorusConsistency: true, outfitChangeRate: 0.3, continueBias: 0.5,
  hardCutsChangeLocation: true, lipSync: false,
  aspectRatio: "4:3", renderMegapixels: 1,
};

/** Validates direction input from the renderer. Throws a readable error for anything malformed. */
export function validateDirection(raw: unknown): CreativeDirection {
  if (!raw || typeof raw !== "object") throw new Error("Creative direction is missing.");
  const value = raw as Record<string, unknown>;
  const brief = value.creativeBrief;
  if (typeof brief !== "string") throw new Error("The creative brief must be text.");
  const creativeBrief = brief.replace(/\r\n/g, "\n");
  if (creativeBrief.length > BRIEF_MAX_LENGTH) throw new Error(`The creative brief can be at most ${BRIEF_MAX_LENGTH} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(creativeBrief)) throw new Error("The creative brief contains unsupported control characters.");
  if (typeof value.storyWheel !== "boolean") throw new Error("Story Wheel must be on or off.");
  if (typeof value.requestLocationImages !== "boolean") throw new Error("Request image references must be on or off.");
  const min = value.minLocations;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 0 || min > MAX_MIN_LOCATIONS) {
    throw new Error(`Minimum performer locations must be a whole number from 0 to ${MAX_MIN_LOCATIONS}.`);
  }
  const weight = value.motifWeight;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error("Surreal motif weight must be between 0 and 1.");
  const controls = { ...DEFAULT_DIRECTION, ...value } as CreativeDirection;
  const shotSeconds = (key: "targetShotSeconds" | "minShotSeconds" | "maxShotSeconds", min: number, max: number): number => {
    const number = controls[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max) throw new Error(`${key} is outside its supported range.`);
    return Math.round(number * 2) / 2;
  };
  const dial = (key: "cutRateVsEnergy" | "brollAmount" | "performanceVsDance" | "freeformAmount" | "locationVariety" | "outfitChangeRate" | "continueBias"): number => {
    const number = controls[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${key} must be between 0 and 1.`);
    return Math.round(number * 20) / 20;
  };
  if (typeof controls.danceStyle !== "string" || !controls.danceStyle.trim() || controls.danceStyle.length > 80) throw new Error("Dance style must be a short label.");
  if (!RENDER_ASPECT_RATIOS.includes(controls.aspectRatio as typeof RENDER_ASPECT_RATIOS[number])) throw new Error("Choose a supported video aspect ratio.");
  if (typeof controls.renderMegapixels !== "number" || !Number.isFinite(controls.renderMegapixels) || controls.renderMegapixels <= 0) throw new Error("Video size must be greater than 0 megapixels.");
  for (const key of ["chorusConsistency", "hardCutsChangeLocation", "lipSync"] as const) if (typeof controls[key] !== "boolean") throw new Error(`${key} must be on or off.`);
  const targetShotSeconds = shotSeconds("targetShotSeconds", 2, 30);
  const minShotSeconds = shotSeconds("minShotSeconds", 1, 15);
  const maxShotSeconds = shotSeconds("maxShotSeconds", 0, 120);
  if (minShotSeconds > targetShotSeconds || (maxShotSeconds > 0 && targetShotSeconds > maxShotSeconds)) throw new Error("Clip lengths must be minimum ≤ desired ≤ maximum (or set maximum to 0 for no cap).");
  return {
    creativeBrief, storyWheel: value.storyWheel, minLocations: min, requestLocationImages: value.requestLocationImages,
    motifWeight: Math.round(weight * 20) / 20,
    danceStyle: controls.danceStyle.trim(), targetShotSeconds, minShotSeconds, maxShotSeconds,
    cutRateVsEnergy: dial("cutRateVsEnergy"), brollAmount: dial("brollAmount"), performanceVsDance: dial("performanceVsDance"),
    freeformAmount: dial("freeformAmount"), locationVariety: dial("locationVariety"), chorusConsistency: controls.chorusConsistency,
    outfitChangeRate: dial("outfitChangeRate"), continueBias: dial("continueBias"), hardCutsChangeLocation: controls.hardCutsChangeLocation,
    lipSync: controls.lipSync,
    aspectRatio: controls.aspectRatio, renderMegapixels: Math.round(controls.renderMegapixels * 100) / 100,
  };
}

export function normalizeBrief(brief: string): string {
  return brief.split(/\s+/).filter(Boolean).join(" ");
}

/** Everything that changes what Martini Shot Plan Story produces. Motif weight is deliberately absent: Plan Story has no
 *  such input; it is used later by Write Prompt Package. */
export type PlanInputs = {
  creativeBrief: string;
  storyWheel: boolean;
  minLocations: number;
  requestLocationImages: boolean;
  seed: number;
  directorLlm: string;
  /** Fingerprint of the project's song/reference files, names, and order (what Martini Shot Project saved). */
  assets: string;
};

export function assetFingerprint(assets: { role: string; checksum: string | null; displayName: string }[]): string {
  const hash = createHash("sha256");
  for (const asset of assets) hash.update(`${asset.role}\u0000${asset.checksum ?? ""}\u0000${asset.displayName}\n`);
  return hash.digest("hex");
}

export function planInputs(direction: CreativeDirection & { planSeed: number }, directorLlm: string, assets: string): PlanInputs {
  return {
    creativeBrief: normalizeBrief(direction.creativeBrief), storyWheel: direction.storyWheel, minLocations: direction.minLocations,
    requestLocationImages: direction.requestLocationImages, seed: direction.planSeed, directorLlm, assets,
  };
}

/** Compares the inputs a plan was made from with the current ones. `planned` null = no plan yet. */
export function planFreshness(planned: PlanInputs | null, current: PlanInputs): PlanFreshness {
  if (!planned) return { state: "none", reasons: [] };
  const reasons: string[] = [];
  if (planned.creativeBrief !== current.creativeBrief) reasons.push("The creative brief changed.");
  if (planned.storyWheel !== current.storyWheel) reasons.push(`Story Wheel was turned ${current.storyWheel ? "on" : "off"}.`);
  if (planned.minLocations !== current.minLocations) reasons.push(`Minimum performer locations changed from ${planned.minLocations} to ${current.minLocations}.`);
  if (planned.requestLocationImages !== current.requestLocationImages) {
    reasons.push(`Requesting location images was turned ${current.requestLocationImages ? "on" : "off"}.`);
  }
  if (planned.assets !== current.assets) reasons.push("The project's song or reference images changed.");
  if (planned.directorLlm !== current.directorLlm) reasons.push("The director LLM in Settings changed.");
  if (planned.seed !== current.seed) reasons.push("The planning seed changed.");
  return { state: reasons.length ? "stale" : "fresh", reasons };
}

/** Values for workflows/02-plan-story.json. The single brief feeds both Plan Story briefs: `creative_brief` becomes the
 *  Look/Motif/Event contract, and `story_brief` keeps arc wording ("start intimate, end cathartic") the contract drops. */
export function planWorkflowValues(projectSlugValue: string, inputs: PlanInputs, reroll: boolean): Record<string, unknown> {
  return {
    project_name: projectSlugValue, director_llm: inputs.directorLlm, creative_brief: inputs.creativeBrief, story_brief: inputs.creativeBrief,
    story_wheel: inputs.storyWheel, min_locations: inputs.minLocations, request_location_images: inputs.requestLocationImages,
    seed: inputs.seed, reset_plan_cache: reroll,
  };
}

/** Picks the Prompt LLM Loader option to use: the saved choice if ComfyUI offers it, else the model the existing
 *  Director workflows use, else the first vision model, else the first option. */
export const PREFERRED_DIRECTOR_LLM = "Qwen3-VL 8B (vision) | qwen3vl_8b_fp8_scaled.safetensors";
export function chooseDirectorLlm(saved: string, options: string[]): string | null {
  const usable = options.filter((option) => option.includes("|"));
  if (usable.includes(saved)) return saved;
  if (usable.includes(PREFERRED_DIRECTOR_LLM)) return PREFERRED_DIRECTOR_LLM;
  return usable.find((option) => option.includes("(vision)")) ?? usable[0] ?? null;
}

// ----- Report parsing --------------------------------------------------------------------------------------

/** Lines of one titled block ("Director cache:") in the Plan Story report, up to the next blank line. */
export function reportBlock(report: string, title: string): string[] {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === title);
  if (start < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    block.push(line);
  }
  return block;
}

export type CacheEvidence = { result: PlanCacheResult; details: string[]; resetSeed: { from: number; to: number } | null };

/** Reads the "Director cache" block MartiniShotPlanStory writes: `stage: HIT|MISS` per LLM call, plus `reset: …; seed A -> B`
 *  when reset_plan_cache was on. Location-image analysis has its own cache and is listed separately as context. */
export function cacheEvidence(report: string): CacheEvidence {
  const block = reportBlock(report, "Director cache:");
  const details = block.map((line) => line.trim()).filter(Boolean);
  let resetSeed: CacheEvidence["resetSeed"] = null;
  let hits = 0;
  let misses = 0;
  for (const line of details) {
    const reset = line.match(/^reset:.*seed\s+(\d+)\s*->\s*(\d+)/i);
    if (reset) { resetSeed = { from: Number(reset[1]), to: Number(reset[2]) }; continue; }
    if (/:\s*HIT$/i.test(line)) hits += 1;
    else if (/:\s*MISS$/i.test(line)) misses += 1;
  }
  const locations = reportBlock(report, "Location observations:").filter((line) => /^ {2}\S/.test(line) && /: (cache hit|analyzed|no usable analysis)$/.test(line));
  details.push(...locations.map((line) => `location photo ${line.trim()}`));
  let result: PlanCacheResult;
  if (resetSeed) result = "rerolled";
  else if (!hits && !misses) result = block.length || report.trim() ? "no_llm" : "unknown";
  else if (!misses) result = "reused";
  else if (!hits) result = "new";
  else result = "partly_reused";
  return { result, details, resetSeed };
}

export function reportWarnings(report: string): string[] {
  return report.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("WARNING:")).map((line) => line.slice(8).trim());
}

/** PreviewAny renders a BOOLEAN as "True"/"False". */
export function previewText(outputs: unknown, node: string): string | null {
  const text = (outputs as Record<string, { text?: unknown }> | null)?.[node]?.text;
  return Array.isArray(text) && typeof text[0] === "string" ? text[0] : null;
}

/** ComfyUI history status messages: did it reuse its in-memory result for these nodes instead of running them? */
export function cachedNodes(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const nodes: string[] = [];
  for (const message of messages) {
    if (Array.isArray(message) && message[0] === "execution_cached" && Array.isArray((message[1] as { nodes?: unknown })?.nodes)) {
      nodes.push(...((message[1] as { nodes: unknown[] }).nodes.map(String)));
    }
  }
  return nodes;
}

// ----- story_plan.json -------------------------------------------------------------------------------------

type RawSection = { start?: unknown; end?: unknown; role?: unknown; label?: unknown };
type RawBeat = Record<string, unknown>;
export type RawStoryPlan = {
  project?: unknown;
  analysis?: { duration?: unknown; bpm?: unknown; sections?: unknown };
  story?: unknown;
  creative_direction?: unknown;
  settings?: { story_wheel?: unknown; min_locations?: unknown; request_performer_location_images?: unknown; seed?: unknown };
  requested_locations?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const PHASE_WORDS: [StoryPhase, RegExp][] = [
  ["Release", /releas|resol|cathar|payoff|pay-off|aftermath|denouement|finale|ending|outro|afterglow|reconcil|epilogue/],
  ["Break", /break|climax|crisis|peak|ruptur|confront|collapse|shatter|low point|turning point/],
  ["Escalation", /escalat|rising|build|intensif|momentum|crescendo|pursuit|surge/],
  ["Friction", /friction|conflict|tension|complicat|inciting|disrupt|struggle|doubt|obstacle|unrest|restless/],
  ["Arrival", /arriv|establish|intro|opening|setup|set-up|exposition|beginning|ordinary|premise/],
];

/** Maps the planner's free-text phase word onto the five Story Wheel stages. */
export function wheelPhaseFor(phase: string): StoryPhase | null {
  const value = phase.toLowerCase();
  for (const [stage, pattern] of PHASE_WORDS) if (pattern.test(value)) return stage;
  return null;
}

function positionPhase(start: number, end: number, duration: number): StoryPhase {
  if (!(duration > 0)) return STORY_PHASES[0];
  const middle = (start + end) / 2 / duration;
  return STORY_PHASES[Math.min(STORY_PHASES.length - 1, Math.max(0, Math.floor(middle * STORY_PHASES.length)))];
}

/** Parses the `Look:` / `Recurring motif:` / `Required one-off event:` lines MartiniShotPlanStory stores as creative_direction. */
export function parseCreativeDirection(value: unknown): PlanData["creativeDirection"] {
  const contract = { look: "", motif: "", event: "" };
  for (const line of text(value).split(/\r?\n/)) {
    const match = line.match(/^\s*(Look|Recurring motif|Required one-off event):\s*(.+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase() === "look" ? "look" : match[1].toLowerCase().startsWith("recurring") ? "motif" : "event";
    contract[key] = match[2].trim();
  }
  return contract.look || contract.motif || contract.event ? contract : null;
}

/** Turns a story_plan.json written by MartiniShotPlanStory into the app's read-only plan model. */
export function parseStoryPlan(raw: RawStoryPlan, options: { projectPath: string; suppliedLocations: string[]; report: string }): PlanData {
  const analysis = raw.analysis;
  const rawSections = Array.isArray(analysis?.sections) ? analysis!.sections as RawSection[] : null;
  const duration = num(analysis?.duration);
  if (!rawSections?.length || duration === null) throw new Error("story_plan.json has no song sections.");
  const story = (raw.story && typeof raw.story === "object" ? raw.story : {}) as Record<string, RawBeat>;
  const settings = raw.settings ?? {};
  const requestEnabled = settings.request_performer_location_images !== false;
  const storyWheelSetting = settings.story_wheel === true;
  const supplied = new Map(options.suppliedLocations.map((name) => [name.toLowerCase(), name]));
  const requestedNames = Array.isArray(raw.requested_locations) ? raw.requested_locations.map(text).filter(Boolean) : [];
  const requestedSet = new Set(requestedNames.map((name) => name.toLowerCase()));

  const sections: PlanSection[] = rawSections.map((section, index) => {
    const number = index + 1;
    const beat = story[String(number)] ?? {};
    const start = num(section.start) ?? 0;
    const end = num(section.end) ?? start;
    const scene = text(beat.scene);
    const known = text(beat.location);
    const invented = text(beat.new_location);
    const location = known || invented;
    let locationMode: LocationMode = "rules";
    if (known) locationMode = supplied.has(known.toLowerCase()) ? "image_backed" : "text_only";
    else if (invented) {
      if (scene === "B-roll") locationMode = "text_only_broll";
      else locationMode = requestEnabled && requestedSet.has(invented.toLowerCase()) ? "requested" : "text_only";
    }
    const phase = text(beat.phase);
    return {
      number, start, end, role: text(section.role), label: text(section.label), scene, location, locationMode,
      beat: text(beat.beat), contrast: text(beat.contrast), phase, starts: text(beat.starts), turn: text(beat.turn), ends: text(beat.ends),
      wheelPhase: null, wheelPlacement: null,
    };
  });

  const storyWheel = storyWheelSetting && sections.some((section) => section.phase);
  if (storyWheel) {
    for (const section of sections) {
      const declared = wheelPhaseFor(section.phase);
      section.wheelPhase = declared ?? positionPhase(section.start, section.end, duration);
      section.wheelPlacement = declared ? "declared" : "position";
    }
  }

  const performerLocations: string[] = [];
  for (const section of sections) {
    if (section.scene === "B-roll" || !section.location) continue;
    if (!performerLocations.some((name) => name.toLowerCase() === section.location.toLowerCase())) performerLocations.push(section.location);
  }

  const requestedLocations: RequestedLocation[] = requestedNames.map((name) => {
    let fileName: string;
    try { fileName = `${projectSlug(name)}.png`; } catch { fileName = ""; }
    return {
      name, fileName, expectedPath: fileName ? path.join(options.projectPath, "locations", fileName) : "",
      sections: sections.filter((section) => section.location.toLowerCase() === name.toLowerCase()).map((section) => section.number),
    };
  });

  return {
    project: text(raw.project), durationSeconds: duration, bpm: num(analysis?.bpm), sections, storyWheel,
    creativeDirection: parseCreativeDirection(raw.creative_direction), seed: num(settings.seed) ?? 0,
    minLocations: num(settings.min_locations) ?? 0, requestLocationImages: requestEnabled, performerLocations, requestedLocations,
    suppliedLocations: options.suppliedLocations, warnings: reportWarnings(options.report),
    rulesOnly: !Object.keys(story).length,
  };
}

/** A comparable form of the story, to tell whether a new run changed it. */
export function storySignature(plan: PlanData): string {
  return JSON.stringify(plan.sections.map((section) => [section.scene, section.location, section.beat, section.phase, section.turn, section.ends]));
}
