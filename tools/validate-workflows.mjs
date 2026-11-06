// Checks every workflows/*.json template against the running local ComfyUI's /object_info, without queueing anything:
// node classes are installed, every input name exists, combo values (model files, modes) are offered, links point at real
// outputs. Usage: npm run validate:workflows [-- http://127.0.0.1:8188]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = (process.argv[2] || process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(endpoint)) throw new Error("Only a local ComfyUI endpoint is allowed.");
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../workflows");

// Sample values for placeholders: only the shape matters here, except combo-valued placeholders, which are listed per template.
const samples = {
  project_name: "validation", director_llm: null, seed: 1, render_name: "render-01", motif_weight: 0, song_file: "x.flac [output]", refs_node: "ref_1",
  creative_brief: "", story_brief: "", story_wheel: true, min_locations: 0, request_location_images: true, reset_plan_cache: false,
  render_package: { project: "validation", folder: "x", render_name: "render-01" }, loader_mode: "Next missing", clip_index: 1, noise_seed: 1,
};

const info = await (await fetch(`${endpoint}/object_info`)).json();
let problems = 0;
const report = (template, message) => { problems += 1; console.log(`  ✕ ${message}`); };

function fill(value) {
  if (typeof value === "string") {
    const exact = value.match(/^{{([A-Za-z0-9_.-]+)}}$/);
    if (exact) return { placeholder: exact[1], value: samples[exact[1]] };
    return { value };
  }
  return { value };
}

function specFor(nodeInfo, key) {
  const all = { ...(nodeInfo.input?.required || {}), ...(nodeInfo.input?.optional || {}) };
  if (all[key]) return all[key];
  const base = key.split(".")[0];
  return all[base] ? { dynamicChild: true, parent: all[base] } : null;
}

for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
  const template = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
  console.log(`${file}`);
  const before = problems;
  const graphs = [template.prompt, ...Object.values(template.repeat || {})];
  for (const graph of graphs) {
    for (const [id, node] of Object.entries(graph)) {
      const classType = node.class_type.replace(/{{.*?}}/g, "");
      const nodeInfo = info[classType];
      if (!nodeInfo) { report(file, `${id}: node class ${classType} is not installed/loaded`); continue; }
      for (const [key, raw] of Object.entries(node.inputs || {})) {
        const spec = specFor(nodeInfo, key);
        if (!spec) { report(file, `${id} (${classType}): input "${key}" does not exist`); continue; }
        if (spec.dynamicChild) continue;
        if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === "string") {
          // Fragments the app assembles (07) link to nodes defined in sibling fragments.
          const source = graph[raw[0]] ?? template.prompt[raw[0]] ?? graphs.map((other) => other[raw[0]]).find(Boolean);
          if (!source) {
            if (!/{{/.test(raw[0])) report(file, `${id}.${key} links to missing node ${raw[0]}`);
            continue;
          }
          const outputs = info[source.class_type]?.output || [];
          if (raw[1] >= outputs.length) report(file, `${id}.${key} links to output ${raw[1]} of ${source.class_type}, which has ${outputs.length}`);
          continue;
        }
        const filled = fill(raw && typeof raw === "object" && "__value__" in raw ? "" : raw);
        const [type, options] = spec;
        const choices = Array.isArray(type) ? type : type === "COMBO" ? options?.options : null;
        if (choices && filled.value !== null && filled.value !== undefined && !choices.includes(filled.value)) {
          report(file, `${id}.${key} = ${JSON.stringify(filled.value)} is not one of ComfyUI's options${choices.length > 12 ? ` (${choices.length} offered)` : `: ${choices.join(", ")}`}`);
        }
      }
      const required = Object.keys(nodeInfo.input?.required || {});
      for (const key of required) if (!(key in (node.inputs || {}))) report(file, `${id} (${classType}): required input "${key}" is missing`);
    }
  }
  if (problems === before) console.log("  ✓ valid against this ComfyUI");
}
console.log(problems ? `\n${problems} problem(s).` : "\nAll templates match the running ComfyUI.");
process.exitCode = problems ? 1 : 0;
