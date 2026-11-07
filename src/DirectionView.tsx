import { useEffect, useRef, useState } from "react";
import { formatDuration, readableError } from "./ProjectsView";
import { isActive, usePlanOverview } from "./usePlan";
import { Button, Icon, IconButton, LoadingPage, NoProject, Notice, PageHeader, Pill, Slider, Switch, type LucideIcon } from "./ui";
import { DANCE_STYLES, danceStyleByName } from "./danceStyles";
import { TIMELINE_ROLES, TIMELINE_SCENES, type ForcedScenes, type TimelineRole, type TimelineScene } from "../electron/contracts";
import { chancesText, sceneChances } from "../electron/shot-mix";

const BRIEF_MAX = 1000;
const MAX_MIN_LOCATIONS = 12;

type Props = { project: ProjectDetail | null; comfy?: ComfyStatus; onNavigate(view: "Projects" | "Plan"): void };

function directionOf(record: DirectionRecord): CreativeDirection {
  const { planSeed: _planSeed, updatedAt: _updatedAt, ...direction } = record;
  return direction;
}

export function DirectionView({ project, comfy, onNavigate }: Props) {
  if (!project) return <NoProject text="Creative direction belongs to a project. Create or open one first." onProjects={() => onNavigate("Projects")} />;
  return <DirectionEditor key={project.id} project={project} comfy={comfy} onNavigate={onNavigate} />;
}

