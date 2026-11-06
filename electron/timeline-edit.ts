// Pure editing operations on a song TimelineDraft, shared by the Plan page (live editing) and Electron main (validation
// on save). No Electron or Node imports.
//
// Invariants: sections cover 0..duration without gaps; shot starts are sorted and unique; every section start is a shot
// start; all cuts sit on the 24 fps frame grid. Operations return a new draft, or throw an Error with a readable message.
import { TIMELINE_ROLES, TIMELINE_SCENES, TIMELINE_TRANSITIONS, type TimelineDraft, type TimelineScene, type TimelineTransition } from "./contracts";
import { FPS, pyRound, sectionCuts, type CutSettings } from "./timeline-rules";

export const MIN_SECTION_SECONDS = 1;
/** About one beat at 172 BPM. Shorter than Direction's minimum shot length is allowed, with a warning. */
export const MIN_SHOT_SECONDS = 0.3;
const EPS = 1e-3;

export const frameTime = (seconds: number) => pyRound(seconds * FPS) / FPS;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
const clone = (draft: TimelineDraft): TimelineDraft => ({ sections: draft.sections.map((s) => ({ ...s })), shots: draft.shots.map((s) => ({ ...s })) });

/** The nearest beat (or bar line: every fourth beat from the first) to `time`, on the frame grid. */
export function snapTime(time: number, beats: number[], to: "beat" | "bar" | "none"): number {
  const grid = to === "bar" ? beats.filter((_, index) => index % 4 === 0) : to === "beat" ? beats : [];
  if (!grid.length) return frameTime(time);
  let best = grid[0];
  for (const item of grid) if (Math.abs(item - time) < Math.abs(best - time)) best = item;
  return frameTime(best);
}

export function sectionIndexAt(draft: TimelineDraft, time: number): number {
  const index = draft.sections.findIndex((section) => time >= section.start - EPS && time < section.end - EPS);
  return index < 0 ? draft.sections.length - 1 : index;
}

export function shotIndexAt(draft: TimelineDraft, time: number): number {
  let found = 0;
  draft.shots.forEach((shot, index) => { if (shot.start <= time + EPS) found = index; });
  return found;
}

export function shotEnd(draft: TimelineDraft, index: number, duration: number): number {
  return index + 1 < draft.shots.length ? draft.shots[index + 1].start : duration;
}

export function isSectionStart(draft: TimelineDraft, time: number): boolean {
  return draft.sections.some((section) => near(section.start, time));
}

function addCut(draft: TimelineDraft, time: number, copyFrom?: number): void {
  if (draft.shots.some((shot) => near(shot.start, time))) return;
  const source = copyFrom === undefined ? null : draft.shots[copyFrom];
  draft.shots.push({ start: time, scene: source?.scene ?? null, transition: null });
  draft.shots.sort((a, b) => a.start - b.start);
}

/** Ctrl+click on the sections row: the section at `time` becomes two. Both halves get a new story when a plan exists. */
export function splitSection(input: TimelineDraft, time: number): TimelineDraft {
  const draft = clone(input);
  const index = sectionIndexAt(draft, time);
  const section = draft.sections[index];
  if (time - section.start < MIN_SECTION_SECONDS || section.end - time < MIN_SECTION_SECONDS) {
    throw new Error(`A section must be at least ${MIN_SECTION_SECONDS} s long. Split further from its edges.`);
  }
  const close = draft.shots.find((shot) => Math.abs(shot.start - time) < MIN_SHOT_SECONDS && !near(shot.start, time));
  if (close) throw new Error(`There is a cut at ${fmt(close.start)}, too close to split here. Split on that cut, or further away.`);
  const from = shotIndexAt(draft, time);
  draft.sections.splice(index, 1, { ...section, end: time, origin: null }, { ...section, start: time, origin: null });
  addCut(draft, time, from);
  return draft;
}

/** Click, then Shift+click: section `keep` absorbs `absorb` (and any sections between). The kept role and label stay,
 *  and the merged section gets a new story when a plan exists. The cut at a removed edge stays as a shot cut. */
export function mergeSections(input: TimelineDraft, keep: number, absorb: number): TimelineDraft {
  if (keep === absorb) throw new Error("Shift+click a different section to merge it into the selected one.");
  const draft = clone(input);
  const [first, last] = keep < absorb ? [keep, absorb] : [absorb, keep];
  const parts = draft.sections.slice(first, last + 1);
  const length = parts.reduce((sum, part) => sum + (part.end - part.start), 0);
  const weighted = (key: "energy" | "loudness") => parts.reduce((sum, part) => sum + part[key] * (part.end - part.start), 0) / length;
  const kept = draft.sections[keep];
  draft.sections.splice(first, last - first + 1, {
    ...kept, start: parts[0].start, end: parts[parts.length - 1].end, energy: weighted("energy"), loudness: weighted("loudness"), origin: null,
  });
  return draft;
}

