import { useCallback, useEffect, useRef, useState } from "react";
import { DirectionView } from "./DirectionView";
import { LocationsView } from "./LocationsView";
import { PlanView } from "./PlanView";
import { ProduceView } from "./ProduceView";
import { ProjectStatus, ProjectsView, readableError } from "./ProjectsView";
import { ResultsView } from "./ResultsView";
import { Button, Icon, IconButton, LoadingPage, Notice, PageHeader, PathField, Pill, Switch, cx, type LucideIcon } from "./ui";

type View = "Projects" | "Direction" | "Plan" | "Locations" | "Produce" | "Results" | "Settings";
const views: { view: View; icon: LucideIcon }[] = [
  { view: "Projects", icon: Icon.projects }, { view: "Direction", icon: Icon.direction }, { view: "Plan", icon: Icon.plan },
  { view: "Locations", icon: Icon.locations }, { view: "Produce", icon: Icon.produce }, { view: "Results", icon: Icon.results },
];

export function App() {
  const [view, setView] = useState<View>("Projects");
  const [database, setDatabase] = useState<DatabaseStatus>();
  const [comfy, setComfy] = useState<ComfyStatus>();
  const [checking, setChecking] = useState(false);
  const [overview, setOverview] = useState<ProjectsOverview>();
  const [loadError, setLoadError] = useState("");
  const content = useRef<HTMLElement>(null);

  const refreshServices = useCallback(() => window.martini.serviceStatus().then((status) => { setDatabase(status.database); setComfy(status.comfy); }).catch(() => undefined), []);
  const refreshProjects = useCallback(() => window.martini.projects.overview()
    .then((value) => { setOverview(value); setLoadError(""); })
    .catch((error: unknown) => setLoadError(readableError(error))), []);
  const recheck = () => { setChecking(true); void refreshServices().finally(() => setChecking(false)); };

  useEffect(() => {
    void refreshServices();
    void refreshProjects();
    const timer = window.setInterval(() => void refreshServices(), 20000);
    const unsubscribe = window.martini.projects.onChanged(() => void refreshProjects());
    return () => { window.clearInterval(timer); unsubscribe(); };
  }, [refreshServices, refreshProjects]);

  // Settings (e.g. the ComfyUI output folder) may have changed while another view was open.
  useEffect(() => { if (view === "Projects") void refreshProjects(); }, [view, refreshProjects]);
  // Each page starts at its top.
  useEffect(() => { content.current?.scrollTo({ top: 0 }); }, [view]);

  const active = overview?.active ?? null;
  const onProjectChanged = (project?: ProjectDetail) => {
    if (project) setOverview((current) => current && { ...current, active: project });
    void refreshProjects();
  };
  const openComfy = () => void window.martini.openComfyUi().catch(() => undefined);

  return <div className="app-frame">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="titlebar">
      <div className="brand"><span className="brand-mark" aria-hidden><Icon.plan size={13} /></span>Martini Shot</div>
      <span className="titlebar-sep" aria-hidden />
      <span>Local AI Director</span>
      <span className={cx("conn", comfy && (comfy.connected ? "ok" : "down"))} title={comfy?.message} role="status">
        <span className="conn-dot" aria-hidden />
        {comfy ? (comfy.connected ? "ComfyUI connected" : "ComfyUI unavailable") : "Checking ComfyUI…"}
      </span>
      <IconButton icon={Icon.refresh} className={checking ? "is-checking" : undefined} label="Check the ComfyUI connection now" size="sm" tip="start" disabled={checking} onClick={recheck} />
      <span className="titlebar-spacer" />
      <Pill tone="info" icon={Icon.local} title="Martini Shot works only on this computer: no accounts, uploads, or cloud services.">Local only</Pill>
      <Button variant="quiet" size="sm" icon={Icon.external} onClick={openComfy}>Open ComfyUI</Button>
    </header>
    <div className="app-shell">
      <aside className="sidebar">
        <nav className="nav" aria-label="Main">
          {views.map(({ view: item, icon: Glyph }) => <button key={item} className="nav-item" aria-current={view === item ? "page" : undefined} onClick={() => setView(item)}>
            <Glyph size={19} aria-hidden />{item}
          </button>)}
          <span className="nav-sep" aria-hidden />
          <button className="nav-item" aria-current={view === "Settings" ? "page" : undefined} onClick={() => setView("Settings")}><Icon.settings size={19} aria-hidden />Settings</button>
        </nav>
        <div className="sidebar-foot">
          {active ? <div className="sidebar-project">
            <span className="eyebrow">Current project</span>
            <b title={active.name}>{active.name}</b>
            <ProjectStatus status={active.status} />
          </div> : <span className="muted">No project open</span>}
          <span className={cx("sidebar-line", database && (database.connected ? "ok" : "down"))} title={database?.message}>
            <Icon.database size={14} aria-hidden />{database ? (database.connected ? "Local database ready" : "Local database unavailable") : "Opening local database…"}
          </span>
        </div>
      </aside>
      <main className="content" id="main-content" ref={content} tabIndex={-1}>
        <ViewContent view={view} database={database} comfy={comfy} checking={checking} overview={overview} loadError={loadError}
          onProjectChanged={onProjectChanged} onNavigate={setView} onRecheck={recheck} onOpenComfy={openComfy} />
      </main>
    </div>
  </div>;
}

