import { useState } from "react";
import { readableError } from "./ProjectsView";
import { Button, ConfirmDialog, Icon, Pill } from "./ui";
import type { SectionActionImpact } from "../electron/contracts";

const MAX_LENGTH = 600;

/** Edits one song section's action. Used on Plan and on Produce. When the current prompt package already has clips for the
 *  section, saving shows which clips the local LLM will rewrite and which videos render again, and asks first. */
export function SectionActionEditor({ projectId, section, action, plannerAction, disabled, compact, onSaved, onError }: {
  projectId: string; section: number; action: string; plannerAction: string | null; disabled: boolean; compact?: boolean;
  onSaved?(overview: ProduceOverview): void; onError(message: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(action);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; impact: SectionActionImpact } | null>(null);

  const save = async (text: string, confirmed: boolean) => {
    setBusy(true);
    try {
      const overview = await window.martini.plan.editSectionAction(projectId, section, text, confirmed);
      setEditing(false);
      onSaved?.(overview);
    } catch (reason) { onError(readableError(reason)); }
    finally { setBusy(false); }
  };
  // Look up which clips this touches first (no ComfyUI needed); only an edit that rewrites clips asks to confirm.
  const begin = async (text: string) => {
    setBusy(true);
    try {
      const impact = await window.martini.plan.sectionImpact(projectId, section);
      setBusy(false);
      if (impact.retake.length) setConfirm({ text, impact });
      else await save(text, false);
    } catch (reason) { setBusy(false); onError(readableError(reason)); }
  };

  const changed = draft.trim() !== action.trim();
  if (!editing) {
    return <span className={compact ? "section-action compact" : "section-action"}>
      <span>{action || <span className="muted">No action from the planner; the rules decide.</span>}</span>
      {plannerAction !== null && <Pill tone="accent" icon={Icon.edit} title={`The planner wrote: ${plannerAction || "(no action)"}`}>Edited</Pill>}
      <Button variant="link" size="sm" icon={Icon.edit} disabled={disabled || busy} onClick={() => { setDraft(action); setEditing(true); }}
        aria-label={`Edit section ${section} action`}>Edit</Button>
    </span>;
  }
  return <div className="section-action-editor">
    <textarea className="input" value={draft} maxLength={MAX_LENGTH} disabled={busy} rows={3} data-autofocus
      aria-label={`Action for section ${section}`} onChange={(event) => setDraft(event.target.value)} />
    <div className="section-action-buttons">
      <Button variant="primary" size="sm" icon={Icon.save} busy={busy} disabled={disabled || busy || !changed || !draft.trim()} onClick={() => void begin(draft)}>Save action</Button>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
      {plannerAction !== null && plannerAction.trim() && <Button variant="quiet" size="sm" icon={Icon.retry} disabled={disabled || busy}
        onClick={() => void begin(plannerAction)}>Restore the planner's action</Button>}
    </div>
    {confirm && <ConfirmDialog title={`Rewrite section ${section}'s clips?`} icon={Icon.edit} confirmLabel="Rewrite and re-render" confirmIcon={Icon.reroll}
      confirmVariant="primary" onCancel={() => setConfirm(null)} onConfirm={() => { const { text } = confirm; setConfirm(null); void save(text, true); }}>
      <p>The new action changes clip{confirm.impact.retake.length === 1 ? "" : "s"} <b className="num">{confirm.impact.retake.join(", ")}</b>. The local LLM writes a new take for {confirm.impact.retake.length === 1 ? "it" : "each"}, built around:</p>
      <blockquote className="section-action-quote">{confirm.text.trim()}</blockquote>
      <p className="warn-text"><Icon.warning size={14} aria-hidden /> Clip{confirm.impact.rerender.length === 1 ? "" : "s"} {confirm.impact.rerender.join(", ")} will need rendering again{confirm.impact.rerender.length > confirm.impact.retake.length ? " (some reuse the rewritten clips' frames)" : ""}.</p>
      <p className="muted small">Takes run one clip at a time and can take a minute each. Existing videos move to the package's <code>superseded</code> folder; nothing is deleted.</p>
    </ConfirmDialog>}
  </div>;
}