/** Delete a section: its neighbour (the previous one, or the next for the first section) absorbs it. */
export function deleteSection(input: TimelineDraft, index: number): TimelineDraft {
  if (input.sections.length < 2) throw new Error("The song needs at least one section.");
  return mergeSections(input, index === 0 ? 1 : index - 1, index);
}

/** Drag the edge at the start of section `index`. Story beats are kept; only the lengths change. Shot cuts the edge
 *  passes over (or lands too close to) are removed. */
export function moveSectionBoundary(input: TimelineDraft, index: number, time: number): TimelineDraft {
  if (index <= 0 || index >= input.sections.length) throw new Error("That edge can't move.");
  const draft = clone(input);
  const before = draft.sections[index - 1];
  const after = draft.sections[index];
  const target = Math.min(Math.max(time, before.start + MIN_SECTION_SECONDS), after.end - MIN_SECTION_SECONDS);
  const old = after.start;
  const low = Math.min(old, target) - MIN_SHOT_SECONDS;
  const high = Math.max(old, target) + MIN_SHOT_SECONDS;
  draft.shots = draft.shots.filter((shot) => near(shot.start, old) || isSectionStart(draft, shot.start) || shot.start <= low || shot.start >= high);
  const moved = draft.shots.find((shot) => near(shot.start, old));
  if (moved) moved.start = target; else addCut(draft, target);
  draft.shots.sort((a, b) => a.start - b.start);
  before.end = target;
  after.start = target;
  return draft;
}

export function setSectionRole(input: TimelineDraft, index: number, role: string): TimelineDraft {
  if (!(TIMELINE_ROLES as readonly string[]).includes(role)) throw new Error(`Unknown section role "${role}".`);
  const draft = clone(input);
  draft.sections[index].role = role;
  return draft;
}

/** Ctrl+click on the shots row: a new cut at `time`. The new shot keeps the scene choice of the shot it came from. */
export function splitShot(input: TimelineDraft, time: number, duration: number): TimelineDraft {
  const draft = clone(input);
  const index = shotIndexAt(draft, time);
  const start = draft.shots[index].start;
  const end = shotEnd(draft, index, duration);
  if (time - start < MIN_SHOT_SECONDS || end - time < MIN_SHOT_SECONDS) throw new Error(`A shot must be at least ${MIN_SHOT_SECONDS} s long.`);
  addCut(draft, time, index);
  return draft;
}

/** Click, then Shift+click: shot `keep` absorbs `absorb` (and any shots between). Shots never cross a section edge. */
export function mergeShots(input: TimelineDraft, keep: number, absorb: number): TimelineDraft {
  if (keep === absorb) throw new Error("Shift+click a different shot to merge it into the selected one.");
  const draft = clone(input);
  const [first, last] = keep < absorb ? [keep, absorb] : [absorb, keep];
  if (draft.shots.slice(first + 1, last + 1).some((shot) => isSectionStart(draft, shot.start))) {
    throw new Error("Shots in different sections can't be merged. Merge the sections first, or move the section edge.");
  }
  const kept = draft.shots[keep];
  draft.shots.splice(first, last - first + 1, { ...kept, start: draft.shots[first].start });
  return draft;
}

/** Delete a shot: the previous shot in its section absorbs it (or the next one, for a section's first shot). */
export function deleteShot(input: TimelineDraft, index: number): TimelineDraft {
  const starts = isSectionStart(input, input.shots[index].start);
  const neighbour = starts ? index + 1 : index - 1;
  if (neighbour < 0 || neighbour >= input.shots.length || (starts && isSectionStart(input, input.shots[neighbour].start))) {
    throw new Error("This is the only shot in its section. Delete or merge the section instead.");
  }
  return mergeShots(input, neighbour, index);
}

/** Drag the cut at the start of shot `index`. A section's first cut moves with the section edge instead. */
export function moveShotCut(input: TimelineDraft, index: number, time: number, duration: number): TimelineDraft {
  if (index <= 0 || isSectionStart(input, input.shots[index].start)) throw new Error("This cut is a section edge. Drag the section edge instead.");
  const draft = clone(input);
  const low = draft.shots[index - 1].start + MIN_SHOT_SECONDS;
  const high = shotEnd(draft, index, duration) - MIN_SHOT_SECONDS;
  draft.shots[index].start = Math.min(Math.max(time, low), high);
  return draft;
}

export function setShotScene(input: TimelineDraft, index: number, scene: TimelineScene | null): TimelineDraft {
  const draft = clone(input);
  draft.shots[index].scene = scene;
  return draft;
}

export function setShotTransition(input: TimelineDraft, index: number, transition: TimelineTransition | null): TimelineDraft {
  const draft = clone(input);
  draft.shots[index].transition = transition;
  return draft;
}

