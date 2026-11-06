// Director LLM instruction texts that the app owns and sends with each workflow, so they can change without restarting
// (or redeploying) ComfyUI. Each prompt is a plain text file in workflows/prompts/ and reaches a workflow template as
// the placeholder {{prompt_<id>}}. The Martini Shot nodes keep the same texts as built-in defaults for an empty input.
//
// Only instruction prose lives here. The output-format lines the nodes parse (SECTION n | scene: … ) stay in the node
// code, so an edited prompt cannot break parsing.
import fs from "node:fs/promises";
import path from "node:path";
import { workflowDirectory } from "./workflow-template";

export type PromptDefinition = {
  /** Placeholder name without the prompt_ prefix; also the node input name. */
  id: string;
  file: string;
  title: string;
  description: string;
  /** The node constant holding the built-in default, for the drift test. */
  nodeDefault: { file: string; constant: string };
};

export const PROMPTS: readonly PromptDefinition[] = [
  {
    id: "story_system", file: "story-system.txt", title: "Story planning",
    description: "System instructions for planning one story beat per song section (Create director plan, reroll, and section rewrites).",
    nodeDefault: { file: "mv_story.py", constant: "STORY_SYSTEM" },
  },
  {
    id: "timeline_shot_rules", file: "timeline-shot-rules.txt", title: "Timeline shots",
    description: "How the story should use the shot cuts, scene types, and transitions set on the song timeline.",
    nodeDefault: { file: "mv_story.py", constant: "TIMELINE_SHOT_RULES" },
  },
  {
    id: "section_rewrite_rules", file: "section-rewrite-rules.txt", title: "Section rewrite",
    description: "Opening instructions when Save timeline rewrites the story of split, merged, or new sections.",
    nodeDefault: { file: "nodes.py", constant: "SECTION_REWRITE_RULES" },
  },
];

export function promptDirectory(isDevelopment: boolean): string {
  return path.join(workflowDirectory(isDevelopment), "prompts");
}

/** The current text of every prompt, keyed by its workflow placeholder (prompt_<id>). Read on each run, so an edited
 *  file applies to the next workflow. A missing file is an error rather than a silent fallback to the node default. */
export async function promptValues(isDevelopment: boolean): Promise<Record<string, string>> {
  const folder = promptDirectory(isDevelopment);
  const entries = await Promise.all(PROMPTS.map(async (prompt) => {
    const file = path.join(folder, prompt.file);
    const text = await fs.readFile(file, "utf-8").catch(() => { throw new Error(`The director prompt file is missing: ${file}.`); });
    const trimmed = text.replace(/\r\n/g, "\n").trim();
    if (!trimmed) throw new Error(`The director prompt file is empty: ${file}.`);
    return [`prompt_${prompt.id}`, trimmed] as const;
  }));
  return Object.fromEntries(entries);
}
