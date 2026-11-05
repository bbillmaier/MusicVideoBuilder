import { useState } from "react";
import { ContractList } from "./DirectionView";
import { SectionActionEditor } from "./SectionActionEditor";
import { SongTimeline } from "./SongTimeline";
import { formatDuration, formatTime, readableError } from "./ProjectsView";
import { CACHE_LABELS, cacheExplanation, elapsed, isActive, usePlanOverview, useTicker } from "./usePlan";
import { Button, ConfirmDialog, Disclosure, EmptyState, Icon, LoadingPage, NoProject, Notice, PageHeader, PanelHead, Pill, cx, type LucideIcon, type Tone } from "./ui";

const PHASES: StoryPhase[] = ["Arrival", "Friction", "Escalation", "Break", "Release"];

type Props = { project: ProjectDetail | null; comfy?: ComfyStatus; onNavigate(view: "Projects" | "Direction" | "Locations"): void };

const MODE_LABELS: Record<LocationMode, { text: string; tone: Tone; icon: LucideIcon; title: string }> = {
  image_backed: { text: "Image-backed", tone: "ok", icon: Icon.image, title: "A location photo you supplied is passed to MiniMax." },
  requested: { text: "Image requested", tone: "accent", icon: Icon.imageAdd, title: "The director asked for a photo of this place. It must be added before prompts are written." },
  text_only_broll: { text: "Text-only B-roll", tone: "muted", icon: Icon.file, title: "A place without the performer, described in text. Allowed for B-roll." },
  text_only: { text: "Text-only", tone: "warn", icon: Icon.file, title: "A described place with no photo (image requests are switched off)." },
  rules: { text: "Chosen later", tone: "muted", icon: Icon.pending, title: "The planner named no place here; the production rules pick one from your locations." },
};

const CACHE_STYLE: Record<PlanCacheResult, { tone: Tone; icon: LucideIcon }> = {
  reused: { tone: "ok", icon: Icon.success }, partly_reused: { tone: "info", icon: Icon.refresh }, new: { tone: "info", icon: Icon.plan },
  rerolled: { tone: "accent", icon: Icon.reroll }, no_llm: { tone: "muted", icon: Icon.song }, unknown: { tone: "warn", icon: Icon.warning },
};

function sectionRange(numbers: number[]): string {
  const parts: string[] = [];
  let start = numbers[0];
  for (let i = 1; i <= numbers.length; i++) {
    if (numbers[i] === numbers[i - 1] + 1) continue;
    const end = numbers[i - 1];
    parts.push(start === end ? String(start) : `${start}–${end}`);
    start = numbers[i];
  }
  return parts.join(", ");
}

/** Consecutive sections in the same group and place become one card, as in the mockup. */
function locationRuns(sections: PlanSection[]): PlanSection[][] {
  const runs: PlanSection[][] = [];
  for (const section of sections) {
    const last = runs[runs.length - 1];
    const previous = last?.[last.length - 1];
    if (previous && previous.number === section.number - 1 && previous.location.toLowerCase() === section.location.toLowerCase() && previous.locationMode === section.locationMode) last.push(section);
    else runs.push([section]);
  }
  return runs;
}

export function PlanView({ project, comfy, onNavigate }: Props) {
  if (!project) return <NoProject text="Open or create a project, add its song and performer, then create a director plan." onProjects={() => onNavigate("Projects")} />;
  return <PlanContent key={project.id} project={project} comfy={comfy} onNavigate={onNavigate} />;
}

