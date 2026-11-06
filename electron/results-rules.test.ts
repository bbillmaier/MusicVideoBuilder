import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { PlanData } from "./contracts";
import {
  buildDirectorReport, clipsChangedSince, finalState, formatRanges, mp4Duration, outcomeFor, parseClipSelection, parseFinalizeReport,
  eventMentioned, reportFileName, requiredEventAllocation, requiredEventStatuses, stitchBlockers, stitchWorkflowValues, summarizeClips, wheelRanges, withContinuations,
  type ReadinessInput, type ReportInput,
} from "./results-rules";
import { applyTemplateValues } from "./workflow-template";

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const FOLDER = String.raw`E:\out\martini_shot\static-heart\render-01`;

function readiness(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    projectFolderExists: true, projectPath: String.raw`E:\out\martini_shot\static-heart`, pkg: { folder: FOLDER, clipCount: 3 },
    renderPackageFolder: FOLDER, manifestClipCount: 3, samePath, busy: null, packageWriting: false,
    clips: [1, 2, 3].map((index) => ({ index, status: "rendered", error: null, attempts: 1 })),
    ...overrides,
  };
}

// Exactly the lines MiniMaxH3StitchSongSegments.stitch writes.
const FINALIZE_REPORT = [
  String.raw`Stitched 3 segments into E:\out\martini_shot\static-heart\render-01\final_2.mp4`,
  "1024x768 h264 at 24.00 fps, original song audio",
].join("\n");

test("Finalize Video report: path, encoding, and partial test stitch", () => {
  const parsed = parseFinalizeReport(FINALIZE_REPORT);
  assert.equal(parsed.segments, 3);
  assert.equal(parsed.target, `${FOLDER}\\final_2.mp4`);
  assert.equal(parsed.info, "1024x768 h264 at 24.00 fps, original song audio");
  assert.equal(parsed.partial, null);
  const partial = parseFinalizeReport(`${FINALIZE_REPORT}\nTEST STITCH of clips 1-2: 1 clip(s) missing (3).`);
  assert.match(partial.partial ?? "", /^TEST STITCH of clips 1-2/);
  assert.deepEqual(parseFinalizeReport(null), { segments: null, target: null, info: null, partial: null });
});

