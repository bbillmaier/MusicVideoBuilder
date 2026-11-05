import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { PlanData, PlanSection } from "./contracts";
import {
  MODE_LABELS, candidateSignature, describeRequest, locationSlug, parseResolveReport, plannedRequests, requestedTargetPath, resolveWorkflowValues,
  scanLocationFolder, shortReportLine, sniffImage, suppliedSections, textOnlyLocations, type FolderEntry,
} from "./location-rules";
import { applyTemplateValues, type WorkflowTemplate } from "./workflow-template";

const template = JSON.parse(readFileSync(path.resolve(__dirname, "../workflows/03-resolve-locations.json"), "utf-8")) as WorkflowTemplate;
type Node = { class_type: string; inputs: Record<string, unknown> };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const entry = (name: string, head: Uint8Array | null = PNG, size = 100): FolderEntry => ({ name, isFile: true, size, mtimeMs: 1_700_000_000_000, head });

test("03-resolve-locations.json chains Open Project -> Load Story Plan -> Resolve Locations and never plans", () => {
  const prompt = applyTemplateValues(template.prompt, resolveWorkflowValues("static-heart")) as Record<string, Node>;
  assert.equal(template.stage, "resolve_locations");
  const types = Object.values(prompt).map((node) => node.class_type);
  assert.ok(!types.some((type) => /PlanStory|PromptLLMLoader|WritePromptPackage|BuildProductionPlan/.test(type)), "must not plan or load an LLM");
  assert.deepEqual(prompt.open, { class_type: "MartiniShotOpenProject", inputs: { project_name: "static-heart" } });
  assert.deepEqual(prompt.story, { class_type: "MartiniShotLoadStoryPlan", inputs: { project: ["open", 0] } });
  assert.deepEqual(prompt.resolve, { class_type: "MartiniShotResolveLocations", inputs: { project: ["open", 0], story_plan: ["story", 0] } });
  // PreviewAny makes the run an output graph and returns location_requests (1) and ready_to_produce (2) in /history.
  assert.deepEqual(prompt.report, { class_type: "PreviewAny", inputs: { source: ["resolve", 1] } });
  assert.deepEqual(prompt.ready_to_produce, { class_type: "PreviewAny", inputs: { source: ["resolve", 2] } });
  assert.ok(!JSON.stringify(prompt).includes("{{"), "every placeholder is replaced");
});

test("slugs and target paths match project_store.requested_location_path", () => {
  assert.equal(locationSlug("Glass Storefront Corridor"), "glass-storefront-corridor");
  assert.equal(locationSlug("  Motel corridor (2am)! "), "motel-corridor-2am");
  assert.equal(locationSlug("…"), null);
  const project = path.join("E:", "out", "martini_shot", "static-heart");
  assert.equal(requestedTargetPath(project, "basement-club"), path.join(project, "locations", "basement-club.png"));
  assert.throws(() => requestedTargetPath(project, "../evil"), /not a requested location/);
  assert.throws(() => requestedTargetPath(project, "a\\b"), /not a requested location/);
  assert.throws(() => requestedTargetPath(project, ""), /not a requested location/);
});

test("image sniffing recognizes the formats the resolver reads", () => {
  assert.equal(sniffImage(PNG), "png");
  assert.equal(sniffImage(JPG), "jpeg");
  assert.equal(sniffImage(WEBP), "webp");
  assert.equal(sniffImage(Uint8Array.from([0x42, 0x4d, 0, 0])), "bmp");
  assert.equal(sniffImage(Uint8Array.from([0x47, 0x49, 0x46, 0x38])), null);
  assert.equal(sniffImage(null), null);
});

test("folder scan matches files the way the resolver does", () => {
  const scan = scanLocationFolder([
    entry("glass-storefront-corridor.png"),
    entry("Basement Club.JPG", JPG),
    entry("basement_club.webp", WEBP),
    entry("motel-corridor.gif", null),
    entry("broken-sign.png", Uint8Array.from([1, 2, 3, 4])),
    entry("glass storefront.png"),
    entry("notes.txt", null),
    { name: "replaced", isFile: false, size: 0, mtimeMs: 0 },
  ], ["glass-storefront-corridor", "basement-club", "motel-corridor", "broken-sign"]);
  assert.deepEqual(scan.bySlug.get("glass-storefront-corridor")!.map((item) => item.fileName), ["glass-storefront-corridor.png"]);
  // Any supported extension and any spelling with the same slug counts, so these two conflict.
  assert.deepEqual(scan.bySlug.get("basement-club")!.map((item) => item.fileName), ["Basement Club.JPG", "basement_club.webp"]);
  const gif = scan.bySlug.get("motel-corridor")!;
  assert.equal(gif.length, 1);
  assert.equal(gif[0].supported, false);
  assert.match(gif[0].issue!, /\.gif files are not read/);
  assert.match(scan.bySlug.get("broken-sign")![0].issue!, /not a PNG, JPG, WEBP, or BMP/);
  // A wrong file name is reported, not silently matched; non-image files are ignored.
  assert.deepEqual(scan.unrecognized, ["glass storefront.png"]);
});