function PlanContent({ project, comfy, onNavigate }: { project: ProjectDetail; comfy?: ComfyStatus; onNavigate: Props["onNavigate"] }) {
  const { overview, setOverview, error, setError } = usePlanOverview(project.id);
  const [confirmReroll, setConfirmReroll] = useState(false);
  const [starting, setStarting] = useState(false);
  const latest = overview?.latestRun ?? null;
  const running = isActive(latest);
  const now = useTicker(running);

  const start = async (reroll: boolean) => {
    setConfirmReroll(false);
    setStarting(true);
    try { setOverview(reroll ? await window.martini.plan.reroll(project.id, true) : await window.martini.plan.create(project.id)); setError(""); }
    catch (reason) { setError(readableError(reason)); }
    finally { setStarting(false); }
  };

  if (!overview) return error ? <div className="page"><Notice tone="error" title="The plan could not be loaded" live>{error}</Notice></div> : <LoadingPage text="Opening the director plan…" />;

  const { plan, planRun, freshness } = overview;
  const comfyDown = comfy && !comfy.connected;
  const blockers = [...overview.blockers.filter((blocker) => !running || !blocker.startsWith("A director plan")),
    ...(comfyDown ? [`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI and wait for it to finish loading, then try again. Martini Shot does not start it for you.`] : [])];
  const canStart = !starting && !running && blockers.length === 0;
  const failedAfterPlan = latest && (latest.status === "failed" || latest.status === "interrupted") && latest.id !== planRun?.id ? latest : null;
  const stale = freshness.state === "stale";
  const cache = planRun ? CACHE_STYLE[planRun.cacheResult ?? "unknown"] : null;

  return <div className="page plan-page">
    <PageHeader title="Director plan" icon={Icon.plan}
      crumb={<>{project.name}<span className="sep">/</span><span className="num">{formatDuration(plan?.durationSeconds ?? project.songDurationSeconds)}</span>
        {plan?.bpm ? <Pill tone="muted" icon={null}>{Math.round(plan.bpm)} BPM</Pill> : null}</>}
      status={plan && planRun && !running && cache ? (stale
        ? <Pill tone="warn" size="lg" title={freshness.reasons.join(" ")}>Out of date — inputs changed</Pill>
        : <Pill tone={cache.tone} icon={cache.icon} size="lg" title={cacheExplanation(planRun)}>{CACHE_LABELS[planRun.cacheResult ?? "unknown"]}</Pill>)
        : running ? <Pill tone="working" size="lg">{latest?.kind === "reroll" ? "Rerolling…" : "Planning…"}</Pill> : undefined}
      actions={plan ? <>
        <Button variant="secondary" icon={Icon.reroll} disabled={!canStart} onClick={() => setConfirmReroll(true)}>Reroll plan</Button>
        <Button variant="primary" icon={Icon.locations} iconEnd={Icon.next} onClick={() => onNavigate("Locations")}>Continue to locations</Button>
      </> : undefined} />

    {error && <Notice tone="error" live onDismiss={() => setError("")}>{error}</Notice>}
    {running && latest && <Progress run={latest} now={now} />}
    {failedAfterPlan && !running && <RunFailure run={failedAfterPlan} hasPlan={Boolean(plan)} canRetry={canStart} onRetry={() => void start(failedAfterPlan.kind === "reroll")} />}
    {plan && stale && !running && <Notice tone="warn" title="This plan was made from different inputs."
      actions={<Button variant="primary" size="sm" icon={Icon.plan} disabled={!canStart} onClick={() => void start(false)}>Create director plan</Button>}>
      <p>{freshness.reasons.join(" ")}</p>
      <p className="muted small">It is still shown below. Create a new plan to use your current direction; nothing changes until you do.</p>
    </Notice>}
    {!running && blockers.map((blocker) => <Notice key={blocker} tone="error">{blocker}</Notice>)}

    {!plan ? <>
      <SongTimeline projectId={project.id} planRunning={running} />
      <NoPlan running={running} canStart={canStart} onCreate={() => void start(false)} onDirection={() => onNavigate("Direction")} />
    </> : <>
      <Summary plan={plan} project={project} />
      <SongTimeline projectId={project.id} planRunning={running} />
      {plan.storyWheel && <StoryWheel plan={plan} />}
      <div className="plan-grid">
        <SectionPlan plan={plan} projectId={project.id} editable={!running} onError={setError} />
        <aside className="plan-side">
          <CreativeContract plan={plan} />
          <PlanNotes plan={plan} run={planRun} />
        </aside>
      </div>
      <p className="footnote"><Icon.info size={18} aria-hidden />The director writes clip prompts and manages continuity automatically. Review is optional; producing uses this plan unchanged.</p>
    </>}

    {confirmReroll && <ConfirmDialog title="Reroll the director plan?" icon={Icon.reroll} confirmLabel="Reroll plan" confirmIcon={Icon.reroll}
      cancelLabel="Keep current plan" onCancel={() => setConfirmReroll(false)} onConfirm={() => void start(true)}>
      <p>This writes a new story. Sections, places, and requested location images can all change, and later prompts will follow the new plan.</p>
      <p className="muted small">The director's planning cache is cleared to do this. The cache is shared by all projects, so the next plan run for any other project calls the LLM again.</p>
    </ConfirmDialog>}
  </div>;
}

