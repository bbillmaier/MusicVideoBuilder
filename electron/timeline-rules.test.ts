import assert from "node:assert/strict";
import test from "node:test";
import { packageShots, parseAnalysis, previewCuts, pyRound, sectionCuts, timelineSections, type AnalysisSection, type CutSettings } from "./timeline-rules";

const beats = Array.from({ length: 81 }, (_, i) => i * 0.5); // 120 BPM, a bar every 2 s
const section = (start: number, end: number, energy = 0.5): AnalysisSection =>
  ({ start, end, beatStart: start * 2, beatEnd: end * 2, label: "A", role: "verse", energy, loudness: 0 });
const settings: CutSettings = { targetShotSeconds: 8, minShotSeconds: 3, maxShotSeconds: 10, cutRateVsEnergy: 0.5 };

test("pyRound rounds halves to even like Python", () => {
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, 2.4, 2.6].map(pyRound), [0, 2, 2, 4, 2, 3]);
});

test("sectionCuts places equal shots on bar lines", () => {
  assert.deepEqual(sectionCuts(section(0, 32), beats, settings), [0, 8, 16, 24]);
});

test("sectionCuts splits shots longer than the maximum at the bar nearest the middle (first on ties)", () => {
  assert.deepEqual(sectionCuts(section(0, 30), beats, { ...settings, targetShotSeconds: 30 }), [0, 6, 14, 22]);
  assert.deepEqual(sectionCuts(section(0, 30), beats, { ...settings, targetShotSeconds: 30, maxShotSeconds: 0 }), [0]);
});

test("hotter sections get shorter shots", () => {
  const calm = sectionCuts(section(0, 32, 0.1), beats, settings).length;
  const hot = sectionCuts(section(0, 32, 0.95), beats, settings).length;
  assert.ok(hot > calm, `${hot} > ${calm}`);
});

test("previewCuts covers the whole song on the frame grid and keeps plan scenes", () => {
  const analysis = { duration: 40, bpm: 120, beats, sections: [section(0, 32), section(32, 40)] };
  const shots = previewCuts(analysis, settings, (number) => (number === 2 ? "Performance" : null));
  assert.deepEqual(shots.map((shot) => [shot.start, shot.end, shot.section]), [[0, 8, 1], [8, 16, 1], [16, 24, 1], [24, 32, 1], [32, 40, 2]]);
  assert.equal(shots[4].scene, "Performance");
  assert.equal(shots[0].transition, "Hard cut");
  assert.equal(shots[1].transition, null);
});

test("parseAnalysis reads story_plan.json analysis and rejects malformed input", () => {
  const raw = { duration: 40, bpm: 120, beats, sections: [{ start: 0, end: 40, beat_start: 0, beat_end: 80, label: "A", role: "verse", energy: 0.4 }] };
  assert.equal(parseAnalysis(raw)?.sections[0].beatEnd, 80);
  assert.equal(parseAnalysis({ ...raw, sections: [] }), null);
  assert.equal(parseAnalysis({ ...raw, beats: ["x"] }), null);
  assert.equal(parseAnalysis(null), null);
});

test("timelineSections adds the plan's scene and action", () => {
  const analysis = { duration: 40, bpm: 120, beats, sections: [section(0, 20), section(20, 40)] };
  const sections = timelineSections(analysis, [{ number: 2, scene: "B-roll", beat: "Rain on glass", wheelPhase: "Arrival" }]);
  assert.equal(sections[0].scene, null);
  assert.deepEqual([sections[1].scene, sections[1].action, sections[1].phase], ["B-roll", "Rain on glass", "Arrival"]);
});

test("packageShots groups a shot's render clips", () => {
  const clip = (index: number, shot: number, start: number, end: number) =>
    ({ index, shot, section: 1, start, end, mode: "Dance", transition: index === 3 ? "New angle" : "Continue", status: "pending" as const });
  const shots = packageShots([clip(1, 1, 0, 5), clip(2, 1, 5, 9), clip(3, 2, 9, 12)]);
  assert.deepEqual(shots.map((shot) => [shot.start, shot.end, shot.clips.length, shot.transition]), [[0, 9, 2, "Continue"], [9, 12, 1, "New angle"]]);
});
