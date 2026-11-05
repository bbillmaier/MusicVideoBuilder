import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineDraft } from "./contracts";
import {
  automaticShots, deleteSection, deleteShot, mergeSections, mergeShots, moveSectionBoundary, moveShotCut, setSectionRole, shortShots, snapTime,
  splitSection, splitShot, validateDraft,
} from "./timeline-edit";

const beats = Array.from({ length: 81 }, (_, i) => i * 0.5); // 120 BPM, a bar every 2 s
const section = (start: number, end: number, origin: number | null, role = "verse") => ({ start, end, role, label: "A", energy: 0.5, loudness: 0.1, origin });
const shot = (start: number) => ({ start, scene: null, transition: null });
// two sections (0–20, 20–40) with cuts at 0, 8, 20, 30
const base = (): TimelineDraft => ({ sections: [section(0, 20, 1), section(20, 40, 2, "chorus")], shots: [shot(0), shot(8), shot(20), shot(30)] });

test("snapTime snaps to beats or bar lines on the frame grid", () => {
  assert.equal(snapTime(3.2, beats, "beat"), 3);
  assert.equal(snapTime(3.2, beats, "bar"), 4);
  assert.equal(snapTime(3.21, beats, "none"), Math.round(3.21 * 24) / 24);
});

test("splitSection makes two new-story sections and a cut", () => {
  const draft = splitSection(base(), 12);
  assert.deepEqual(draft.sections.map((s) => [s.start, s.end, s.origin]), [[0, 12, null], [12, 20, null], [20, 40, 2]]);
  assert.deepEqual(draft.shots.map((s) => s.start), [0, 8, 12, 20, 30]);
  assert.throws(() => splitSection(base(), 0.5), /at least/);
});

test("mergeSections keeps the first-clicked section's role and needs a new story", () => {
  const draft = mergeSections(base(), 1, 0);
  assert.equal(draft.sections.length, 1);
  assert.deepEqual([draft.sections[0].start, draft.sections[0].end, draft.sections[0].role, draft.sections[0].origin], [0, 40, "chorus", null]);
  assert.deepEqual(draft.shots.map((s) => s.start), [0, 8, 20, 30]); // the old edge stays a shot cut
  assert.equal(deleteSection(base(), 1).sections[0].role, "verse"); // delete: the previous section absorbs
});

test("moving a section edge keeps both stories and removes cuts it passes", () => {
  const draft = moveSectionBoundary(base(), 1, 6);
  assert.deepEqual(draft.sections.map((s) => [s.start, s.end, s.origin]), [[0, 6, 1], [6, 40, 2]]);
  assert.deepEqual(draft.shots.map((s) => s.start), [0, 6, 30]);
});

test("a cut next to a moving section edge stays until its shot becomes too short", () => {
  // shrinking section 1 from 20 s to 12 s: the shot 8–12 is still valid, so the cut at 8 stays
  assert.deepEqual(moveSectionBoundary(base(), 1, 12).shots.map((s) => s.start), [0, 8, 12, 30]);
  // at 8.1 s the shot 8–8.1 would be under the minimum, so that cut goes and shot 1 runs to the edge
  assert.deepEqual(moveSectionBoundary(base(), 1, 8.1).shots.map((s) => s.start), [0, 8.1, 30]);
  // growing it to 29 s keeps the cut at 30 (shot 29–30 is valid); dragging back restores everything
  assert.deepEqual(moveSectionBoundary(base(), 1, 29).shots.map((s) => s.start), [0, 8, 29, 30]);
  assert.deepEqual(moveSectionBoundary(moveSectionBoundary(base(), 1, 29), 1, 20).shots.map((s) => s.start), [0, 8, 20, 30]);
});

test("setSectionRole changes only the role", () => {
  const draft = setSectionRole(base(), 0, "intro");
  assert.deepEqual([draft.sections[0].role, draft.sections[0].origin], ["intro", 1]);
  assert.throws(() => setSectionRole(base(), 0, "solo"), /Unknown/);
});

test("shot split, merge, delete and move keep the section edges", () => {
  assert.deepEqual(splitShot(base(), 4, 40).shots.map((s) => s.start), [0, 4, 8, 20, 30]);
  const merged = mergeShots({ ...base(), shots: base().shots.map((s, i) => (i === 1 ? { ...s, scene: "Dance" as const } : s)) }, 1, 0);
  assert.deepEqual(merged.shots.map((s) => [s.start, s.scene]), [[0, "Dance"], [20, null], [30, null]]); // first clicked absorbs
  assert.throws(() => mergeShots(base(), 1, 2), /different sections/);
  assert.deepEqual(deleteShot(base(), 3).shots.map((s) => s.start), [0, 8, 20]);
  assert.throws(() => moveShotCut(base(), 2, 22, 40), /section edge/);
  assert.equal(moveShotCut(base(), 1, 25, 40).shots[1].start, 20 - 0.3); // clamped inside its neighbours
});

test("shortShots flags shots under the minimum", () => {
  assert.deepEqual(shortShots(splitShot(base(), 1, 40), 40, 3), [1]);
});

test("validateDraft cleans origins, snaps to frames and refuses broken timelines", () => {
  const clean = validateDraft({ ...base(), sections: [section(0, 20, 7), section(20, 40, 2)] }, 40, 2);
  assert.deepEqual(clean.sections.map((s) => s.origin), [null, 2]); // 7 is not a plan section
  assert.throws(() => validateDraft({ ...base(), shots: [shot(0), shot(8)] }, 40, 2), /start with a cut/);
  assert.throws(() => validateDraft({ ...base(), sections: [section(0, 19, 1), section(20, 40, 2)] }, 40, 2), /without a gap/);
});

test("automaticShots rebuilds cuts from Direction timing for the current sections", () => {
  const draft = automaticShots(base(), beats, { targetShotSeconds: 8, minShotSeconds: 3, maxShotSeconds: 10, cutRateVsEnergy: 0.5 });
  assert.deepEqual(draft.shots.map((s) => s.start), [0, 10, 20, 30]);
});