function Progress({ run, now }: { run: PlanRun; now: number }) {
  const phase = run.activity?.phase ?? (run.status === "queued" ? "waiting" : "running");
  const text: Record<NonNullable<PlanRun["activity"]>["phase"], string> = {
    waiting: "Waiting for another ComfyUI job from Martini Shot to finish.",
    saving_project: "Saving the project's song and photos through ComfyUI first.",
    queued: `Queued in ComfyUI${run.activity?.queuePosition ? ` (position ${run.activity.queuePosition})` : ""}. Another job in ComfyUI is running.`,
    running: "Planning in ComfyUI: loading the local LLM, analyzing the song, reading location photos, then writing the story.",
    cleanup: "Plan finished. Asking ComfyUI to unload models and free memory.",
  };
  return <Notice tone="working" live title={<>{run.kind === "reroll" ? "Rerolling the plan" : "Creating the director plan"} <span className="muted num">· {elapsed(run.startedAt, now)} elapsed</span></>}>
    <p>{text[phase]}</p>
    <p className="muted small">A local LLM plan usually takes a few minutes, and longer the first time a model loads. Reused steps are much faster. You can leave this page; the plan appears here when it finishes.</p>
  </Notice>;
}

function RunFailure({ run, hasPlan, canRetry, onRetry }: { run: PlanRun; hasPlan: boolean; canRetry: boolean; onRetry(): void }) {
  return <Notice tone="error" live title={<>{run.status === "interrupted" ? "Planning was interrupted." : "Planning failed."} {hasPlan ? <span className="muted">The previous plan below is unchanged.</span> : null}</>}
    actions={<Button variant="secondary" size="sm" icon={Icon.retry} disabled={!canRetry} onClick={onRetry}>Try again</Button>}>
    <p className="error-text">{run.error}</p>
    {run.report && <Disclosure summary="Planner report" icon={Icon.log}><pre className="log">{run.report}</pre></Disclosure>}
  </Notice>;
}

function NoPlan({ running, canStart, onCreate, onDirection }: { running: boolean; canStart: boolean; onCreate(): void; onDirection(): void }) {
  return <EmptyState icon={running ? Icon.working : Icon.plan} title={running ? "The first plan is on its way" : "No director plan yet"}
    actions={!running ? <>
      <Button variant="primary" icon={Icon.plan} disabled={!canStart} onClick={onCreate}>Create director plan</Button>
      <Button variant="secondary" icon={Icon.direction} onClick={onDirection}>Edit direction</Button>
    </> : undefined}>
    <p className="muted">The director plans a connected story for the whole song: what happens in each section, where, and which extra location photos it needs. Optional direction (look, motifs, a must-have scene) is set on Direction.</p>
  </EmptyState>;
}