function ViewContent({ view, database, comfy, checking, overview, loadError, onProjectChanged, onNavigate, onRecheck, onOpenComfy }: {
  view: View; database?: DatabaseStatus; comfy?: ComfyStatus; checking: boolean; overview?: ProjectsOverview; loadError: string; onProjectChanged(project?: ProjectDetail): void;
  onNavigate(view: View): void; onRecheck(): void; onOpenComfy(): void;
}) {
  const active = overview?.active ?? null;
  if (view === "Projects") return <ProjectsView overview={overview} loadError={loadError} onChanged={onProjectChanged} onNavigate={onNavigate} />;
  if (view === "Direction") return <DirectionView project={active} comfy={comfy} onNavigate={onNavigate} />;
  if (view === "Plan") return <PlanView project={active} comfy={comfy} onNavigate={onNavigate} />;
  if (view === "Locations") return <LocationsView project={active} comfy={comfy} onNavigate={onNavigate} />;
  if (view === "Produce") return <ProduceView project={active} comfy={comfy} onNavigate={onNavigate} />;
  if (view === "Results") return <ResultsView project={active} comfy={comfy} onNavigate={onNavigate} />;
  return <Settings database={database} comfy={comfy} checking={checking} onRecheck={onRecheck} onOpenComfy={onOpenComfy} />;
}

/**
 * Saved machine defaults. Only settings that change what Martini Shot actually does are shown: the director LLM and the ComfyUI output
 * folder. Clip rendering uses the packaged render workflow as-is, so its model and sampler values are described, not offered as controls.
 */
