import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_DIRECTION, PREFERRED_DIRECTOR_LLM, assetFingerprint, cacheEvidence, cachedNodes, chooseDirectorLlm, parseCreativeDirection, parseStoryPlan,
  planFreshness, planInputs, planWorkflowValues, previewText, reportWarnings, storySignature, validateDirection, wheelPhaseFor, type RawStoryPlan,
} from "./plan-rules";
import { applyTemplateValues, type WorkflowTemplate } from "./workflow-template";

// Compiled tests run from dist-electron/, so the template lives one level up.
const template = JSON.parse(readFileSync(path.resolve(__dirname, "../workflows/02-plan-story.json"), "utf-8")) as WorkflowTemplate;
type Node = { class_type: string; inputs: Record<string, unknown> };

const direction = { ...DEFAULT_DIRECTION, creativeBrief: "Blue and pink night energy.\n Lightning once.", minLocations: 4, planSeed: 1234 };
const assets = assetFingerprint([{ role: "song", checksum: "a", displayName: "song" }, { role: "performer", checksum: "b", displayName: "me" }]);

test("direction input is validated in main", () => {
  assert.deepEqual(validateDirection({ ...DEFAULT_DIRECTION, motifWeight: 0.33 }), { ...DEFAULT_DIRECTION, motifWeight: 0.35 });
  assert.throws(() => validateDirection(null), /missing/);
  assert.throws(() => validateDirection({ ...DEFAULT_DIRECTION, creativeBrief: 5 }), /must be text/);
  assert.throws(() => validateDirection({ ...DEFAULT_DIRECTION, creativeBrief: "x".repeat(1001) }), /at most 1000/);
  assert.throws(() => validateDirection({ ...DEFAULT_DIRECTION, creativeBrief: "bad\u0007" }), /control characters/);
  assert.throws(() => validateDirection({ ...DEFAULT_DIRECTION, minLocations: 13 }), /0 to 12/);
  assert.throws(() => validateDirection({ ...DEFAULT_DIRECTION, minLocations: 1.5 }), /whole number/);
  assert.throws(() => validateDirection({ ...DEFAULT_DIRECTION, storyWheel: "yes" }), /on or off/);
  assert.throws(() => validateDirection({ ...DEFAULT_DIRECTION, motifWeight: 2 }), /between 0 and 1/);
  assert.equal(validateDirection({ ...DEFAULT_DIRECTION, creativeBrief: "a\r\nb" }).creativeBrief, "a\nb");
});

test("freshness compares every Plan Story input and ignores motif weight", () => {
  const inputs = planInputs(direction, PREFERRED_DIRECTOR_LLM, assets);
  assert.equal(inputs.creativeBrief, "Blue and pink night energy. Lightning once.");
  assert.deepEqual(planFreshness(null, inputs), { state: "none", reasons: [] });
  assert.deepEqual(planFreshness(inputs, planInputs({ ...direction, motifWeight: 0.8 }, PREFERRED_DIRECTOR_LLM, assets)), { state: "fresh", reasons: [] });
  // Whitespace-only edits do not change what the planner receives.
  assert.equal(planFreshness(inputs, planInputs({ ...direction, creativeBrief: "Blue and pink  night energy. Lightning once. " }, PREFERRED_DIRECTOR_LLM, assets)).state, "fresh");
  const changed = planFreshness(inputs, planInputs({ ...direction, creativeBrief: "Other", storyWheel: false, minLocations: 2, requestLocationImages: false, planSeed: 9 }, "other | x.safetensors", "different"));
  assert.equal(changed.state, "stale");
  assert.equal(changed.reasons.length, 7);
  assert.match(changed.reasons.join(" "), /creative brief.*Story Wheel was turned off.*from 4 to 2.*turned off.*song or reference.*LLM.*seed/);
});