/** Shot numbers shorter than Direction's minimum shot length (allowed; the renderer still makes ~5 s and trims). */
export function shortShots(draft: TimelineDraft, duration: number, minimum: number): number[] {
  return draft.shots.map((shot, index) => ({ index, length: shotEnd(draft, index, duration) - shot.start }))
    .filter((item) => item.length < minimum - EPS).map((item) => item.index + 1);
}

/** Validates a draft from the renderer against the song and returns a clean copy. Throws a readable error. */
export function validateDraft(raw: unknown, duration: number, planSectionCount: number): TimelineDraft {
  const value = (raw ?? {}) as { sections?: unknown; shots?: unknown };
  if (!Array.isArray(value.sections) || !Array.isArray(value.shots) || !value.sections.length || !value.shots.length) throw new Error("The timeline is empty.");
  if (value.sections.length > 200 || value.shots.length > 1000) throw new Error("The timeline has too many sections or shots.");
  const count = value.sections.length;
  const origins = new Set<number>();
  const sections = value.sections.map((item, index) => {
    const section = (item ?? {}) as Record<string, unknown>;
    const start = index === 0 ? 0 : frameTime(num(section.start) ?? NaN);
    const end = index === count - 1 ? duration : frameTime(num(section.end) ?? NaN);
    let origin = num(section.origin);
    if (origin !== null && (!Number.isInteger(origin) || origin < 1 || origin > planSectionCount || origins.has(origin))) origin = null;
    if (origin !== null) origins.add(origin);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < MIN_SECTION_SECONDS - EPS) {
      throw new Error(`Section ${index + 1} must be at least ${MIN_SECTION_SECONDS} s long.`);
    }
    return {
      start, end, role: typeof section.role === "string" && section.role ? section.role.slice(0, 40) : "verse",
      label: typeof section.label === "string" && section.label ? section.label.slice(0, 8) : "A",
      energy: Math.min(1, Math.max(0, num(section.energy) ?? 0.5)), loudness: Math.max(0, num(section.loudness) ?? 0), origin,
    };
  });
  sections.forEach((section, index) => {
    if (index > 0 && !near(sections[index - 1].end, section.start)) throw new Error(`Sections ${index} and ${index + 1} must meet without a gap.`);
  });
  const shots = value.shots.map((item) => {
    const shot = (item ?? {}) as Record<string, unknown>;
    const start = frameTime(num(shot.start) ?? NaN);
    if (!Number.isFinite(start) || start < 0 || start >= duration) throw new Error("A shot starts outside the song.");
    return {
      start, scene: TIMELINE_SCENES.includes(shot.scene as TimelineScene) ? shot.scene as TimelineScene : null,
      transition: (TIMELINE_TRANSITIONS as readonly unknown[]).includes(shot.transition) ? shot.transition as TimelineTransition : null,
    };
  }).sort((a, b) => a.start - b.start);
  shots[0].start = 0;
  shots.forEach((shot, index) => {
    if (index > 0 && shot.start - shots[index - 1].start < MIN_SHOT_SECONDS - EPS) {
      throw new Error(`The shots at ${fmt(shots[index - 1].start)} and ${fmt(shot.start)} are too close together.`);
    }
  });
  sections.forEach((section, index) => {
    if (!shots.some((shot) => near(shot.start, section.start))) throw new Error(`Section ${index + 1} must start with a cut.`);
  });
  if (duration - shots[shots.length - 1].start < MIN_SHOT_SECONDS - EPS) throw new Error("The last shot is too short.");
  return { sections, shots };
}

/** Replaces every shot with the automatic cuts for the draft's sections (Direction timing settings), as Produce would
 *  cut them without a saved timeline. Scene and transition choices go back to Auto. */
export function automaticShots(input: TimelineDraft, beats: number[], settings: CutSettings): TimelineDraft {
  const draft = clone(input);
  const beatIndex = (time: number) => { let index = 0; while (index < beats.length && beats[index] < time - 1e-6) index++; return index; };
  const starts: number[] = [];
  draft.sections.forEach((section, index) => {
    const analysis = {
      start: section.start, end: section.end, beatStart: index === 0 ? 0 : beatIndex(section.start),
      beatEnd: index === draft.sections.length - 1 ? beats.length : beatIndex(section.end), label: section.label, role: section.role,
      energy: section.energy, loudness: section.loudness,
    };
    for (const start of sectionCuts(analysis, beats, settings, index + 1)) {
      const time = index === 0 && start === section.start ? 0 : frameTime(start);
      if (!starts.length || time - starts[starts.length - 1] >= MIN_SHOT_SECONDS - EPS) starts.push(time);
    }
  });
  draft.shots = starts.map((start) => ({ start, scene: null, transition: null }));
  return draft;
}