function Settings({ database, comfy, checking, onRecheck, onOpenComfy }: { database?: DatabaseStatus; comfy?: ComfyStatus; checking: boolean; onRecheck(): void; onOpenComfy(): void }) {
  const [settings, setSettings] = useState<MachineSettings>();
  const [savedJson, setSavedJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string }>();
  const [llms, setLlms] = useState<{ options: string[]; selected: string | null; error: string | null }>();
  useEffect(() => {
    void window.martini.getSettings().then((value) => { setSettings(value); setSavedJson(JSON.stringify(value)); })
      .catch((reason: unknown) => setNotice({ tone: "error", text: readableError(reason) }));
  }, []);
  useEffect(() => { void window.martini.directorLlmOptions().then(setLlms).catch(() => undefined); }, [comfy?.connected]);
  if (!settings) {
    return notice ? <div className="page"><Notice tone="error" title="Settings could not be loaded" live>{notice.text}</Notice></div>
      : <LoadingPage text="Opening the local project database and checking ComfyUI…" />;
  }
  const dirty = JSON.stringify(settings) !== savedJson;
  const update = <K extends keyof MachineSettings>(key: K, value: MachineSettings[K]) => { setSettings({ ...settings, [key]: value }); setNotice(undefined); };
  const save = async () => {
    setSaving(true);
    try { const next = await window.martini.saveSettings(settings); setSettings(next); setSavedJson(JSON.stringify(next)); setNotice({ tone: "ok", text: "Saved to the local project database." }); }
    catch (reason) { setNotice({ tone: "error", text: readableError(reason) || "Could not save settings." }); }
    finally { setSaving(false); }
  };
  const llmValue = llms?.options.includes(settings.directorLlm) ? settings.directorLlm : llms?.selected ?? settings.directorLlm;

  return <div className="page settings-page">
    <PageHeader title="Settings" icon={Icon.settings} crumb="Saved defaults for this computer. Creative choices for a project live on Direction."
      actions={<Button variant="primary" icon={Icon.save} busy={saving} disabled={!dirty} onClick={() => void save()}>{dirty ? "Save settings" : "Settings saved"}</Button>} />
    {notice && <Notice tone={notice.tone} live onDismiss={() => setNotice(undefined)}>{notice.text}</Notice>}

    <div className="settings-grid">
      <section className="panel setting-card">
        <div className="setting-head"><Icon.local size={22} aria-hidden /><div><h2>ComfyUI (local, required)</h2><p>Martini Shot sends every planning, rendering, and stitching job to the ComfyUI running on this computer.</p></div></div>
        <div className="row-actions">
          <Pill tone={!comfy ? "muted" : comfy.connected ? "ok" : "warn"} icon={!comfy ? Icon.working : undefined}>{!comfy ? "Checking…" : comfy.connected ? "Connected" : "Unavailable"}</Pill>
          <Button variant="secondary" size="sm" icon={Icon.refresh} busy={checking} onClick={onRecheck}>Check connection</Button>
          <Button variant="quiet" size="sm" icon={Icon.external} onClick={onOpenComfy}>Open ComfyUI</Button>
        </div>
        <p className="selectable">{comfy ? (comfy.connected ? "ComfyUI is running on this computer and Martini Shot can reach it." : `Martini Shot cannot reach ComfyUI right now (${comfy.message}). Start ComfyUI yourself and wait until it has finished loading.`) : "Checking ComfyUI…"}</p>
        <PathField label="Endpoint" value={comfy?.endpoint || settings.comfyUrl} />
        <p className="muted small">ComfyUI is a prerequisite: Martini Shot does not include, install, start, stop, or update it.</p>
      </section>

      <section className="panel setting-card">
        <div className="setting-head"><Icon.database size={22} aria-hidden /><div><h2>Project database (built in)</h2><p>A single SQLite file managed by Martini Shot. There is no database server, account, password, or port to set up.</p></div></div>
        <div className="row-actions"><Pill tone={!database ? "muted" : database.connected ? "ok" : "error"} icon={!database ? Icon.working : undefined}>{!database ? "Opening…" : database.connected ? "Ready" : "Unavailable"}</Pill></div>
        <p className="selectable">{database?.message ?? "Opening local storage…"}</p>
        <PathField label="File" value={database?.storagePath ?? "Created automatically on first launch"} />
      </section>

      <section className="panel setting-card pink">
        <div className="setting-head"><Icon.direction size={22} aria-hidden /><div><h2>Director LLM</h2><p>The local language model that plans the story, chooses locations and actions, and writes clip prompts.</p></div></div>
        <label className="field"><span>Model</span>
          <select className="select" value={llmValue} onChange={(event) => update("directorLlm", event.target.value)}>
            {llms?.options.length ? llms.options.map((option) => <option key={option} value={option}>{option}</option>) : <option value={settings.directorLlm}>{settings.directorLlm}</option>}
          </select>
        </label>
        {llms?.error && <Notice tone="warn" title="Installed models could not be listed">
          <p className="selectable">{llms.error}</p><p className="muted small">The list comes from the running ComfyUI's Prompt LLM Loader. The saved choice is kept.</p>
        </Notice>}
        {llms && !llms.error && !llms.options.includes(settings.directorLlm) && llms.selected && <p className="warn-text small">The saved choice is not installed; planning uses {llms.selected}.</p>}
        <div className="info-box"><Icon.info size={16} aria-hidden /><span>The director runs autonomously: you don't write prompts or approve shots. The list shows the models installed in the running ComfyUI.</span></div>
      </section>

      <section className="panel setting-card">
        <div className="setting-head"><Icon.projects size={22} aria-hidden /><div><h2>Local project folders</h2><p>Every project, plan, package, result, and final video stays on this PC.</p></div></div>
        <label className="field"><span>Local ComfyUI output folder</span><input className="input mono" value={settings.comfyOutputDir} placeholder={String.raw`E:\...\ComfyUI\output`} onChange={(event) => update("comfyOutputDir", event.target.value)} /></label>
        <PathField label="Projects" value={projectsRootHint(settings.comfyOutputDir)} />
      </section>

      <section className="panel setting-card">
        <div className="setting-head"><Icon.render size={22} aria-hidden /><div><h2>Workflow destination</h2><p>Projects stay local. Choose where the next planning, package, render, and stitch workflow executes.</p></div></div>
        <label className="field"><span>Destination</span><select className="select" value={settings.executionDestination} onChange={(event) => update("executionDestination", event.target.value as "local" | "remote")}><option value="local">This PC</option><option value="remote">Remote ComfyUI worker</option></select></label>
        <label className="field"><span>Remote ComfyUI endpoint</span><input className="input mono" value={settings.remoteComfyUrl} placeholder="https://&lt;pod-id&gt;-8188.proxy.runpod.net" onChange={(event) => update("remoteComfyUrl", event.target.value)} /></label>
        <label className="field"><span>File API token</span><input className="input mono" type="password" value={settings.remoteFileApiToken} placeholder="MARTINI_SHOT_TOKEN" onChange={(event) => update("remoteFileApiToken", event.target.value)} /></label>
      </section>

      <section className="panel setting-card">
        <div className="setting-head"><Icon.film size={22} aria-hidden /><div><h2>Rendering</h2><p>These defaults apply to both local and remote clip renders.</p></div></div>
        <label className="control toggle-row">
          <Icon.render size={20} className="control-icon" aria-hidden />
          <div className="control-text"><b>Live sampler previews</b><p>Show rough, updating MiniMax previews while a clip is rendering. Uses a small extra amount of GPU memory; leave off for the most conservative memory behavior.</p></div>
          <Switch checked={settings.livePreviews} onChange={(livePreviews) => update("livePreviews", livePreviews)} />
        </label>
        <label className="control toggle-row">
          <Icon.render size={20} className="control-icon" aria-hidden />
          <div className="control-text"><b>VRAM cleanup between render stages</b><p>Turn off to keep models resident between queued clips for faster throughput. Uses substantially more GPU memory and skips the post-job GPU memory release.</p></div>
          <Switch checked={settings.vramCleanup} onChange={(vramCleanup) => update("vramCleanup", vramCleanup)} />
        </label>
        <label className="control toggle-row">
          <Icon.render size={20} className="control-icon" aria-hidden />
          <div className="control-text"><b>RAM cleanup between render stages</b><p>Turn off to preserve host-side caches between queued clips. Use the default when memory is constrained.</p></div>
          <Switch checked={settings.ramCleanup} onChange={(ramCleanup) => update("ramCleanup", ramCleanup)} />
        </label>
        <ul className="fixed-list">
          <li>Clips render with the MiniMax render workflow included in the app (<code>05-render-next-clip.json</code>), using its models, sampler passes, and upscaler.</li>
          <li>One clip per ComfyUI run. The next clip is sent only after the prior workflow is complete.</li>
          <li>With VRAM cleanup enabled, Martini Shot asks ComfyUI to unload models and free memory after each workflow.</li>
          <li>The final video joins the rendered clips in order with the original song.</li>
        </ul>
      </section>
    </div>
  </div>;
}

function projectsRootHint(outputDir: string): string {
  const root = outputDir.trim().replace(/[\\/]+$/, "") || "<ComfyUI output>";
  return String.raw`${root}\martini_shot\<project>`;
}
