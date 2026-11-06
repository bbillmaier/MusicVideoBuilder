// Builds the 07-postprocess-clip.json graph for one clip and checks it against the worker's real node schemas.
// Pure (no Electron/SQLite), tested in postprocess-rules.test.ts.
import type { EffectiveSettings } from "./postprocess-rules";
import { applyTemplateValues, type WorkflowTemplate } from "./workflow-template";

export type PostJob = {
  attemptId: string; cacheKey: string; sourceVideo: string; referenceImage: string; outputPath: string; sourceSha256: string;
  referenceSha256: string | null; requestedVramMode: string; effective: EffectiveSettings;
};

/** The job description the nodes receive (job_json). The Load node refuses to run when the worker's default mode no
 *  longer resolves to the mode the graph was built for, or the files differ from the hashes the app recorded. */
export function jobJson(job: PostJob): string {
  return JSON.stringify({
    attempt_id: job.attemptId, cache_key: job.cacheKey, face_mode: job.effective.faceMode,
    requested_vram_mode: job.requestedVramMode, resolved_vram_mode: job.effective.resolvedVramMode,
    source_sha256: job.sourceSha256, reference_sha256: job.referenceSha256,
    upscale: job.effective.upscale ? { resolution: job.effective.upscale.resolution, model: job.effective.upscale.ditModel, batch_size: job.effective.upscale.batchSize } : null,
    effective: job.effective,
  });
}

export function buildPostprocessPrompt(template: WorkflowTemplate, job: PostJob): Record<string, unknown> {
  const { effective } = job;
  const repeat = template.repeat ?? {};
  const need = (name: string) => { const fragment = repeat[name]; if (!fragment) throw new Error(`Workflow template is missing the ${name} fragment.`); return fragment; };
  const graph: Record<string, unknown> = { ...template.prompt };
  let last = "load";
  if (effective.face) {
    Object.assign(graph, need(effective.face.swapModel ? "replace" : "restore"), need("face_report"));
    last = "face_unload"; // the face report, then ReActor's own unload before SeedVR2 loads
  }
  if (effective.upscale) {
    Object.assign(graph, need("upscale"));
    graph.seedvr2 = JSON.parse(JSON.stringify(graph.seedvr2).replace("{{upscale_input_node}}", last));
    last = "seedvr2";
  }
  if (effective.face) {
    // the save node gets the face report text as well
    graph.save = { ...(graph.save as Record<string, unknown>), inputs: { ...((graph.save as { inputs: Record<string, unknown> }).inputs), face_report: ["face_report", 1] } };
  }
  const up = effective.upscale;
  const face = effective.face;
  const values: Record<string, unknown> = {
    source_video: job.sourceVideo, reference_image: job.referenceImage, job_json: jobJson(job), frame_ram_budget_gb: effective.frameRamBudgetGb,
    output_path: job.outputPath, final_image_node: last,
    face_detection: face?.detection, restore_model: face?.restoreModel, restore_visibility: face?.restoreVisibility, codeformer_weight: face?.codeformerWeight,
    swap_model: face?.swapModel, target_faces_order: face?.targetFacesOrder, target_faces_index: face?.targetFacesIndex,
    dit_model: up?.ditModel, device: "cuda:0", blocks_to_swap: up?.blocksToSwap, swap_io_components: up?.swapIo, dit_offload_device: up?.ditOffload,
    attention_mode: up?.attention, vae_model: up?.vaeModel, vae_tiling: up?.vaeTiling, vae_tile_size: up?.tileSize, vae_tile_overlap: up?.tileOverlap,
    vae_offload_device: up?.vaeOffload, seed: up?.seed, resolution: up?.resolution, batch_size: up?.batchSize, uniform_batch_size: up?.uniformBatch,
    temporal_overlap: up?.temporalOverlap, color_correction: up?.colorCorrection, tensor_offload_device: up?.tensorOffload,
  };
  return applyTemplateValues(graph, values) as Record<string, unknown>;
}

type InputSpec = unknown[];
type NodeInfo = { input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> }; output?: unknown[] };

/** Every problem with a prompt against ComfyUI's /object_info: missing node classes, unknown or missing inputs, links to
 *  outputs that do not exist, combo values (model files, devices, modes) the installed node does not offer, and numbers
 *  outside the node's min/max. Nothing is guessed: the installed schema decides. */
export function schemaProblems(prompt: Record<string, unknown>, info: Record<string, NodeInfo>): string[] {
  const problems: string[] = [];
  for (const [id, raw] of Object.entries(prompt)) {
    const node = raw as { class_type: string; inputs?: Record<string, unknown> };
    const spec = info[node.class_type];
    if (!spec) { problems.push(`${id}: ${node.class_type} is not installed on the worker.`); continue; }
    const all = { ...(spec.input?.required ?? {}), ...(spec.input?.optional ?? {}) };
    for (const key of Object.keys(spec.input?.required ?? {})) if (!(key in (node.inputs ?? {}))) problems.push(`${id} (${node.class_type}): required input ${key} is missing.`);
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      const input = all[key];
      if (!input) { problems.push(`${id} (${node.class_type}): the installed node has no input ${key}.`); continue; }
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number") {
        const source = prompt[value[0]] as { class_type?: string } | undefined;
        if (!source) problems.push(`${id}.${key} links to missing node ${value[0]}.`);
        else if (info[source.class_type ?? ""] && value[1] >= (info[source.class_type!].output?.length ?? 0)) problems.push(`${id}.${key} links to an output ${source.class_type} does not have.`);
        continue;
      }
      if (value && typeof value === "object" && "__value__" in (value as object)) continue;
      const [type, options] = input as [unknown, Record<string, unknown> | undefined];
      const choices = Array.isArray(type) ? type : type === "COMBO" ? (options?.options as unknown[] | undefined) : null;
      if (choices && !choices.map(String).includes(String(value))) {
        problems.push(`${id}.${key} = ${JSON.stringify(value)} is not offered by the installed ${node.class_type}${choices.length <= 12 ? ` (${choices.join(", ")})` : ` (${choices.length} options)`}.`);
      }
      if ((type === "INT" || type === "FLOAT") && typeof value === "number" && options) {
        if (typeof options.min === "number" && value < options.min) problems.push(`${id}.${key} = ${value} is below the node's minimum ${options.min}.`);
        if (typeof options.max === "number" && value > options.max) problems.push(`${id}.${key} = ${value} is above the node's maximum ${options.max}.`);
      }
      if (type === "BOOLEAN" && typeof value !== "boolean") problems.push(`${id}.${key} must be true or false.`);
    }
  }
  return problems;
}