test("02-plan-story uses the installed Martini Shot nodes with named values", () => {
  const prompts = { prompt_story_system: "STORY", prompt_timeline_shot_rules: "SHOTS" };
  const inputs = planInputs(direction, PREFERRED_DIRECTOR_LLM, assets);
  const prompt = applyTemplateValues(template.prompt, { ...prompts, ...planWorkflowValues("static-heart", inputs, false) }) as Record<string, Node>;
  assert.equal(template.stage, "plan");
  assert.deepEqual(Object.keys(prompt).sort(), ["llm", "needs_location_images", "open", "plan", "report"]);
  assert.deepEqual(prompt.open, { class_type: "MartiniShotOpenProject", inputs: { project_name: "static-heart" } });
  assert.deepEqual(prompt.llm, { class_type: "MiniMaxH3PromptLLMLoader", inputs: { model: PREFERRED_DIRECTOR_LLM } });
  assert.equal(prompt.plan.class_type, "MartiniShotPlanStory");
  assert.deepEqual(prompt.plan.inputs, {
    project: ["open", 0], llm: ["llm", 0], creative_brief: inputs.creativeBrief, story_brief: inputs.creativeBrief, story_wheel: true,
    min_locations: 4, request_performer_location_images: true, seed: 1234, reset_plan_cache: false,
    story_system: "STORY", timeline_shot_rules: "SHOTS",
  });
  assert.deepEqual(prompt.report, { class_type: "PreviewAny", inputs: { source: ["plan", 1] } });
  assert.deepEqual(prompt.needs_location_images, { class_type: "PreviewAny", inputs: { source: ["plan", 2] } });
  const reroll = applyTemplateValues(template.prompt, { ...prompts, ...planWorkflowValues("static-heart", inputs, true) }) as Record<string, Node>;
  assert.equal(reroll.plan.inputs.reset_plan_cache, true);
  // A brief that looks like a placeholder is passed through literally.
  const literal = applyTemplateValues(template.prompt, { ...prompts, ...planWorkflowValues("x", { ...inputs, creativeBrief: "{{seed}}" }, false) }) as Record<string, Node>;
  assert.equal(literal.plan.inputs.creative_brief, "{{seed}}");
});

test("director LLM choice prefers the saved option, then the Director workflow model", () => {
  const options = ["Gemma 3 12B (text only) | g.safetensors", "Qwen3-VL 4B (vision) | q4.safetensors", PREFERRED_DIRECTOR_LLM];
  assert.equal(chooseDirectorLlm("Qwen3-VL 4B (vision) | q4.safetensors", options), "Qwen3-VL 4B (vision) | q4.safetensors");
  assert.equal(chooseDirectorLlm("Qwen3-VL 8B (Local)", options), PREFERRED_DIRECTOR_LLM);
  assert.equal(chooseDirectorLlm("", options.slice(0, 2)), "Qwen3-VL 4B (vision) | q4.safetensors");
  assert.equal(chooseDirectorLlm("", ["No compatible LLM found"]), null);
});

const report = [
  "Martini Shot story plan: 3 song sections.",
  "",
  "Creative direction:",
  "  Look: blue and pink night energy",
  "",
  "Story:",
  "  section 1: Performance @ neon street: She walks alone.",
  "  WARNING: Location quota not met: planned 1 of 2 performer locations.",
  "",
  "Location observations:",
  "  neon street: cache hit",
  "    Visible: wet asphalt, neon signs",
  "",
  "Director cache:",
  "  creative brief: HIT",
  "  Story Wheel: HIT",
].join("\n");

test("cache evidence is read from the Plan Story report", () => {
  assert.deepEqual(cacheEvidence(report), { result: "reused", details: ["creative brief: HIT", "Story Wheel: HIT", "location photo neon street: cache hit"], resetSeed: null });
  assert.equal(cacheEvidence(report.replace("Story Wheel: HIT", "Story Wheel: MISS")).result, "partly_reused");
  assert.equal(cacheEvidence(report.replace(/: HIT/g, ": MISS")).result, "new");
  const rerolled = cacheEvidence(report.replace("Director cache:", "Director cache:\n  reset: cleared; seed 1234 -> 98765").replace(/: HIT/g, ": MISS"));
  assert.equal(rerolled.result, "rerolled");
  assert.deepEqual(rerolled.resetSeed, { from: 1234, to: 98765 });
  assert.equal(cacheEvidence("Martini Shot story plan: 3 song sections.").result, "no_llm");
  assert.equal(cacheEvidence("").result, "unknown");
  assert.deepEqual(reportWarnings(report), ["Location quota not met: planned 1 of 2 performer locations."]);
});

test("ComfyUI outputs and status messages", () => {
  assert.equal(previewText({ report: { text: ["hello"] } }, "report"), "hello");
  assert.equal(previewText({}, "report"), null);
  assert.deepEqual(cachedNodes([["execution_start", {}], ["execution_cached", { nodes: ["open", "plan"] }]]), ["open", "plan"]);
  assert.deepEqual(cachedNodes("nope"), []);
});

