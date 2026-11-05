// Pure song-timeline rules. No Electron or SQLite imports so they can be unit-tested with plain Node.
//
// previewCuts mirrors the shot timing of the Martini Shot nodes, so the Plan page can show where Produce will cut
// before any prompt package exists: mv_auto._cut_points/_cap_shots (shot starts per section) and the frame and
// first-shot rules of mv_plan.plan_video. Keep it in step with those functions.
import { TIMELINE_ROLES, TIMELINE_SCENES, TIMELINE_TRANSITIONS, type SongTimelineSection, type SongTimelineShot, type StoryPhase, type TimelineDraft, type TimelineScene, type TimelineTransition } from "./contracts";

export const FPS = 24;

export type AnalysisSection = { start: number; end: number; beatStart: number; beatEnd: number; label: string; role: string; energy: number; loudness: number };
export type SongAnalysis = { duration: number; bpm: number | null; beats: number[]; sections: AnalysisSection[] };
export type CutSettings = { targetShotSeconds: number; minShotSeconds: number; maxShotSeconds: number; cutRateVsEnergy: number };

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The `analysis` object of story_plan.json or song_analysis.json; null when it is missing or malformed. */
export function parseAnalysis(raw: unknown): SongAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const duration = num(value.duration);
  if (!duration || duration <= 0 || !Array.isArray(value.beats) || !Array.isArray(value.sections) || !value.sections.length) return null;
  const beats = value.beats.map(num).filter((beat): beat is number => beat !== null);
  if (beats.length !== value.beats.length) return null;
  const sections: AnalysisSection[] = [];
  for (const item of value.sections) {
    const section = (item ?? {}) as Record<string, unknown>;
    const start = num(section.start);
    const end = num(section.end);
    const beatStart = num(section.beat_start);
    const beatEnd = num(section.beat_end);
    if (start === null || end === null || beatStart === null || beatEnd === null || end <= start) return null;
    sections.push({
      start, end, beatStart, beatEnd, label: typeof section.label === "string" ? section.label : "",
      role: typeof section.role === "string" ? section.role : "", energy: num(section.energy) ?? 0.5, loudness: num(section.loudness) ?? 0,
    });
  }
  return { duration, bpm: num(value.bpm), beats, sections };
}

/** Python's round(): halves go to the even neighbour. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's min(items, key=...): the first item with the smallest key. */
function closest(items: number[], goal: number): number {
  let best = items[0];
  for (const item of items) if (Math.abs(item - goal) < Math.abs(best - goal)) best = item;
  return best;
}

/** mv_auto._cap_shots: split any shot longer than `maximum` on the bar line nearest its middle, until all fit (or can't). */
function capShots(input: number[], end: number, bars: number[], minimum: number, maximum: number): number[] {
  const starts = [...input];
  let changed = true;
  while (changed) {
    changed = false;
    const bounds = [...starts, end];
    for (let k = 0; k < starts.length; k++) {
      const a = bounds[k];
      const b = bounds[k + 1];
      if (b - a <= maximum) continue;
      const middle = (a + b) / 2;
      const inside = bars.filter((t) => a + minimum <= t && t <= b - minimum);
      const cut = closest(inside.length ? inside : [middle], middle);
      if (a < cut && cut < b) {
        starts.splice(k + 1, 0, cut);
        changed = true;
        break;
      }
    }
  }
  return starts;
}

/** mv_auto._cut_points: shot starts inside a section, roughly equal lengths on bar lines, shorter when the music is hotter. */
export function sectionCuts(section: AnalysisSection, beats: number[], settings: CutSettings): number[] {
  const { targetShotSeconds: target, minShotSeconds: minimum, maxShotSeconds: maximum, cutRateVsEnergy: cutRate } = settings;
  const length = section.end - section.start;
  const shotLength = Math.max(minimum, target * (1 - 0.5 * cutRate * (section.energy - 0.5) * 2));
  let count = Math.max(1, pyRound(length / shotLength));
  while (count > 1 && length / count < minimum) count -= 1;
  const bars: number[] = [];
  for (let i = section.beatStart; i < section.beatEnd; i += 4) if (i >= 0 && i < beats.length) bars.push(beats[i]);
  if (!bars.length) bars.push(section.start);
  let starts = [section.start];
  for (let k = 1; k < count; k++) {
    const goal = section.start + (length * k) / count;
    const bar = closest(bars, goal);
    if (bar - starts[starts.length - 1] >= minimum && section.end - bar >= minimum) starts.push(bar);
  }
  if (maximum > 0) starts = capShots(starts, section.end, bars, minimum, maximum);
  return starts;
}