test("stitch is allowed only when every clip is rendered and the saved package points at it", () => {
  assert.deepEqual(stitchBlockers(readiness()), []);
  const blocked = stitchBlockers(readiness({
    clips: [
      { index: 1, status: "rendered", error: null, attempts: 1 },
      { index: 2, status: "failed", error: "ComfyUI ran out of GPU memory", attempts: 2 },
      { index: 3, status: "pending", error: null, attempts: 0 },
    ],
  }));
  assert.equal(blocked.length, 2);
  assert.match(blocked[0], /^Clip 2 failed \(attempt 2\): ComfyUI ran out of GPU memory/);
  assert.match(blocked[1], /^Not rendered yet: clip 3\./);
  const vanished = stitchBlockers(readiness({ clips: [{ index: 1, status: "pending", error: "The rendered file is no longer in the package folder.", attempts: 1 }], pkg: { folder: FOLDER, clipCount: 1 }, manifestClipCount: 1 }));
  assert.match(vanished[0], /Clip 1's rendered file is no longer in the package folder/);
  assert.match(stitchBlockers(readiness({ clips: [1, 2, 3].map((index) => ({ index, status: "interrupted", error: null, attempts: 1 })) }))[0], /Clip 1 was interrupted/);
});

test("stitch blockers: package, render_package.json, segments.json, and busy work", () => {
  assert.match(stitchBlockers(readiness({ pkg: null }))[0], /no prompt package/);
  assert.match(stitchBlockers(readiness({ renderPackageFolder: undefined }))[0], /render_package\.json is missing/);
  assert.match(stitchBlockers(readiness({ renderPackageFolder: `${FOLDER}_2` }))[0], /points at .*render-01_2/);
  assert.deepEqual(stitchBlockers(readiness({ renderPackageFolder: FOLDER.toUpperCase() })), []);
  assert.match(stitchBlockers(readiness({ manifestClipCount: 4 }))[0], /segments\.json lists 4 clips/);
  assert.match(stitchBlockers(readiness({ manifestClipCount: null }))[0], /segments\.json .* missing or unreadable/);
  assert.match(stitchBlockers(readiness({ busy: { kind: "render", sameProject: true } }))[0], /still rendering/);
  assert.match(stitchBlockers(readiness({ busy: { kind: "stitch", sameProject: false } }))[0], /Another project/);
  assert.match(stitchBlockers(readiness({ projectFolderExists: false }))[0], /project folder is missing/);
  assert.match(stitchBlockers(readiness({ clips: [1, 2, 3].map((index) => ({ index, status: index === 2 ? "rendering" : "rendered", error: null, attempts: 1 })) }))[0], /Rendering now: clip 2/);
});

test("final state", () => {
  assert.equal(finalState({ active: true, blockers: ["x"], latest: null }), "stitching");
  assert.equal(finalState({ active: false, blockers: [], latest: null }), "ready");
  assert.equal(finalState({ active: false, blockers: ["x"], latest: null }), "blocked");
  assert.equal(finalState({ active: false, blockers: [], latest: { status: "complete", fileExists: true, clipsChangedSince: false } }), "complete");
  // A finished video stays "complete" even if, say, render_package.json changed afterwards; its clips are what count.
  assert.equal(finalState({ active: false, blockers: ["x"], latest: { status: "complete", fileExists: true, clipsChangedSince: false } }), "complete");
  assert.equal(finalState({ active: false, blockers: [], latest: { status: "complete", fileExists: true, clipsChangedSince: true } }), "ready");
  assert.equal(finalState({ active: false, blockers: [], latest: { status: "complete", fileExists: false, clipsChangedSince: false } }), "ready");
  assert.equal(finalState({ active: false, blockers: [], latest: { status: "failed", fileExists: false, clipsChangedSince: false } }), "failed");
  assert.equal(finalState({ active: false, blockers: ["x"], latest: { status: "interrupted", fileExists: false, clipsChangedSince: false } }), "blocked");
});

test("clip summary and change detection against the stitched files", () => {
  const clips = [
    { index: 1, status: "rendered", attempts: 1, outputPath: `${FOLDER}\\segment_01_00001_.mp4` },
    { index: 2, status: "rendered", attempts: 3, outputPath: `${FOLDER}\\segment_02_00002_.mp4` },
  ];
  const summary = summarizeClips(clips);
  assert.equal(summary.rendered, 2);
  assert.deepEqual(summary.retried, [2]);
  assert.equal(summary.attempts, 4);
  assert.equal(clipsChangedSince(summary.outputs, clips, samePath), false);
  assert.equal(clipsChangedSince(summary.outputs, [clips[0], { ...clips[1], outputPath: `${FOLDER}\\segment_02_00003_.mp4` }], samePath), true);
  assert.equal(clipsChangedSince(summary.outputs, [clips[0], { ...clips[1], status: "pending", outputPath: null }], samePath), true);
  assert.equal(clipsChangedSince(undefined, clips, samePath), false);
});

test("re-render selection and continuation chains", () => {
  assert.deepEqual(parseClipSelection("3, 7-9", 10), [3, 7, 8, 9]);
  assert.deepEqual(parseClipSelection("2–3 2", 5), [2, 3]);
  assert.throws(() => parseClipSelection("", 5), /Enter the clip numbers/);
  assert.throws(() => parseClipSelection("6", 5), /clips 1–5/);
  assert.throws(() => parseClipSelection("4-2", 5), /backwards/);
  assert.throws(() => parseClipSelection("a", 5), /not a clip number/);
  const clips = [
    { index: 1, transition: "Hard cut", overlapFrames: 0 }, { index: 2, transition: "Continue", overlapFrames: 22 },
    { index: 3, transition: "Continue", overlapFrames: 22 }, { index: 4, transition: "New angle", overlapFrames: 22 },
    { index: 5, transition: "Continue", overlapFrames: 0 },
  ];
  assert.deepEqual(withContinuations([1], clips), { clips: [1, 2, 3, 4], added: [2, 3, 4] });
  assert.deepEqual(withContinuations([2, 4], clips), { clips: [2, 3, 4], added: [3] });
  assert.deepEqual(withContinuations([3], clips), { clips: [3, 4], added: [4] });
  assert.equal(formatRanges([9, 1, 2, 3, 5, 7, 8]), "1–3, 5, 7–9");
  assert.equal(reportFileName("final_2.mp4"), "final_2-director-report.md");
});

test("MP4 duration from moov/mvhd (version 0 and 1)", () => {
  const box = (type: string, body: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length, 0); head.write(type, 4, "latin1"); return Buffer.concat([head, body]); };
  const mvhd0 = Buffer.alloc(100); mvhd0.writeUInt32BE(1000, 12); mvhd0.writeUInt32BE(175_000, 16);
  const file0 = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", Buffer.concat([box("mvhd", mvhd0), box("trak", Buffer.alloc(20))])), box("mdat", Buffer.alloc(64))]);
  const reader = (file: Buffer) => (offset: number, length: number) => file.subarray(offset, offset + length);
  assert.equal(mp4Duration(reader(file0), file0.length), 175);
  const mvhd1 = Buffer.alloc(112); mvhd1[0] = 1; mvhd1.writeUInt32BE(90_000, 20); mvhd1.writeBigUInt64BE(9_000_000n, 24);
  const file1 = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(32)), box("moov", box("mvhd", mvhd1))]);
  assert.equal(mp4Duration(reader(file1), file1.length), 100);
  assert.equal(mp4Duration(reader(Buffer.from("not an mp4 at all")), 17), null);
});