test("request status: waiting, found, missing, failed, image-backed, changed", () => {
  const file = "basement-club.png";
  const waiting = describeRequest(file, null, []);
  assert.equal(waiting.mode, "not_checked");
  assert.equal(waiting.modeLabel, MODE_LABELS.not_checked);
  assert.equal(waiting.passedToMiniMax, false);
  assert.match(waiting.reason, /Save one image as basement-club\.png/);

  const one = scanLocationFolder([entry(file)], ["basement-club"]).bySlug.get("basement-club")!;
  const found = describeRequest(file, null, one);
  assert.equal(found.modeLabel, "image found — not checked");
  assert.equal(found.passedToMiniMax, false, "a file alone is not image-backed until the resolver reads it");

  const checkedAt = "2026-11-03T10:00:00.000Z";
  const backed = describeRequest(file, { mode: "image_backed", detail: "image-backed — loaded basement-club.png", checkedSignature: candidateSignature(one), checkedAt, updatedAt: checkedAt }, one);
  assert.equal(backed.modeLabel, "image-backed");
  assert.equal(backed.passedToMiniMax, true);

  const edited = scanLocationFolder([{ ...entry(file), mtimeMs: 1_800_000_000_000 }], ["basement-club"]).bySlug.get("basement-club")!;
  const changed = describeRequest(file, { mode: "image_backed", detail: "", checkedSignature: candidateSignature(one), checkedAt, updatedAt: checkedAt }, edited);
  assert.equal(changed.changedSinceCheck, true);
  assert.equal(changed.passedToMiniMax, false, "a replaced file needs a new check");

  const missing = describeRequest(file, { mode: "missing", detail: "text-only — no image found; add E:\\x", checkedSignature: candidateSignature([]), checkedAt, updatedAt: checkedAt }, []);
  assert.equal(missing.modeLabel, "text-only — no image found");
  assert.match(missing.reason, /No image named basement-club\.png/);

  const two = scanLocationFolder([entry("basement-club.png"), entry("basement-club.jpg", JPG)], ["basement-club"]).bySlug.get("basement-club")!;
  const ambiguous = describeRequest(file, { mode: "failed", detail: "image failed to load — more than one matching image", checkedSignature: candidateSignature(two), checkedAt, updatedAt: checkedAt }, two);
  assert.equal(ambiguous.modeLabel, "image failed to load");
  assert.match(ambiguous.reason, /More than one matching image \(basement-club\.jpg, basement-club\.png\)/);

  const unreadable = describeRequest(file, { mode: "failed", detail: "image failed to load — basement-club.png", checkedSignature: candidateSignature(one), checkedAt, updatedAt: checkedAt }, one);
  assert.match(unreadable.reason, /basement-club\.png could not be read/);

  const gif = scanLocationFolder([entry("basement-club.gif", null)], ["basement-club"]).bySlug.get("basement-club")!;
  assert.match(describeRequest(file, null, gif).reason, /not a supported type/);
});

test("resolver report lines are parsed per requested name", () => {
  const report = [
    "Performer location image requests (static-heart):",
    "  Glass storefront corridor: image-backed — loaded glass-storefront-corridor.png",
    "  Basement club: text-only — no image found; add E:\\out\\martini_shot\\static-heart\\locations\\basement-club.png",
    "  Motel: corridor: image failed to load — more than one matching image",
  ].join("\n");
  const lines = parseResolveReport(report, ["Glass storefront corridor", "Basement club", "Motel: corridor", "Rooftop"]);
  assert.deepEqual(lines.get("Glass storefront corridor"), { mode: "image_backed", detail: "image-backed — loaded glass-storefront-corridor.png", loadedFile: "glass-storefront-corridor.png" });
  assert.equal(lines.get("Basement club")!.mode, "missing");
  assert.equal(lines.get("Motel: corridor")!.mode, "failed");
  assert.equal(lines.has("Rooftop"), false);
  assert.equal(shortReportLine("Basement club", lines.get("Basement club")), "Basement club: text-only — no image found");
  assert.equal(shortReportLine("Rooftop", undefined), "Rooftop: not in the resolver report");
});

function section(number: number, location: string, scene: string, mode: PlanSection["locationMode"], beat = ""): PlanSection {
  return { number, start: number * 10, end: number * 10 + 10, role: "verse", label: "A", scene, location, locationMode: mode, beat, plannerBeat: null, contrast: "", phase: "",
    starts: "", turn: "", ends: "", wheelPhase: null, wheelPlacement: null };
}

test("plan grouping: requests use performer sections only; B-roll stays text-only; supplied keep their sections", () => {
  const plan = {
    sections: [
      section(1, "Neon street", "Dance", "image_backed"),
      section(2, "Glass storefront corridor", "Performance", "requested", "She walks past her reflection."),
      section(3, "Glass storefront corridor", "B-roll", "text_only_broll"),
      section(4, "Glass storefront corridor", "Dance", "requested"),
      section(5, "Rain gutter", "B-roll", "text_only_broll"),
      section(6, "Rain gutter", "B-roll", "text_only_broll"),
      section(7, "Car wash", "Performance", "text_only"),
    ],
    requestedLocations: [{ name: "Glass storefront corridor", fileName: "glass-storefront-corridor.png", expectedPath: "", sections: [2, 3, 4] }],
  } as unknown as PlanData;
  assert.deepEqual(plannedRequests(plan), [{
    name: "Glass storefront corridor", slug: "glass-storefront-corridor", fileName: "glass-storefront-corridor.png", sections: [2, 4], brollSections: [3],
    storyNote: "She walks past her reflection.",
  }]);
  assert.deepEqual(suppliedSections(plan, "neon street"), [1]);
  assert.deepEqual(suppliedSections(null, "Neon street"), []);
  const textOnly = textOnlyLocations(plan);
  assert.deepEqual(textOnly.map((item) => [item.name, item.kind, item.sections]), [["Rain gutter", "broll", [5, 6]], ["Car wash", "performer", [7]]]);
  // A requested place used for B-roll somewhere is not listed again as text-only.
  assert.ok(!textOnly.some((item) => item.name === "Glass storefront corridor"));
});
