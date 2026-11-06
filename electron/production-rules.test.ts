import assert from "node:assert/strict";
import test from "node:test";
import {
  actionValidation, clipMetadata, continuityText, estimateRemaining, findVideo, parseLoaderReport, parseManifest, parsePackageReport,
  parseProductionReport, queueTarget, readableProductionError, savedVideo, validateClipIndex, validateQueueCount,
} from "./production-rules";
import { applyTemplateValues } from "./workflow-template";
import fs from "node:fs";
import path from "node:path";

// Lines produced with the exact f-strings in MiniMaxPrompBuilder mv_auto.plan_auto_shots and mv_nodes.MiniMaxH3MusicVideoDirector.
const PRODUCTION_REPORT = [
  "Built deterministic production plan: 3 shots.",
  "",
  "*  0:00.000 | section 1 A (intro, energy 0.42) | Performance Hard cut  | Static medium | Laundromat | outfit: White crochet set | subject: Mina | story action: the routine breaks into deliberate movement",
  "   0:08.250 | section 1 A (intro, energy 0.42) | Performance Continue  | Slow push-in | Laundromat | outfit: White crochet set | subject: Mina",
  "   1:04.500 | section 2 B (2) (chorus, energy 0.90) | B-roll      Hard cut  | Handheld | Glass Storefront Corridor | action: neon flickers | rain | invented location",
].join("\n");

const PACKAGE_REPORT = [
  "Martini Shot prompt package written.",
  "Polish:",
  "  style (recurring motif weight 0%; shots 1-3): wet neon",
  "",
  "Saved 4 prompts, song.flac, references, and segments.json to E:\\out\\martini_shot\\static-heart\\render-01",
  "3 shots -> 4 clips for 1:12. Render workflow: set the run count to 4.",
  "LLM: Qwen3-VL 8B",
  "",
  "clip  1 | shot 1 Performance | 0:00 - 0:08 | Hard cut  | generate 209, trim end 8",
  "clip  2 | shot 2 Performance | 0:08 - 0:16 | Continue  | generate 226, trim start 22",
  "clip  3 | shot 2 Performance | 0:16 - 0:24 | Continue  | generate 226, trim start 22",
  "clip  4 | shot 3 B-roll      | 1:04 - 1:12 | Hard cut  | generate 209",
  "",
  "WARNING: Shot 3 is a New angle without a location image.",
  "[segment_01] NOTE: action validation checked location=Laundromat.",
  "[segment_02] WARNING: action validation could not repair: sits on a machine that is not there",
  "[segment_03] NOTE: repaired action validation: walks through a wall",
].join("\n");

const MANIFEST = {
  version: 2, fps: 24, song_duration: 72, song_file: "song.flac", overlap_frames: 22,
  segments: [
    { index: 1, section: 1, prompt_file: "segment_01.txt", video_name: "segment_01", song_start: 0, song_end: 8, overlap_frames: 0, transition: "Hard cut", references: [{ socket: "ref_image_0", file: "ref_a.png" }], start_frame: null },
    { index: 2, section: 2, prompt_file: "segment_02.txt", video_name: "segment_02", song_start: 8.25, song_end: 16, overlap_frames: 0, transition: "Continue", references: [], start_frame: null },
    { index: 3, section: 2, prompt_file: "segment_03.txt", video_name: "segment_03", song_start: 16, song_end: 24, overlap_frames: 22, transition: "Continue", references: [], start_frame: null },
    { index: 4, section: 3, prompt_file: "segment_04.txt", video_name: "segment_04", song_start: 64.5, song_end: 72, overlap_frames: 0, transition: "Hard cut", references: [], start_frame: null },
  ],
};