function Summary({ plan, project }: { plan: PlanData; project: ProjectDetail }) {
  const quota = plan.minLocations;
  const planned = plan.performerLocations.length;
  return <div className="summary-row">
    <Stat icon={Icon.song} value={formatDuration(plan.durationSeconds)} label="Duration" />
    <Stat icon={Icon.sections} value={String(plan.sections.length)} label="Sections" />
    <Stat icon={Icon.film} value="—" label="Clips" title="Clip count is fixed when the production plan and prompts are built (Produce). The story plan does not decide clip timing." note="set at Produce" />
    <Stat icon={Icon.locations} value={String(planned)} label="Performer locations" note={quota ? `minimum ${quota}${planned >= quota ? " — met" : " — not met"}` : "no minimum"} tone={quota && planned < quota ? "warn" : undefined} />
    <Stat icon={Icon.image} value={String(project.counts.location)} label="Image-backed locations supplied" />
    <Stat icon={Icon.imageAdd} value={String(plan.requestedLocations.length)} label="Requested location images"
      note={plan.requestedLocations.length ? "status on Locations" : plan.requestLocationImages ? "none needed" : "requests off"} tone={plan.requestedLocations.length ? "pink" : undefined} />
  </div>;
}

function Stat({ icon: Glyph, value, label, note, tone, title }: { icon: LucideIcon; value: string; label: string; note?: string; tone?: string; title?: string }) {
  return <div className={cx("stat", tone)} title={title}>
    <Glyph size={22} className="stat-icon" aria-hidden />
    <div><b className="num">{value}</b><span>{label}</span>{note && <small>{note}</small>}</div>
  </div>;
}

function StoryWheel({ plan }: { plan: PlanData }) {
  const byPositionCount = plan.sections.filter((section) => section.wheelPlacement === "position").length;
  return <section className="panel wheel-panel">
    <PanelHead icon={Icon.storyWheel} title={<>Story Wheel <span className="muted panel-subtitle">— narrative flow</span></>}
      aside={<span>Phase words come from the planner{byPositionCount ? `; ${byPositionCount} section(s) without a recognizable phase are placed by song position` : ""}.</span>} />
    <ol className="wheel-strip">
      {PHASES.map((phase, index) => {
        const sections = plan.sections.filter((section) => section.wheelPhase === phase);
        const lead = sections[0];
        return <li key={phase} className={cx(`phase-${index + 1}`, !sections.length && "empty")}>
          <span className="phase-number" aria-hidden>{index + 1}</span>
          <div className="phase-head">
            <b>{phase}</b>
            <span className="phase-sections">{sections.length ? `${sections.length === 1 ? "Section" : "Sections"} ${sectionRange(sections.map((section) => section.number))}` : "No sections"}</span>
          </div>
          {lead && <p>{lead.turn || lead.beat}</p>}
        </li>;
      })}
    </ol>
  </section>;
}

function SectionPlan({ plan, projectId, editable, onError }: { plan: PlanData; projectId: string; editable: boolean; onError(message: string): void }) {
  const groups: { title: string; sections: PlanSection[] }[] = plan.storyWheel
    ? PHASES.map((phase) => ({ title: phase, sections: plan.sections.filter((section) => section.wheelPhase === phase) })).filter((group) => group.sections.length)
    : [{ title: "Sections", sections: plan.sections }];
  return <section className="panel section-plan">
    <PanelHead icon={Icon.locations} title="Section plan by location"
      aside={plan.rulesOnly ? <span>No story beats were written; the production rules will choose places and actions.</span> : undefined} />
    {groups.map((group) => <div key={group.title} className="phase-group">
      {locationRuns(group.sections).map((run) => {
        const first = run[0];
        const last = run[run.length - 1];
        const mode = MODE_LABELS[first.locationMode];
        return <article key={first.number} className={cx("section-card", plan.storyWheel && `phase-${PHASES.indexOf(group.title as StoryPhase) + 1}`)}>
          <div className="section-when">
            <b>{plan.storyWheel ? group.title : "Section"}</b>
            <span className="num">Sec {sectionRange(run.map((section) => section.number))}</span>
          </div>
          <div className="section-body">
            <h3>{first.location || "Place chosen later"} <Pill tone={mode.tone} icon={mode.icon} title={mode.title}>{mode.text}</Pill></h3>
            {run.map((section) => <div key={section.number} className="section-line">
              {run.length > 1 && <span className="sec-no num">{section.number}</span>}
              <SectionActionEditor projectId={projectId} section={section.number} action={section.beat} plannerAction={section.plannerBeat ?? null}
                disabled={!editable} onError={onError} />
              {section.scene && <span className="scene-tag">{section.scene}</span>}
              {section.contrast && <span className="muted"> · contrast: {section.contrast}</span>}
            </div>)}
          </div>
          <div className="section-length">
            <b className="num"><Icon.elapsed size={15} aria-hidden />{formatDuration(last.end - first.start)}</b>
            <span className="num">{formatTime(first.start)}–{formatTime(last.end)}</span>
          </div>
        </article>;
      })}
    </div>)}
  </section>;
}

