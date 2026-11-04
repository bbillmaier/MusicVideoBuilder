import { useCallback, useEffect, useState } from "react";
import { readableError } from "./ProjectsView";

/** Loads a project's direction/plan overview and keeps it current through main-process change events. */
export function usePlanOverview(projectId: string | undefined) {
  const [overview, setOverview] = useState<PlanOverview>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!projectId) { setOverview(undefined); return; }
    try { setOverview(await window.martini.plan.overview(projectId)); setError(""); }
    catch (reason) { setError(readableError(reason)); }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const onChange = (changed: string) => { if (changed === projectId) void refresh(); };
    const offPlan = window.martini.plan.onChanged(onChange);
    const offProject = window.martini.projects.onChanged(onChange);
    return () => { offPlan(); offProject(); };
  }, [projectId, refresh]);

  return { overview, setOverview, error, setError, refresh };
}

export function isActive(run: PlanRun | null | undefined): boolean {
  return run?.status === "queued" || run?.status === "running";
}

/** Re-renders every second while `enabled`, for elapsed-time displays. */
export function useTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

export function elapsed(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const CACHE_LABELS: Record<PlanCacheResult, string> = {
  reused: "Plan reused — inputs unchanged",
  partly_reused: "Plan partly reused",
  new: "New plan created",
  rerolled: "Rerolled — new story",
  no_llm: "Planned from the song only",
  unknown: "Cache result not reported",
};

export function cacheExplanation(run: PlanRun): string {
  switch (run.cacheResult) {
    case "reused": return "Every planning step came from the director cache, so the story is the same as before.";
    case "partly_reused": return "Some planning steps came from the director cache; the steps whose inputs changed were planned again.";
    case "new": return "The local LLM planned every step from scratch.";
    case "rerolled": return "The director cache was cleared and a new planning seed was chosen, so the story was written again.";
    case "no_llm": return "No LLM story steps were needed: with no description, Story Wheel off, and no location minimum, the song structure and rules decide.";
    default: return "The planner report did not include cache lines.";
  }
}