test("queue counts are positive whole numbers; at or above remaining means all remaining", () => {
  assert.equal(validateQueueCount(3), 3);
  for (const bad of [0, -1, 1.5, "2", null, Number.NaN, 10_001]) assert.throws(() => validateQueueCount(bad));
  assert.equal(queueTarget(1, 10), 1);
  assert.equal(queueTarget(25, 10), 10);
  assert.equal(queueTarget(10, 10), 10);
  assert.equal(queueTarget(3, 0), 0);
  assert.equal(validateClipIndex(4), 4);
  assert.throws(() => validateClipIndex(0));
  assert.throws(() => validateClipIndex(1000));
});

test("production report: shots, sections, outfits, actions, and flags", () => {
  const parsed = parseProductionReport(PRODUCTION_REPORT)!;
  assert.equal(parsed.shotCount, 3);
  assert.equal(parsed.shots.length, 3);
  const [first, second, third] = parsed.shots;
  assert.deepEqual([first.start, first.section, first.sectionLabel, first.role, first.scene, first.transition, first.camera, first.location, first.outfit, first.subject],
    [0, 1, "A", "intro", "Performance", "Hard cut", "Static medium", "Laundromat", "White crochet set", "Mina"]);
  assert.equal(first.storyAction, "the routine breaks into deliberate movement");
  assert.equal(second.start, 8.25);
  assert.equal(second.storyAction, "");
  assert.equal(third.start, 64.5);
  assert.equal(third.sectionLabel, "B (2)");
  assert.equal(third.scene, "B-roll");
  assert.equal(third.action, "neon flickers | rain");
  assert.deepEqual(third.flags, ["invented location"]);
  assert.equal(parseProductionReport("something else"), null);
});

