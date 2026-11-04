import assert from "node:assert/strict";
import test from "node:test";
import { applyTemplateValues } from "./workflow-template";

test("workflow values preserve non-string replacements", () => {
  const result = applyTemplateValues({ number: "{{steps}}", text: "model={{model}}", nested: ["{{enabled}}"] }, { steps: 30, model: "MiniMax H3", enabled: true }) as { number: number; text: string; nested: boolean[] };
  assert.equal(result.number, 30);
  assert.equal(result.text, "model=MiniMax H3");
  assert.equal(result.nested[0], true);
});

test("workflow values reject missing replacements", () => assert.throws(() => applyTemplateValues("{{missing}}", {}), /was not supplied/));