function DirectionEditor({ project, comfy, onNavigate }: { project: ProjectDetail; comfy?: ComfyStatus; onNavigate(view: "Projects" | "Plan"): void }) {
  const { overview, setOverview, error, setError } = usePlanOverview(project.id);
  const [draft, setDraft] = useState<CreativeDirection>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const pending = useRef<CreativeDirection | null>(null);
  const timer = useRef<number | undefined>(undefined);

  // Adopt saved values on first load; never overwrite text the user is still typing.
  useEffect(() => { if (overview && (!draft || !dirty)) setDraft(directionOf(overview.direction)); }, [overview]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (value: CreativeDirection): Promise<PlanOverview | undefined> => {
    window.clearTimeout(timer.current);
    pending.current = null;
    setSaving(true);
    try {
      const next = await window.martini.plan.saveDirection(project.id, value);
      setOverview(next);
      // Typing during the save queued a newer value; stay dirty until that one is saved too.
      if (!pending.current) setDirty(false);
      setError("");
      return next;
    } catch (reason) {
      setError(readableError(reason));
      return undefined;
    } finally { setSaving(false); }
  };

  const change = (patch: Partial<CreativeDirection>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setDirty(true);
    pending.current = next;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(next), 700);
  };

  // Leaving the page saves whatever is still waiting for the autosave timer.
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (pending.current) void window.martini.plan.saveDirection(project.id, pending.current).catch(() => undefined);
  }, [project.id]);

  const createPlan = async () => {
    if (!draft) return;
    setStarting(true);
    try {
      if (dirty && !(await save(draft))) return;
      setOverview(await window.martini.plan.create(project.id));
      onNavigate("Plan");
    } catch (reason) { setError(readableError(reason)); }
    finally { setStarting(false); }
  };

  if (!overview || !draft) {
    return error ? <div className="page"><Notice tone="error" title="Direction could not be loaded" live>{error}</Notice></div> : <LoadingPage text="Opening this project's direction…" />;
  }

  const running = isActive(overview.latestRun);
  const blockers = [...overview.blockers.filter((blocker) => !running || !blocker.startsWith("A director plan")),
    ...(comfy && !comfy.connected ? [`ComfyUI is not reachable at ${comfy.endpoint}. Start ComfyUI and wait for it to finish loading; Martini Shot does not start it for you.`] : [])];
  const contract = overview.plan?.creativeDirection ?? null;
  const chosenDanceStyle = danceStyleByName(draft.danceStyle);
  const stale = overview.freshness.state === "stale";
  const saveState = saving ? <><Icon.working size={15} className="spin" aria-hidden />Saving…</>
    : dirty ? <><Icon.pending size={15} aria-hidden />Unsaved changes</>
    : overview.direction.updatedAt ? <><Icon.success size={15} aria-hidden />Saved {new Date(overview.direction.updatedAt).toLocaleTimeString()}</>
    : <><Icon.info size={15} aria-hidden />Defaults — nothing entered yet</>;

  return <div className="page direction-page">
    <PageHeader title="Creative direction" icon={Icon.direction}
      crumb={<>{project.name}<span className="sep">/</span><span className="num">{formatDuration(project.songDurationSeconds)}</span></>}
      status={<span className="autosaved" aria-live="polite">{saveState}</span>} />
    {error && <Notice tone="error" live onDismiss={() => setError("")}>{error}</Notice>}

    <div className="direction-grid">
      <section className="panel direction-form">
        <label className="brief">
          <span className="brief-title">Describe the video you want <em>(optional)</em></span>
          <span className="brief-box">
            <textarea className="textarea" value={draft.creativeBrief} maxLength={BRIEF_MAX} rows={5} aria-describedby="brief-help"
              placeholder="For example: blue and pink night energy, static electricity as a recurring motif, one scene with lightning striking. Start intimate and end cathartic."
              onChange={(event) => change({ creativeBrief: event.target.value })} />
            <small className="counter num">{draft.creativeBrief.length} / {BRIEF_MAX.toLocaleString()}</small>
          </span>
        </label>
        <p className="helper" id="brief-help">This guides the director's story, overall look, any imagery that must appear, and recurring motifs. It does not require you to choose shots. Leave it empty and the director builds the story from the song alone.</p>

        <div className="control motif">
          <div className="motif-head">
            <div className="control-text">
              <b id="motif-label">Recurring motif frequency</b>
              <p id="motif-help">How often a recurring motif is offered to a shot. If your description names a motif (for example police lights), that motif is the one that recurs. At <b>0</b> no extra motif is added, though a motif from your description can still appear. This alone never asks for surreal imagery. It shapes the clip prompts written later, so changing it does not make the plan out of date.</p>
            </div>
            <input className="input motif-number" type="number" min={0} max={1} step={0.05} value={draft.motifWeight} aria-labelledby="motif-label"
              onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) change({ motifWeight: Math.min(1, Math.max(0, value)) }); }} />
          </div>
          <Slider min={0} max={1} step={0.05} value={draft.motifWeight} aria-labelledby="motif-label" aria-describedby="motif-help"
            onChange={(event) => change({ motifWeight: Number(event.target.value) })} />
        </div>

        <ToggleRow icon={Icon.motif} label="Surreal imagery" checked={draft.surrealMotifs} onChange={(surrealMotifs) => change({ surrealMotifs })}
          text="Lets recurring motifs and section hooks be surreal or impossible (floating, fractured, dreamlike). Off keeps them physically plausible. Surreal imagery you describe yourself is kept either way." />
        <ToggleRow icon={Icon.storyWheel} label="Story wheel" checked={draft.storyWheel} onChange={(storyWheel) => change({ storyWheel })}
          text="Gives every song section a dramatic job (arrival, friction, escalation, a break, and release) so the story keeps moving instead of resetting." />
        <div className="control">
          <Icon.sections size={20} className="control-icon" aria-hidden />
          <div className="control-text">
            <b id="min-loc-label">Minimum performer locations</b>
            <p>The fewest different places the performer should appear in. 0 lets the director decide.</p>
          </div>
          <div className="stepper" role="group" aria-labelledby="min-loc-label">
            <IconButton icon={Icon.minus} label="Fewer locations" size="sm" disabled={draft.minLocations <= 0} onClick={() => change({ minLocations: draft.minLocations - 1 })} />
            <input type="number" min={0} max={MAX_MIN_LOCATIONS} value={draft.minLocations} aria-labelledby="min-loc-label"
              onChange={(event) => { const value = Math.round(Number(event.target.value)); if (Number.isFinite(value)) change({ minLocations: Math.min(MAX_MIN_LOCATIONS, Math.max(0, value)) }); }} />
            <IconButton icon={Icon.add} label="More locations" size="sm" tip="end" disabled={draft.minLocations >= MAX_MIN_LOCATIONS} onClick={() => change({ minLocations: draft.minLocations + 1 })} />
          </div>
        </div>
        <ToggleRow icon={Icon.imageAdd} label="Request image references for planned performer locations" checked={draft.requestLocationImages}
          onChange={(requestLocationImages) => change({ requestLocationImages })}
          text="When the story puts the performer somewhere you have no photo of, the director names that place and asks you for one picture of it before prompts are written. Off: those places are described in text only." />
        <details className="director-controls">
          <summary>Shot mix, pacing &amp; lip sync <span>Optional director controls</span></summary>
          <h3>Render format</h3>
          <div className="clip-lengths">
            <label className="field"><span>Aspect ratio</span><select className="input" value={draft.aspectRatio} onChange={(event) => change({ aspectRatio: event.target.value })}>
              <option value="16:9">16:9 — landscape</option><option value="9:16">9:16 — portrait</option>
              <option value="4:3">4:3 — standard landscape</option><option value="3:4">3:4 — standard portrait</option>
              <option value="1:1">1:1 — square</option><option value="21:9">21:9 — ultrawide</option><option value="9:21">9:21 — tall</option>
            </select></label>
            <label className="field"><span>Video size <em>(megapixels)</em></span><input className="input num" type="number" min={0.01} step={0.01} value={draft.renderMegapixels} onChange={(event) => { const renderMegapixels = Number(event.target.value); if (Number.isFinite(renderMegapixels) && renderMegapixels > 0) change({ renderMegapixels }); }} /></label>
            <label className="field"><span>Steps <em>(per clip)</em></span><input className="input num" type="number" min={1} max={100} step={1} value={draft.renderSteps}
              title="Sampler steps for each clip. The render model is tuned for 8; more steps take longer. Applies to the next clip that renders."
              onChange={(event) => { const renderSteps = Number(event.target.value); if (Number.isInteger(renderSteps) && renderSteps >= 1 && renderSteps <= 100) change({ renderSteps }); }} /></label>
          </div>
          <p className="muted small">1 MP is the default single-pass render size. Martini Shot calculates exact dimensions divisible by 32 for the chosen ratio.</p>
          <label className="field"><span>Dance style</span><select className="select" value={chosenDanceStyle ? draft.danceStyle : "custom"}
            onChange={(event) => change({ danceStyle: event.target.value === "custom" ? "Custom" : event.target.value })}>
            {DANCE_STYLES.map((style) => <option key={style.name} value={style.name}>{style.name}</option>)}
            <option value="custom">Custom / no preset vocabulary</option>
          </select></label>
          {chosenDanceStyle ? <div className="dance-style-card" aria-live="polite">
            <p><b>{chosenDanceStyle.feel}</b> {chosenDanceStyle.dynamics}</p>
            <p><span>Move vocabulary</span>{chosenDanceStyle.moves.join(" · ")}</p>
          </div> : <label className="field dance-style-custom"><span>Custom style</span><input className="input" value={draft.danceStyle === "Custom" ? "" : draft.danceStyle} maxLength={80}
            placeholder="e.g. waacking with sharp arm patterns" onChange={(event) => change({ danceStyle: event.target.value || "Custom" })} /></label>}
          <h3>Shot mix</h3>
          <p className="muted small">Each song section gets one scene type. The weights are relative: a type's chance is its weight divided by the total. Tick a type under a role to restrict that role's sections to the ticked types.</p>
          <Dial label="Dance" value={draft.danceWeight} onChange={(danceWeight) => change({ danceWeight })} />
          <Dial label="Performance (sung to camera)" value={draft.performanceWeight} onChange={(performanceWeight) => change({ performanceWeight })} />
          <Dial label="Freeform movement" value={draft.freeformWeight} onChange={(freeformWeight) => change({ freeformWeight })} />
          <Dial label="B-roll / cutaways" value={draft.brollWeight} onChange={(brollWeight) => change({ brollWeight })} />
          <ForcedScenesGrid direction={draft} onChange={(forcedScenes) => change({ forcedScenes })} />
          <Dial label="Outfit changes" value={draft.outfitChangeRate} onChange={(outfitChangeRate) => change({ outfitChangeRate })} />
          <Dial label="Location variety" value={draft.locationVariety} onChange={(locationVariety) => change({ locationVariety })} />
          <h3>Pacing &amp; continuity</h3>
          <div className="clip-lengths"><NumberControl label="Desired clip length" value={draft.targetShotSeconds} min={2} max={30} onChange={(targetShotSeconds) => change({ targetShotSeconds })} /><NumberControl label="Minimum clip length" value={draft.minShotSeconds} min={1} max={15} onChange={(minShotSeconds) => change({ minShotSeconds })} /><NumberControl label="Maximum clip length" value={draft.maxShotSeconds} min={0} max={120} onChange={(maxShotSeconds) => change({ maxShotSeconds })} /></div>
          <Dial label="Energy-driven cuts" value={draft.cutRateVsEnergy} onChange={(cutRateVsEnergy) => change({ cutRateVsEnergy })} />
          <Dial label="Longer continuous action" value={draft.continueBias} onChange={(continueBias) => change({ continueBias })} />
          <ToggleRow icon={Icon.next} label="Repeat chorus locations" checked={draft.chorusConsistency} onChange={(chorusConsistency) => change({ chorusConsistency })} text="Similar chorus sections return to the same location when possible." />
          <ToggleRow icon={Icon.locations} label="Hard cuts change location" checked={draft.hardCutsChangeLocation} onChange={(hardCutsChangeLocation) => change({ hardCutsChangeLocation })} text="A hard cut usually moves to another supplied performer location." />
          <h3>Performance &amp; audio</h3>
          <ToggleRow icon={Icon.song} label="Lip-sync performance shots" checked={draft.lipSync} onChange={(lipSync) => change({ lipSync })} text="Transcribes the song locally with Whisper when prompts are written, then gives Performance shots vocal timing. Leave off for instrumental music." />
        </details>
      </section>

      <aside className="panel direction-help">
        <h2 className="panel-title">How the director will use this</h2>
        <p className="muted">The local director reads your description along with the song and your photos, then plans the whole story: sections, places, and what happens in each. You can review the plan before producing, but you don't have to approve anything.</p>
        <h3 className="help-subhead">Extracted guidance {contract && stale ? <Pill tone="warn">from the previous plan</Pill> : null}</h3>
        {contract ? <ContractList contract={contract} /> : <p className="muted small">{overview.plan
          ? "The planner found no look, motif, or required event in the description used for the current plan."
          : "Appears after the first plan. The planner pulls out a look, one recurring motif, and one required event, but only what your description actually asks for."}</p>}
        <h3 className="help-subhead">What you don't need to do</h3>
        <ul className="checks">
          <li><Icon.check size={16} aria-hidden />You don't need to list or design individual shots.</li>
          <li><Icon.check size={16} aria-hidden />The director handles the full sequence, coverage, and continuity.</li>
          <li><Icon.check size={16} aria-hidden />Reviewing the plan is optional; producing uses it unchanged.</li>
        </ul>
      </aside>
    </div>

    <footer className="view-foot">
      <div className="foot-status">
        {running && <p className="info-text foot-line"><Icon.working size={15} className="spin" aria-hidden />A director plan is being made. <Button variant="link" size="sm" iconEnd={Icon.next} onClick={() => onNavigate("Plan")}>Watch it on Plan</Button></p>}
        {!running && stale && <p className="warn-text foot-line"><Icon.warning size={15} aria-hidden /><span>The current plan is out of date: {overview.freshness.reasons.join(" ")} Create a new plan to use this direction.</span></p>}
        {!running && overview.freshness.state === "fresh" && <p className="muted foot-line"><Icon.success size={15} aria-hidden />The current plan already matches this direction. Creating it again reuses the cached plan.</p>}
        {blockers.map((blocker) => <p key={blocker} className="error-text foot-line"><Icon.error size={15} aria-hidden /><span>{blocker}</span></p>)}
      </div>
      <Button variant="secondary" size="lg" icon={dirty ? Icon.save : Icon.check} busy={saving} disabled={!dirty} onClick={() => void save(draft)}>{dirty ? "Save direction" : "Saved"}</Button>
      <Button variant="primary" size="lg" icon={Icon.plan} iconEnd={Icon.next} busy={starting} disabled={running || blockers.length > 0} onClick={() => void createPlan()}>
        {starting ? "Starting…" : "Create director plan"}
      </Button>
    </footer>
  </div>;
}

