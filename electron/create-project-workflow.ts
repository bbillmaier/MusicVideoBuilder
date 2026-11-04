// Builds the API prompt for workflows/01-create-project.json. Pure: no Electron imports.
import { applyTemplateValues, type WorkflowTemplate } from "./workflow-template";

export type CreateProjectReference = {
  /** ComfyUI-annotated file reference, e.g. `martini_shot/static-heart/assets/originals/x.png [output]`. */
  imageFile: string;
  /** Auto Director Reference kind: Subject, Outfit, or Location. */
  kind: "Subject" | "Outfit" | "Location";
  /** How the director and prompts refer to this reference. */
  name: string;
};

export type CreateProjectValues = { projectName: string; songFile: string; references: CreateProjectReference[] };

function renameKeys(fragment: Record<string, unknown>, index: number): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fragment).map(([key, node]) => [key.replaceAll("{{index}}", String(index)), node]));
}

/** Expands the `reference` fragment once per reference, chaining each Auto Director Reference into the next,
 *  and links the last one into Martini Shot Project. */
export function buildCreateProjectPrompt(template: WorkflowTemplate, values: CreateProjectValues): Record<string, unknown> {
  const fragment = template.repeat?.reference;
  if (!fragment) throw new Error(`${template.name} has no 'reference' fragment.`);
  if (!values.references.length) throw new Error("At least one performer image is needed to save a ComfyUI project.");
  if (!values.references.some((ref) => ref.kind === "Subject")) throw new Error("At least one performer image is needed to save a ComfyUI project.");
  const prompt: Record<string, unknown> = {};
  let previous: string | null = null;
  values.references.forEach((reference, offset) => {
    const index = offset + 1;
    const nodes = applyTemplateValues(renameKeys(fragment, index), {
      index, image_file: reference.imageFile, kind: reference.kind, name: reference.name, previous_refs_node: previous ?? "",
    }) as Record<string, { inputs: Record<string, unknown> }>;
    const referenceNode = `ref_${index}`;
    if (!nodes[referenceNode]) throw new Error(`${template.name} reference fragment must define 'ref_{{index}}'.`);
    if (previous === null) delete nodes[referenceNode].inputs.previous_refs;
    Object.assign(prompt, nodes);
    previous = referenceNode;
  });
  Object.assign(prompt, applyTemplateValues(template.prompt, { song_file: values.songFile, project_name: values.projectName, refs_node: previous }));
  return prompt;
}

/** The report text from the PreviewAny node in ComfyUI history outputs, if present. */
export function createProjectReport(outputs: unknown): string | null {
  const text = (outputs as Record<string, { text?: unknown }> | null)?.report?.text;
  return Array.isArray(text) && typeof text[0] === "string" ? text[0] : null;
}
