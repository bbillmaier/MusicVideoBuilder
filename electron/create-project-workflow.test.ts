import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildCreateProjectPrompt, createProjectReport } from "./create-project-workflow";
import type { WorkflowTemplate } from "./workflow-template";

// Compiled tests run from dist-electron/, so the template lives one level up.
const template = JSON.parse(readFileSync(path.resolve(__dirname, "../workflows/01-create-project.json"), "utf-8")) as WorkflowTemplate;
type Node = { class_type: string; inputs: Record<string, unknown> };

test("01-create-project chains every reference into Martini Shot Project", () => {
  const prompt = buildCreateProjectPrompt(template, {
    projectName: "static-heart",
    songFile: "martini_shot/static-heart/assets/originals/song.wav [output]",
    references: [
      { imageFile: "martini_shot/static-heart/assets/originals/p.png [output]", kind: "Subject", name: "performer main" },
      { imageFile: "martini_shot/static-heart/assets/originals/o.png [output]", kind: "Outfit", name: "leather jacket" },
      { imageFile: "martini_shot/static-heart/assets/originals/l.png [output]", kind: "Location", name: "{{not a placeholder}}" },
    ],
  }) as Record<string, Node>;
  assert.deepEqual(Object.keys(prompt).sort(), ["project", "ref_1", "ref_1_image", "ref_2", "ref_2_image", "ref_3", "ref_3_image", "report", "song"]);
  assert.equal(prompt.song.class_type, "LoadAudio");
  assert.equal(prompt.song.inputs.audio, "martini_shot/static-heart/assets/originals/song.wav [output]");
  assert.equal(prompt.ref_1_image.class_type, "LoadImage");
  assert.equal(prompt.ref_1.class_type, "MiniMaxH3AutoReference");
  assert.equal("previous_refs" in prompt.ref_1.inputs, false);
  assert.deepEqual(prompt.ref_1.inputs.image, ["ref_1_image", 0]);
  assert.equal(prompt.ref_1.inputs.kind, "Subject");
  assert.deepEqual(prompt.ref_2.inputs.previous_refs, ["ref_1", 0]);
  assert.deepEqual(prompt.ref_3.inputs.previous_refs, ["ref_2", 0]);
  assert.equal(prompt.ref_3.inputs.name, "{{not a placeholder}}");
  assert.equal(prompt.ref_3.inputs.weight, 1.0);
  assert.equal(prompt.project.class_type, "MartiniShotProject");
  assert.deepEqual(prompt.project.inputs, { audio: ["song", 0], refs: ["ref_3", 0], project_name: "static-heart", replace_assets: true });
  assert.equal(prompt.report.class_type, "PreviewAny");
  assert.deepEqual(prompt.report.inputs.source, ["project", 1]);
  assert.equal(JSON.stringify(prompt).includes("{{index}}"), false);
});

test("01-create-project requires a performer reference", () => {
  assert.throws(() => buildCreateProjectPrompt(template, { projectName: "x", songFile: "s [output]", references: [] }), /performer image/);
  assert.throws(() => buildCreateProjectPrompt(template, { projectName: "x", songFile: "s [output]", references: [{ imageFile: "o [output]", kind: "Outfit", name: "o" }] }), /performer image/);
});

test("create-project report is read from the PreviewAny output", () => {
  assert.equal(createProjectReport({ report: { text: ["Martini Shot project 'x' ready."] } }), "Martini Shot project 'x' ready.");
  assert.equal(createProjectReport({}), null);
});