test("package report: clip table, per-clip notes, warnings, polish", () => {
  const parsed = parsePackageReport(PACKAGE_REPORT);
  assert.equal(parsed.table.size, 4);
  assert.deepEqual(parsed.table.get(4), { clip: 4, shot: 3, scene: "B-roll", transition: "Hard cut", frames: 209 });
  assert.deepEqual(parsed.polish, ["style (recurring motif weight 0%; shots 1-3): wet neon"]);
  assert.deepEqual(parsed.warnings, ["Shot 3 is a New angle without a location image."]);
  // an older package's "checked" note is not presented as a validated receipt
  assert.match(actionValidation(parsed.clipNotes.get(1)!).value, /^Checked \(older package/);
  assert.equal(actionValidation(parsed.clipNotes.get(1)!).tone, "none");
  assert.match(actionValidation(parsed.clipNotes.get(2)!).value, /Could not repair: sits on a machine/);
  assert.equal(actionValidation(parsed.clipNotes.get(2)!).tone, "warn");
  assert.match(actionValidation(parsed.clipNotes.get(3)!).value, /^Repaired/);
  assert.equal(actionValidation([]).tone, "none");
});

test("action validation: validated, unverified (placeholder or unknown), and unresolved stay distinct", () => {
  const valid = actionValidation(["NOTE: action validation validated: needs=wet brick wall, start_posture=running."]);
  assert.equal(valid.tone, "ok");
  assert.match(valid.value, /^Valid — needs=wet brick wall/);
  const placeholder = actionValidation(["NOTE: action validation unverified: receipt 'Supported' is template text, not a concrete dependency."]);
  assert.equal(placeholder.tone, "info");
  assert.match(placeholder.value, /^Unverified — receipt 'Supported'/);
  assert.doesNotMatch(placeholder.value, /Valid/);
  const repairedButUnknown = actionValidation(["NOTE: repaired action validation: the action stops", "NOTE: action validation unverified: need 'door' is not in the recorded location evidence."]);
  assert.match(repairedButUnknown.value, /^Repaired: the action stops · still unverified: need 'door'/);
  assert.equal(repairedButUnknown.tone, "info");
  assert.equal(actionValidation(["WARNING: action validation could not repair: Continue changes posture from 'running' to 'lying down' at the join"]).tone, "warn");
});

test("manifest validation and clip matching by song time", () => {
  const manifest = parseManifest(MANIFEST);
  assert.equal(manifest.segments.length, 4);
  const production = parseProductionReport(PRODUCTION_REPORT)!;
  const metas = clipMetadata(manifest.segments, production.shots, parsePackageReport(PACKAGE_REPORT).table);
  assert.deepEqual(metas.map((meta) => [meta.index, meta.section, meta.mode, meta.location, meta.matched]), [
    [1, 1, "Performance", "Laundromat", true],
    [2, 1, "Performance", "Laundromat", true],
    [3, 1, "Performance", "Laundromat", true], // a continuation clip inside shot 2 (starts 8.25 s)
    [4, 2, "B-roll", "Glass Storefront Corridor", true],
  ]);
  assert.equal(metas[0].action, "the routine breaks into deliberate movement");
  assert.equal(metas[0].outfit, "White crochet set");
  assert.equal(metas[2].continuity, "Continues from clip 2 (last 22 frames)");
  // A mismatched scene type is reported as unmatched instead of guessed.
  const table = parsePackageReport(PACKAGE_REPORT.replace("clip  4 | shot 3 B-roll     ", "clip  4 | shot 3 Freeform   ")).table;
  const mismatched = clipMetadata(manifest.segments, production.shots, table)[3];
  assert.equal(mismatched.matched, false);
  assert.equal(mismatched.location, "");
  assert.equal(mismatched.mode, "Freeform");
  assert.throws(() => parseManifest({ version: 1, segments: [] }), /older format/);
  assert.throws(() => parseManifest({ version: 2, segments: [{ ...MANIFEST.segments[0], prompt_file: "../x.txt" }] }), /unusable file name/);
  assert.throws(() => parseManifest({ version: 2, segments: [{ ...MANIFEST.segments[1] }] }), /index/);
});

test("continuity wording", () => {
  const base = parseManifest(MANIFEST).segments;
  assert.equal(continuityText(base[0]), "Hard cut — fresh shot");
  assert.equal(continuityText({ ...base[0], transition: "New angle" }), "New angle on the same set");
  assert.equal(continuityText({ ...base[1], transition: "New angle", overlapFrames: 22 }), "New angle after a motion bridge from clip 1 (last 22 frames)");
  assert.equal(continuityText({ ...base[0], startFrame: "start_01.png" }), "Hard cut, anchored to a start frame");
});

test("rendered files follow find_video: exact name or SaveVideo counter, newest, at least 1 KB", () => {
  const files = [
    { name: "segment_01_00001_.mp4", size: 5000, mtimeMs: 1 },
    { name: "segment_01_00002_.mp4", size: 5000, mtimeMs: 2 },
    { name: "segment_010_00001_.mp4", size: 5000, mtimeMs: 3 },
    { name: "segment_02_00001_.mp4", size: 100, mtimeMs: 4 },
  ];
  assert.equal(findVideo(files, "segment_01")?.name, "segment_01_00002_.mp4");
  assert.equal(findVideo(files, "segment_02"), null);
  assert.equal(findVideo(files, "segment_03"), null);
});

test("loader report and SaveVideo history output", () => {
  assert.deepEqual(parseLoaderReport("Clip 3 of 32 (2 already rendered) | Continue\nSong 1.0 - 2.0 s"), { clip: 3, total: 32, rendered: 2 });
  assert.equal(parseLoaderReport(null), null);
  assert.deepEqual(savedVideo({ save: { images: [{ filename: "segment_03_00001_.mp4", subfolder: "martini_shot/x/render-01", type: "output" }], animated: [true] } }, "save"),
    { filename: "segment_03_00001_.mp4", subfolder: "martini_shot/x/render-01" });
  assert.equal(savedVideo({ save: { images: [{ filename: "a.mp4", subfolder: "", type: "temp" }] } }, "save"), null);
  assert.equal(savedVideo({}, "save"), null);
});

test("remaining-time estimate needs two finished clips and stays conservative", () => {
  assert.equal(estimateRemaining([300], 5, 0), null);
  assert.equal(estimateRemaining([300, 400], 0, 0), null);
  assert.equal(estimateRemaining([300, 400], 1, 100), 300); // slower of mean (350) and median (400), minus elapsed
  assert.equal(estimateRemaining([300, 400], 3, 0), 1200);
  assert.equal(estimateRemaining([300, 400], 1, 10_000), 40); // never claims the current clip is done
});

test("plain-language errors", () => {
  assert.match(readableProductionError("ComfyUI stopped at MartiniShotBuildProductionPlan: Cannot build production plan until requested performer location images are present: motel corridor", "http://127.0.0.1:8188"),
    /^Needs location images: motel corridor/);
  assert.match(readableProductionError("fetch failed", "http://127.0.0.1:8188"), /Lost contact with ComfyUI/);
  assert.match(readableProductionError("Prompt outputs failed validation\nUNETLoader: Value not in list — unet_name: 'x.safetensors' not in (list of length 9)", "e"), /model file/);
});

test("workflow templates: placeholders fill, render package passes as a literal value, one SaveVideo per render", () => {
  const dir = path.resolve(__dirname, "../workflows");
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "04-write-prompt-package.json"), "utf-8"));
  const filled = applyTemplateValues(pkg.prompt, {
    project_name: "static-heart", seed: 7, director_llm: "Qwen | q.safetensors", render_name: "render-01", motif_weight: 0.25,
    dance_style: "K-Pop", target_shot_seconds: 8, min_shot_seconds: 3, max_shot_seconds: 10, cut_rate_vs_energy: 0.5,
    broll_amount: 0.3, performance_vs_dance: 0.4, freeform_amount: 0, location_variety: 0.5, chorus_consistency: true,
    outfit_change_rate: 0.3, continue_bias: 0.5, hard_cuts_change_location: true, lip_sync: false, surreal_motifs: false,
  }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  assert.deepEqual(Object.values(filled).map((node) => node.class_type).filter((type) => type.startsWith("MartiniShot")),
    ["MartiniShotOpenProject", "MartiniShotLoadStoryPlan", "MartiniShotResolveLocations", "MartiniShotBuildProductionPlan", "MartiniShotWritePromptPackage"]);
  assert.ok(!Object.values(filled).some((node) => node.class_type === "MartiniShotPlanStory"), "the package workflow must never plan");
  assert.equal(filled.package.inputs.recurring_style_motif_weight, 0.25);
  assert.equal(filled.production.inputs.seed, 7);
  assert.equal(filled.production.inputs.target_shot_seconds, 8);
  assert.equal(filled.package.inputs.lip_sync, false);
  assert.equal(filled.package.inputs.surreal_motifs, false);

  const render = JSON.parse(fs.readFileSync(path.join(dir, "05-render-next-clip.json"), "utf-8"));
  const renderPackage = { project: "static-heart", folder: "E:\\out\\martini_shot\\static-heart\\render-01", render_name: "render-01" };
  const graph = applyTemplateValues(render.prompt, { render_package: renderPackage, loader_mode: "Next missing", clip_index: 3, noise_seed: 42, aspect_ratio: "9:16", render_megapixels: 1.25, render_steps: 12, livePreviews: false, vramCleanup: false, ramCleanup: false, renderSampler: "res_multistep", renderScheduler: "beta", renderShiftVideo: 10, renderShiftAudio: 2.5 }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  assert.deepEqual(graph.clip.inputs.render_package, { __value__: renderPackage });
  assert.equal(graph.clip.inputs.mode, "Next missing");
  assert.equal(Object.values(graph).filter((node) => node.class_type === "MartiniShotLoadRenderClip").length, 1);
  assert.equal(Object.values(graph).filter((node) => node.class_type === "SaveVideo").length, 1);
  assert.equal(graph.resolution.class_type, "MartiniShotRenderResolution");
  assert.equal(graph.resolution.inputs.aspect_ratio, "9:16");
  assert.equal(graph.live_preview.inputs.enabled, false);
  assert.equal(graph.resolution.inputs.megapixels, 1.25);
  assert.equal(graph.sigmas_1.inputs.steps, 12);
  assert.equal(graph.sampler.inputs.sampler_name, "res_multistep");
  assert.equal(graph.sigmas_1.inputs.scheduler, "beta");
  assert.deepEqual([graph.shift.inputs.shift_video, graph.shift.inputs.shift_audio], [10, 2.5]);
  assert.equal(Object.values(graph).filter((node) => node.class_type === "MinimaxH3LatentUpscaler3D").length, 0);
  assert.equal(Object.values(graph).filter((node) => node.class_type === "SamplerCustomAdvanced").length, 1);
  assert.equal(Object.values(graph).filter((node) => node.class_type === "VRAMCleanup").length, 3);
  assert.equal(Object.values(graph).filter((node) => node.class_type === "RAMCleanup").length, 3);
  assert.equal(graph.vram_cleanup_before_sample.inputs.offload_model, false);
  assert.equal(graph.ram_cleanup_before_sample.inputs.clean_file_cache, false);
  assert.deepEqual(graph.ram_cleanup_before_sample.inputs.anything, ["vram_cleanup_before_sample", 0]);
  assert.deepEqual(graph.pass_1.inputs.latent_image, ["ram_cleanup_before_sample", 0]);
  assert.deepEqual(graph.ram_cleanup_after_sample.inputs.anything, ["vram_cleanup_after_sample", 0]);
  assert.deepEqual(graph.decode.inputs.samples, ["ram_cleanup_after_sample", 0]);
  assert.deepEqual(graph.ram_cleanup_after_decode.inputs.anything, ["vram_cleanup_after_decode", 0]);
  assert.deepEqual(graph.trim.inputs.images, ["ram_cleanup_after_decode", 0]);
  assert.deepEqual(graph.save.inputs.filename_prefix, ["clip", 12]);
  // Every link points at an existing node.
  for (const [id, node] of Object.entries(graph)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") assert.ok(graph[value[0]], `${id} links to missing node ${value[0]}`);
    }
  }

  const revise = JSON.parse(fs.readFileSync(path.join(dir, "04b-revise-clip-prompt.json"), "utf-8"));
  const revision = applyTemplateValues(revise.prompt, {
    package_folder: "E:\\out\\martini_shot\\static-heart\\render-01", director_llm: "Qwen | q.safetensors",
    clip_index: 18, revision_mode: "Try another take", creative_text: "closer on her hands", seed: 7,
    changes: JSON.stringify({ refs: { outfit: "ref_ab12.png" }, propagate: [19, 20] }),
  }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  assert.equal(revision.revise.class_type, "MartiniShotReviseClipPrompt");
  assert.equal(revision.revise.inputs.clip_index, 18);
  assert.equal(revision.revise.inputs.creative_text, "closer on her hands");
  assert.deepEqual(JSON.parse(revision.revise.inputs.changes as string).propagate, [19, 20]);
  assert.deepEqual(revision.revise.inputs.llm, ["llm", 0]);
  assert.ok(!JSON.stringify(revision).includes("{{"));

  // Shot settings and manual directions run the same node without loading the LLM.
  const apply = JSON.parse(fs.readFileSync(path.join(dir, "04c-apply-clip-settings.json"), "utf-8"));
  const settings = applyTemplateValues(apply.prompt, {
    package_folder: "E:\\out\\martini_shot\\static-heart\\render-01", clip_index: 18, revision_mode: "Apply shot settings",
    creative_text: "", seed: 7, changes: JSON.stringify({ lip_sync: false }),
  }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  assert.equal(settings.revise.class_type, "MartiniShotReviseClipPrompt");
  assert.equal(settings.revise.inputs.mode, "Apply shot settings");
  assert.ok(!("llm" in settings) && !("llm" in settings.revise.inputs));
  assert.ok(!JSON.stringify(settings).includes("{{"));
});
