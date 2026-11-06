import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PROMPTS, promptValues } from "./prompt-library";

const workflows = path.resolve(__dirname, "../workflows");
const nodes = path.resolve(__dirname, "../comfyui/custom_nodes/MartiniShot");

test("every prompt file loads and matches the node's built-in default", async () => {
  const values = await promptValues(true);
  for (const prompt of PROMPTS) {
    const source = fs.readFileSync(path.join(nodes, prompt.nodeDefault.file), "utf-8").replace(/\r\n/g, "\n");
    const match = source.match(new RegExp(`^${prompt.nodeDefault.constant} = """([\\s\\S]*?)"""`, "m"));
    assert.ok(match, `${prompt.nodeDefault.constant} not found in ${prompt.nodeDefault.file}`);
    assert.equal(values[`prompt_${prompt.id}`], match[1].trim(), `${prompt.file} differs from ${prompt.nodeDefault.constant}`);
  }
});

test("workflow templates only use known prompt placeholders", () => {
  const known = new Set(PROMPTS.map((prompt) => `prompt_${prompt.id}`));
  const used = new Set<string>();
  for (const file of fs.readdirSync(workflows).filter((name) => name.endsWith(".json"))) {
    for (const [, name] of fs.readFileSync(path.join(workflows, file), "utf-8").matchAll(/{{(prompt_[A-Za-z0-9_]+)}}/g)) {
      assert.ok(known.has(name), `${file} uses unknown prompt ${name}`);
      used.add(name);
    }
  }
  assert.deepEqual([...known].filter((name) => !used.has(name)), [], "every prompt is used by a workflow");
});