function CreativeContract({ plan }: { plan: PlanData }) {
  const contract = plan.creativeDirection;
  return <section className="panel side-panel">
    <PanelHead icon={Icon.direction} title="Creative direction" />
    {contract ? <ContractList contract={contract} /> : <p className="muted small">No look, motif, or required event was extracted. Add a description on Direction if you want to guide these.</p>}
    {contract?.event && <div className="event-allocation">
      <Icon.event size={20} aria-hidden />
      <div><b>Event allocation</b>
        <p>The required event is placed in exactly one section when clip prompts are written. The story planner does not choose that section, so it is not shown yet.</p></div>
    </div>}
  </section>;
}

function PlanNotes({ plan, run }: { plan: PlanData; run: PlanRun | null }) {
  const quotaMet = plan.performerLocations.length >= plan.minLocations;
  return <section className="panel side-panel">
    <PanelHead icon={Icon.phases} title="Plan notes" />
    <ul className="notes">
      <li className="ok"><Icon.success size={16} aria-hidden /><span>Covers the full song: {plan.sections.length} sections, {formatDuration(plan.durationSeconds)}.</span></li>
      <li className={plan.minLocations && !quotaMet ? "warn" : "ok"}>{plan.minLocations && !quotaMet ? <Icon.warning size={16} aria-hidden /> : <Icon.success size={16} aria-hidden />}
        <span>Uses {plan.performerLocations.length} performer location{plan.performerLocations.length === 1 ? "" : "s"}{plan.minLocations ? ` (minimum ${plan.minLocations})` : ""}.</span></li>
      {plan.requestedLocations.length ? <li className="pink"><Icon.imageAdd size={16} aria-hidden /><span>Asks for {plan.requestedLocations.length} location image{plan.requestedLocations.length === 1 ? "" : "s"}: {plan.requestedLocations.map((location) =>
        <span key={location.name} className="request"><b>{location.name}</b> <code className="filename" title={location.expectedPath}>{location.fileName}</code></span>)}</span></li>
        : <li className="ok"><Icon.success size={16} aria-hidden /><span>{plan.requestLocationImages ? "Needs no extra location images." : "Location image requests are off."}</span></li>}
      {plan.warnings.map((warning) => <li key={warning} className="warn"><Icon.warning size={16} aria-hidden /><span>{warning}</span></li>)}
    </ul>
    {run && <Disclosure className="evidence" summary="Evidence and report" icon={Icon.log}>
      <p className="small">{cacheExplanation(run)}</p>
      {run.cacheDetails.length > 0 && <ul className="small evidence-lines">{run.cacheDetails.map((line) => <li key={line}><code className="selectable">{line}</code></li>)}</ul>}
      <p className="small muted selectable">Seed {run.seedUsed ?? "—"}{run.seedRequested !== null && run.seedUsed !== run.seedRequested ? ` (was ${run.seedRequested})` : ""} · {run.directorLlm ?? "unknown LLM"}
        {run.storyChanged !== null && ` · story ${run.storyChanged ? "changed from" : "identical to"} the previous plan`} · finished {run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}</p>
      {run.report && <pre className="log">{run.report}</pre>}
    </Disclosure>}
  </section>;
}