const toFrame = (seconds: number) => pyRound(seconds * FPS);

/** Every shot Produce would cut from this analysis with these Direction timing settings, on the 24 fps frame grid.
 *  The first shot starts at 0:00 (as mv_plan.plan_video does). Scene type and transition are left to the director,
 *  except where the plan fixed a section's scene type. */
export function previewCuts(analysis: SongAnalysis, settings: CutSettings, sceneFor: (section: number) => TimelineScene | null = () => null): SongTimelineShot[] {
  const starts: { start: number; section: number }[] = [];
  analysis.sections.forEach((section, index) => {
    for (const start of sectionCuts(section, analysis.beats, settings)) starts.push({ start, section: index + 1 });
  });
  const total = toFrame(analysis.duration);
  const frames: { frame: number; section: number }[] = [];
  starts.forEach((item, index) => {
    const frame = index === 0 ? 0 : toFrame(item.start);
    if (frame >= total || (frames.length && frame <= frames[frames.length - 1].frame)) return;
    frames.push({ frame, section: item.section });
  });
  return frames.map((item, index) => ({
    number: index + 1, start: item.frame / FPS, end: (index + 1 < frames.length ? frames[index + 1].frame : total) / FPS,
    section: item.section, scene: sceneFor(item.section), transition: index === 0 ? "Hard cut" : null, clips: [], override: { scene: null, transition: null },
  }));
}

export function sceneOf(value: unknown): TimelineScene | null {
  return TIMELINE_SCENES.includes(value as TimelineScene) ? value as TimelineScene : null;
}

/** Sections for the timeline: the analysis timing, with the plan's scene type, action and Story Wheel phase when given. */
export function timelineSections(analysis: SongAnalysis, plan: { number: number; scene: string; beat: string; wheelPhase: StoryPhase | null }[] | null): SongTimelineSection[] {
  return analysis.sections.map((section, index) => {
    const planned = plan?.find((item) => item.number === index + 1);
    return {
      number: index + 1, start: section.start, end: section.end, label: section.label, role: section.role, energy: section.energy,
      loudness: section.loudness, origin: planned ? index + 1 : null,
      scene: sceneOf(planned?.scene), action: planned?.beat || null, phase: planned?.wheelPhase ?? null,
    };
  });
}

/** Groups a prompt package's clips into the shots they were cut from (consecutive clips with the same shot number). */
export function packageShots(clips: { index: number; shot: number | null; section: number | null; start: number; end: number; mode: string; transition: string; status: SongTimelineShot["clips"][number]["status"] }[]): SongTimelineShot[] {
  const shots: SongTimelineShot[] = [];
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    const last = shots[shots.length - 1];
    const lastClip = last?.clips[last.clips.length - 1];
    const sameShot = last && clip.shot !== null && lastClip && clips.find((item) => item.index === lastClip.index)?.shot === clip.shot;
    if (sameShot) {
      last.end = clip.end;
      last.clips.push({ index: clip.index, start: clip.start, end: clip.end, status: clip.status });
      continue;
    }
    shots.push({
      number: shots.length + 1, start: clip.start, end: clip.end, section: clip.section ?? 0, scene: sceneOf(clip.mode),
      transition: clip.transition || null, clips: [{ index: clip.index, start: clip.start, end: clip.end, status: clip.status }],
      override: { scene: null, transition: null },
    });
  }
  return shots;
}