const PLAN: PlanData = {
  project: "static-heart", durationSeconds: 175, bpm: 120, storyWheel: true, seed: 7, minLocations: 0, requestLocationImages: true,
  creativeDirection: { look: "Blue/pink night look", motif: "Static electricity", event: "lightning strike" },
  performerLocations: ["Laundromat", "Glass storefront corridor"], suppliedLocations: ["Laundromat"],
  requestedLocations: [{ name: "Glass storefront corridor", fileName: "glass-storefront-corridor.png", expectedPath: "x", sections: [2] }],
  warnings: [], rulesOnly: false,
  sections: [1, 2, 3].map((number) => ({
    number, start: (number - 1) * 10, end: number * 10, role: "verse", label: "A", scene: "Performance", location: "", locationMode: "image_backed" as const,
    beat: "beat", plannerBeat: null, contrast: "", phase: "", starts: "", turn: "", ends: "", wheelPhase: number === 1 ? "Arrival" as const : number === 2 ? "Friction" as const : "Release" as const,
    wheelPlacement: "declared" as const,
  })),
};

function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    projectName: "Static Heart", generatedAt: "2026-11-03T18:42:00.000Z", kind: "snapshot",
    inputs: { song: { name: "static heart", durationSeconds: 175 }, performers: ["Mina"], outfits: ["White crochet set"], suppliedLocations: ["Laundromat"] },
    direction: { creativeBrief: "blue/pink night, static electricity, one lightning strike", motifWeight: 0 },
    planRun: { kind: "create", cacheResult: "reused", cacheDetails: ["creative brief: HIT", "location photo Laundromat: cache hit"], seed: 7, directorLlm: "Qwen3-VL 8B", completedAt: "2026-11-03T17:00:00.000Z", storyChanged: null },
    plan: PLAN, planIsCurrent: true,
    package: {
      folder: FOLDER, clipCount: 3, shotCount: 3, writtenAt: "2026-11-03T17:10:00.000Z", motifWeight: 0, warnings: [], isCurrent: true,
      polish: ["style (recurring motif weight 0%; shots none): wet neon", "required event 'lightning strike': section(s) 3"],
      resolveReport: "Location requests:\n  Glass storefront corridor: image-backed — loaded glass-storefront-corridor.png",
    },
    clipNotes: { "1": ["NOTE: action validation checked 2 requirement(s)."], "2": ["NOTE: repaired action validation: hands"], "3": [] },
    clips: [
      { index: 1, section: 1, mode: "Performance", location: "Laundromat", outfit: "White crochet set", status: "rendered", attempts: 1, error: null },
      { index: 2, section: 2, mode: "Performance", location: "Glass storefront corridor", outfit: "White crochet set", status: "rendered", attempts: 2, error: null },
      { index: 3, section: 3, mode: "B-roll", location: "Rooftop", outfit: "", status: "rendered", attempts: 1, error: null },
    ],
    attempts: [{ status: "complete", cleanup: "completed" }, { status: "failed", cleanup: "completed" }, { status: "complete", cleanup: "completed" }, { status: "complete", cleanup: "completed" }],
    stitch: {
      status: "complete", videoPath: `${FOLDER}\\final.mp4`, videoInfo: "1024x768 h264 at 24.00 fps, original song audio", stitchReport: FINALIZE_REPORT,
      durationSeconds: 175, fileSizeBytes: 50 * 1024 ** 2, completedAt: "2026-11-03T18:42:00.000Z", error: null, cleanup: "completed",
      cleanupDetail: "ComfyUI accepted /free and completed its cleanup cycle (queue idle, server responsive).", promptId: "abc", projectStatus: "{\"state\": \"ready_to_render\"}",
    },
    ...overrides,
  };
}

