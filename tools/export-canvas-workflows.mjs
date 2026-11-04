import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const source = join(import.meta.dirname, "..", "workflows");
const appOutput = join(source, "canvas");
const comfyOutput = "E:\\LTX2-Install\\ComfyUI_windows_portable\\ComfyUI\\user\\default\\workflows\\Martini Shot Inspect";

function widgetValue(value) {
  if (value && typeof value === "object" && "__value__" in value) return JSON.stringify(value.__value__);
  return value;
}

function canvas(template) {
  const entries = Object.entries(template.prompt);
  const ids = new Map(entries.map(([name], index) => [name, index + 1]));
  const outgoing = new Map(entries.map(([name]) => [name, new Map()]));
  const links = [];
  let linkId = 1;

  for (const [targetName, definition] of entries) {
    for (const [inputIndex, [inputName, value]] of Object.entries(definition.inputs).entries()) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !ids.has(value[0])) continue;
      const [sourceName, sourceSlot] = value;
      const id = linkId++;
      links.push([id, ids.get(sourceName), sourceSlot, ids.get(targetName), inputIndex, "*"]);
      const slots = outgoing.get(sourceName);
      if (!slots.has(sourceSlot)) slots.set(sourceSlot, []);
      slots.get(sourceSlot).push(id);
    }
  }

  const nodes = entries.map(([name, definition], index) => {
    const inputEntries = Object.entries(definition.inputs);
    const inputs = inputEntries.map(([inputName, value], inputIndex) => {
      const link = links.find((item) => item[3] === ids.get(name) && item[4] === inputIndex);
      return link
        ? { name: inputName, type: "*", link: link[0] }
        : { name: inputName, type: "STRING", widget: { name: inputName }, link: null };
    });
    const outputs = [...outgoing.get(name).entries()].sort(([a], [b]) => a - b).map(([slot, idsForSlot]) => ({
      name: `output ${slot}`, type: "*", slot_index: slot, links: idsForSlot,
    }));
    const values = inputEntries.filter(([, value]) => !Array.isArray(value)).map(([, value]) => widgetValue(value));
    return {
      id: ids.get(name), type: definition.class_type, title: `${name} — ${definition.class_type}`,
      pos: [Math.floor(index / 5) * 360, (index % 5) * 180], size: [320, Math.max(80, 50 + inputs.length * 24)],
      flags: {}, order: index, mode: 0, inputs, outputs,
      properties: { "Node name for S&R": definition.class_type, "Martini Shot inspection": true }, widgets_values: values,
    };
  });

  return {
    id: `martini-shot-inspect-${template.name}`, revision: 0, last_node_id: nodes.length, last_link_id: links.length,
    nodes, links, groups: [], config: {},
    extra: {
      frontendVersion: "Martini Shot inspection export", workflowRendererVersion: "LG",
      martiniShotInspection: {
        sourceTemplate: template.name,
        warning: "INSPECTION ONLY. Martini Shot fills {{placeholders}} and project objects at runtime. Do not queue this canvas workflow as-is.",
      },
    }, version: 0.4,
  };
}

mkdirSync(appOutput, { recursive: true });
mkdirSync(comfyOutput, { recursive: true });
for (const name of readdirSync(source).filter((file) => /^\d\d-.*\.json$/.test(file))) {
  const template = JSON.parse(readFileSync(join(source, name), "utf8"));
  const body = `${JSON.stringify(canvas(template), null, 2)}\n`;
  writeFileSync(join(appOutput, name), body);
  writeFileSync(join(comfyOutput, name), body);
}