test("creative direction lines and Story Wheel phases", () => {
  assert.deepEqual(parseCreativeDirection("Look: blue\nRecurring motif: static\nRequired one-off event: lightning strike"), { look: "blue", motif: "static", event: "lightning strike" });
  assert.equal(parseCreativeDirection(""), null);
  assert.equal(wheelPhaseFor("establishment"), "Arrival");
  assert.equal(wheelPhaseFor("rising tension"), "Escalation");
  assert.equal(wheelPhaseFor("Climax"), "Break");
  assert.equal(wheelPhaseFor("cathartic release"), "Release");
  assert.equal(wheelPhaseFor("complication"), "Friction");
  assert.equal(wheelPhaseFor("whatever"), null);
});

const rawPlan: RawStoryPlan = {
  project: "static-heart",
  analysis: { duration: 100, bpm: 108.2, sections: [
    { start: 0, end: 20, role: "verse", label: "A" }, { start: 20, end: 40, role: "chorus", label: "B" },
    { start: 40, end: 60, role: "verse", label: "A" }, { start: 60, end: 80, role: "bridge", label: "C" }, { start: 80, end: 100, role: "chorus", label: "B" },
  ] },
  story: {
    "1": { scene: "Performance", location: "neon street", new_location: "", beat: "She walks alone.", phase: "establishment", turn: "", ends: "" },
    "2": { scene: "Dance", location: "", new_location: "Glass Corridor", beat: "Reflections multiply.", phase: "friction", turn: "doubt", ends: "" },
    "3": { scene: "B-roll", location: "", new_location: "empty rooftop", beat: "Wind moves wires.", phase: "odd word", turn: "", ends: "" },
    "4": { scene: "Freeform", location: "", new_location: "glass corridor", beat: "She shatters it.", phase: "climax", turn: "", ends: "" },
  },
  creative_direction: "Look: blue and pink night energy\nRequired one-off event: lightning strike",
  settings: { story_wheel: true, min_locations: 2, request_performer_location_images: true, seed: 98765 },
  requested_locations: ["Glass Corridor"],
};

test("story_plan.json becomes the read-only plan model", () => {
  const projectPath = path.resolve("/out/martini_shot/static-heart");
  const plan = parseStoryPlan(rawPlan, { projectPath, suppliedLocations: ["neon street"], report });
  assert.equal(plan.sections.length, 5);
  assert.equal(plan.durationSeconds, 100);
  assert.equal(plan.seed, 98765);
  assert.equal(plan.storyWheel, true);
  assert.deepEqual(plan.sections.map((section) => section.locationMode), ["image_backed", "requested", "text_only_broll", "requested", "rules"]);
  assert.deepEqual(plan.sections.map((section) => section.wheelPhase), ["Arrival", "Friction", "Escalation", "Break", "Release"]);
  assert.deepEqual(plan.sections.map((section) => section.wheelPlacement), ["declared", "declared", "position", "declared", "position"]);
  assert.deepEqual(plan.performerLocations, ["neon street", "Glass Corridor"]);
  assert.deepEqual(plan.requestedLocations, [{ name: "Glass Corridor", fileName: "glass-corridor.png", expectedPath: path.join(projectPath, "locations", "glass-corridor.png"), sections: [2, 4] }]);
  assert.deepEqual(plan.creativeDirection, { look: "blue and pink night energy", motif: "", event: "lightning strike" });
  assert.deepEqual(plan.warnings, ["Location quota not met: planned 1 of 2 performer locations."]);
  assert.equal(plan.rulesOnly, false);

  const noWheel = parseStoryPlan({ ...rawPlan, settings: { ...rawPlan.settings, story_wheel: false } }, { projectPath, suppliedLocations: [], report: "" });
  assert.equal(noWheel.storyWheel, false);
  assert.equal(noWheel.sections[0].wheelPhase, null);
  assert.equal(noWheel.sections[0].locationMode, "text_only");

  const requestsOff = parseStoryPlan({ ...rawPlan, requested_locations: [], settings: { ...rawPlan.settings, request_performer_location_images: false } }, { projectPath, suppliedLocations: ["neon street"], report: "" });
  assert.equal(requestsOff.sections[1].locationMode, "text_only");

  const rulesOnly = parseStoryPlan({ ...rawPlan, story: {} }, { projectPath, suppliedLocations: [], report: "" });
  assert.equal(rulesOnly.rulesOnly, true);
  assert.equal(rulesOnly.storyWheel, false);

  assert.notEqual(storySignature(plan), storySignature(parseStoryPlan({ ...rawPlan, story: { ...rawPlan.story as object, "1": { scene: "Dance", location: "neon street", beat: "Different." } } }, { projectPath, suppliedLocations: ["neon street"], report: "" })));
  assert.throws(() => parseStoryPlan({ analysis: { duration: 10, sections: [] } }, { projectPath, suppliedLocations: [], report: "" }), /no song sections/);
});