test("director report: real decisions only", () => {
  const report = buildDirectorReport(reportInput());
  const section = (id: string) => report.sections.find((item) => item.id === id)!;
  const value = (id: string, label: string) => section(id).items.find((item) => item.label === label)?.value;
  assert.deepEqual(wheelRanges(PLAN), [{ phase: "Arrival", sections: "1" }, { phase: "Friction", sections: "2" }, { phase: "Release", sections: "3" }]);
  assert.equal(section("wheel").summary, "3 phases");
  assert.match(value("plan", "Plan cache") ?? "", /^HIT/);
  // no readable director context in this fixture: the older hook-based line is shown as such, never as verified
  assert.match(value("creative", "Required one-off event") ?? "", /named in the hook for section 3 \(older report; prompt text and video not verified\)/);
  assert.match(value("locations", "Laundromat") ?? "", /supplied photo/);
  assert.match(value("locations", "Glass storefront corridor") ?? "", /image-backed — loaded glass-storefront-corridor\.png \(requested/);
  assert.equal(value("locations", "B-roll (text-only)"), "Rooftop");
  assert.match(value("locations", "Location evidence") ?? "", /1 from the evidence cache/);
  assert.match(value("production", "Action validation") ?? "", /^0 validated, 0 unverified, 1 repaired, 0 unresolved, 1 checked by an older package \(receipts not screened\), 1 without a result/);
  assert.match(value("production", "Candidate selection") ?? "", /Not part of this production path/);
  assert.match(value("render", "Render attempts") ?? "", /4 total · clips retried: 2/);
  assert.match(value("render", "ComfyUI cleanup after renders") ?? "", /4 completed its cleanup cycle/);
  assert.match(value("stitch", "Encoding") ?? "", /without re-encoding/);
  assert.match(report.markdown, /^# Martini Shot director report — Static Heart/);
  assert.match(report.markdown, /## Technical log/);
  assert.deepEqual(outcomeFor(reportInput()), { clipsRendered: 3, clipsTotal: 3, performerLocations: 2, outfits: 1, requiredEvent: { event: "lightning strike", sections: "3" } });
});

test("director report never claims a requested image was used unless the package's location check loaded it", () => {
  const input = reportInput();
  const report = buildDirectorReport({ ...input, package: { ...input.package!, resolveReport: "Location requests:\n  Glass storefront corridor: text-only — no image found" } });
  const item = report.sections.find((section) => section.id === "locations")!.items.find((entry) => entry.label === "Glass storefront corridor")!;
  assert.equal(item.tone, "warn");
  assert.doesNotMatch(item.value, /image-backed/);
  const none = buildDirectorReport({ ...input, package: { ...input.package!, resolveReport: "" } }).sections.find((section) => section.id === "locations")!
    .items.find((entry) => entry.label === "Glass storefront corridor")!;
  assert.match(none.value, /no line for it/);
  assert.deepEqual(requiredEventAllocation(["required event 'lightning strike': section(s) NOT ALLOCATED"]), { event: "lightning strike", sections: null });
  // the old hook search said NOT ALLOCATED even when the event was allocated; that claim is no longer repeated
  const unallocated = buildDirectorReport({ ...input, package: { ...input.package!, polish: ["required event 'lightning strike': section(s) NOT ALLOCATED"] } });
  assert.doesNotMatch(unallocated.sections.find((section) => section.id === "creative")!.items.find((entry) => entry.label === "Required one-off event")!.value, /NOT ALLOCATED/);
  assert.equal(outcomeFor({ ...input, package: { ...input.package!, polish: [] } })?.requiredEvent, null);
});

test("06-stitch-video.json: Finalize Video gets the saved render package; nothing else is a placeholder", () => {
  const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../workflows/06-stitch-video.json"), "utf-8"));
  assert.equal(template.stage, "stitch");
  const pkg = { project: "static-heart", folder: FOLDER, render_name: "render-01" };
  const prompt = applyTemplateValues(template.prompt, stitchWorkflowValues("static-heart", pkg)) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  assert.equal(prompt.finalize.class_type, "MartiniShotFinalizeVideo");
  assert.deepEqual(prompt.finalize.inputs.render_package, { __value__: pkg });
  assert.equal(prompt.finalize.inputs.output_name, "final");
  assert.equal(prompt.finalize.inputs.overwrite, false);
  assert.equal(prompt.open.inputs.project_name, "static-heart");
  assert.deepEqual(prompt.video_path.inputs.source, ["finalize", 0]);
  assert.deepEqual(prompt.stitch_report.inputs.source, ["finalize", 1]);
  assert.deepEqual(prompt.status_json.inputs.source, ["status", 0]);
  assert.doesNotMatch(JSON.stringify(prompt), /{{/);
});

test("required event: allocation, prompt coverage, and unverified visuals are reported separately and follow revisions", () => {
  const context = {
    required_events: [{ id: "required-event-1", event: "a lightning strike", section: 3 }],
    production_shots: [{ number: 1, required_events: [] }, { number: 2, required_events: [] }, { number: 3, required_events: [{ id: "required-event-1" }] }],
  };
  const segments = [{ index: 1, section: 1 }, { index: 2, section: 2 }, { index: 3, section: 3 }, { index: 4, section: 3 }];
  const written = requiredEventStatuses(context, segments, (index) => (index === 4 ? "Lightning strikes the tower behind her." : "She keeps dancing."));
  assert.deepEqual(written, [{ event: "a lightning strike", section: 3, clips: [3, 4], promptMentions: [4] }]);
  const input = reportInput();
  const report = buildDirectorReport({ ...input, package: { ...input.package!, requiredEvents: written } });
  const item = report.sections.find((section) => section.id === "creative")!.items.find((entry) => entry.label === "Required one-off event")!;
  assert.match(item.value, /allocated to section 3 \(clips 3.4\); the current prompt text names it in clip 4; the rendered video is not visually verified/);
  assert.equal(item.tone, "ok");
  // a later revision removed it from the prompt text: the report follows the current files, not the original hook
  const revised = requiredEventStatuses(context, segments, () => "She keeps dancing.");
  const stale = buildDirectorReport({ ...input, package: { ...input.package!, requiredEvents: revised } })
    .sections.find((section) => section.id === "creative")!.items.find((entry) => entry.label === "Required one-off event")!;
  assert.match(stale.value, /does not name it/);
  assert.equal(stale.tone, "warn");
  assert.deepEqual(outcomeFor({ ...input, package: { ...input.package!, requiredEvents: written } })?.requiredEvent, { event: "a lightning strike", sections: "3" });
  assert.equal(eventMentioned("midnight downtown race", "racing lights streak past"), false);
  assert.equal(eventMentioned("street race", "the street race begins"), true);
});

test("motif report names the frequency and whether surreal imagery was on", () => {
  const input = reportInput();
  const value = (surrealMotifs: boolean | null) => buildDirectorReport({ ...input, package: { ...input.package!, motifWeight: 0.5, surrealMotifs } })
    .sections.find((section) => section.id === "creative")!.items.find((entry) => entry.label === "Recurring motif frequency")!.value;
  assert.equal(value(false), "0.5 · grounded (surreal imagery off)");
  assert.equal(value(true), "0.5 · surreal imagery on");
  assert.equal(value(null), "0.5");
});