export function ContractList({ contract }: { contract: NonNullable<PlanData["creativeDirection"]> }) {
  const rows: { icon: LucideIcon; label: string; value: string | null | undefined }[] = [
    { icon: Icon.look, label: "Look", value: contract.look }, { icon: Icon.motif, label: "Recurring motif", value: contract.motif },
    { icon: Icon.event, label: "Required one-off event", value: contract.event },
  ];
  return <dl className="contract-list">
    {rows.filter((row) => row.value).map(({ icon: Glyph, label, value }) => <div key={label}>
      <Glyph size={18} aria-hidden /><dt>{label}</dt><dd className="selectable">{value}</dd>
    </div>)}
  </dl>;
}

function ToggleRow({ icon: Glyph, label, text, checked, onChange }: { icon: LucideIcon; label: string; text: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="control toggle-row">
    <Glyph size={20} className="control-icon" aria-hidden />
    <div className="control-text"><b>{label}</b><p>{text}</p></div>
    <Switch checked={checked} onChange={onChange} />
  </label>;
}

function Dial({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  return <label className="control dial"><div className="control-text"><b>{label}</b><p>{Math.round(value * 100)}%</p></div><Slider min={0} max={1} step={0.05} value={value} onChange={(event) => onChange(Number(event.target.value))} /><output className="num">{Math.round(value * 100)}%</output></label>;
}

/** Scene types forced per song role, plus the chance of each type that results. */
function ForcedScenesGrid({ direction, onChange }: { direction: CreativeDirection; onChange(forced: ForcedScenes): void }) {
  const forced = direction.forcedScenes;
  const toggle = (role: TimelineRole, scene: TimelineScene, on: boolean) => {
    const ticked = new Set(forced[role] ?? []);
    if (on) ticked.add(scene); else ticked.delete(scene);
    const next: ForcedScenes = { ...forced };
    const scenes = TIMELINE_SCENES.filter((name) => ticked.has(name));
    if (scenes.length) next[role] = scenes; else delete next[role];
    onChange(next);
  };
  const forcedRoles = TIMELINE_ROLES.filter((role) => forced[role]?.length);
  return <div className="shot-mix-force">
    <table className="shot-mix-grid">
      <caption className="muted small">Force scene types by section role</caption>
      <thead><tr><th scope="col" />{TIMELINE_ROLES.map((role) => <th key={role} scope="col">{role}</th>)}</tr></thead>
      <tbody>{TIMELINE_SCENES.map((scene) => <tr key={scene}>
        <th scope="row">{scene}</th>
        {TIMELINE_ROLES.map((role) => <td key={role}><input type="checkbox" aria-label={`Force ${scene} for ${role} sections`}
          checked={forced[role]?.includes(scene) ?? false} onChange={(event) => toggle(role, scene, event.target.checked)} /></td>)}
      </tr>)}</tbody>
    </table>
    <ul className="shot-mix-summary muted small" aria-live="polite">
      <li><b>{forcedRoles.length ? "Other sections" : "Every section"}:</b> {chancesText(sceneChances(direction))}</li>
      {forcedRoles.map((role) => <li key={role}><b>{role}:</b> {chancesText(sceneChances(direction, forced[role]))}</li>)}
    </ul>
    <p className="muted small">Scene types you mark on the song timeline still win, and with no performer reference every shot is B-roll.</p>
  </div>;
}

function NumberControl({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(value: number): void }) {
  return <label className="field"><span>{label} <em>(seconds)</em></span><input className="input num" type="number" min={min} max={max} step={0.5} value={value} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }} /></label>;
}
