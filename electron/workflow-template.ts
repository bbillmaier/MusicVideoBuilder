import fs from "node:fs/promises";
import path from "node:path";

/** `repeat` holds named node fragments that a stage-specific builder expands once per item (e.g. one per reference image). */
export type WorkflowTemplate = { name: string; stage: string; description: string; prompt: Record<string, unknown>; repeat?: Record<string, Record<string, unknown>> };

export function applyTemplateValues(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^{{([A-Za-z0-9_.-]+)}}$/);
    if (exact) {
      if (!(exact[1] in values)) throw new Error(`Workflow value '${exact[1]}' was not supplied.`);
      return values[exact[1]];
    }
    return value.replace(/{{([A-Za-z0-9_.-]+)}}/g, (_match, key: string) => {
      if (!(key in values)) throw new Error(`Workflow value '${key}' was not supplied.`);
      return String(values[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => applyTemplateValues(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyTemplateValues(item, values)]));
  return value;
}

export function workflowDirectory(isDevelopment: boolean): string {
  // Compiled code runs from dist-electron/, so the repo's workflows/ folder is one level up.
  return isDevelopment ? path.resolve(__dirname, "../workflows") : path.join(process.resourcesPath, "app.asar", "workflows");
}

export async function loadWorkflowTemplate(isDevelopment: boolean, name: string): Promise<WorkflowTemplate> {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/i.test(name)) throw new Error("Invalid workflow template name.");
  const template = JSON.parse(await fs.readFile(path.join(workflowDirectory(isDevelopment), name), "utf-8")) as WorkflowTemplate;
  if (!template.name || !template.stage || !template.description || !template.prompt || typeof template.prompt !== "object") {
    throw new Error(`Workflow template '${name}' has an invalid shape.`);
  }
  return template;
}

export async function listWorkflowTemplates(isDevelopment: boolean): Promise<Pick<WorkflowTemplate, "name" | "stage" | "description">[]> {
  const names = await fs.readdir(workflowDirectory(isDevelopment));
  const templates = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => loadWorkflowTemplate(isDevelopment, name)));
  return templates.map(({ name, stage, description }) => ({ name, stage, description }));
}
