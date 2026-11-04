/**
 * Shared Martini Shot controls. Styling lives in styles.css (tokens in tokens.css); these components only fix the markup,
 * accessible names, and states so every page behaves the same way.
 */
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon, type LucideIcon } from "./icons";

export { Icon } from "./icons";
export type { LucideIcon } from "./icons";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- Buttons ---------- */

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "link" | "outline-blue" | "outline-pink";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: "sm" | "md" | "lg"; icon?: LucideIcon; iconEnd?: LucideIcon;
  /** Shows a spinner in place of the icon and blocks clicks while work started by this button is running. */
  busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Lead, iconEnd: Trail, busy, className, children, disabled, type = "button", ...rest }, ref,
) {
  const iconSize = size === "sm" ? 14 : size === "lg" ? 18 : 16;
  return <button ref={ref} type={type} className={cx("btn", `btn-${variant}`, size !== "md" && `btn-${size}`, busy && "is-busy", className)}
    disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
    {busy ? <Icon.working size={iconSize} className="spin" aria-hidden /> : Lead ? <Lead size={iconSize} aria-hidden /> : null}
    {children}
    {Trail && <Trail size={iconSize} aria-hidden />}
  </button>;
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon; label: string; size?: "sm" | "md";
  /** Tooltip alignment for buttons near the right or left edge of a panel. */
  tip?: "center" | "end" | "start";
};

/** Icon-only control: always has an accessible name and a tooltip that also appears on keyboard focus. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Glyph, label, size = "md", tip = "center", className, type = "button", ...rest }, ref,
) {
  return <button ref={ref} type={type} className={cx("icon-btn", size === "sm" && "icon-btn-sm", tip !== "center" && `tip-${tip}`, className)}
    aria-label={label} data-tip={label} {...rest}>
    <Glyph size={size === "sm" ? 15 : 17} aria-hidden />
  </button>;
});

/* ---------- Status ---------- */

export type Tone = "ok" | "working" | "queued" | "warn" | "error" | "muted" | "info" | "accent";

const TONE_ICON: Record<Tone, LucideIcon> = {
  ok: Icon.success, working: Icon.working, queued: Icon.queued, warn: Icon.warning, error: Icon.error, muted: Icon.unavailable,
  info: Icon.info, accent: Icon.locations,
};

/** A status label. Color is secondary: the icon and the words carry the meaning. */
export function Pill({ tone = "muted", icon, children, size = "md", title, className }: {
  tone?: Tone; icon?: LucideIcon | null; children: ReactNode; size?: "md" | "lg"; title?: string; className?: string;
}) {
  const Glyph = icon === null ? null : icon ?? TONE_ICON[tone];
  const spin = tone === "working" && !icon;
  return <span className={cx("pill", `tone-${tone}`, size === "lg" && "pill-lg", className)} title={title}>
    {Glyph && <Glyph size={size === "lg" ? 16 : 14} className={spin ? "spin" : undefined} aria-hidden />}
    <span>{children}</span>
  </span>;
}

type EvidenceTone = "ok" | "warn" | "fail" | "info" | "pending" | "none";
const EVIDENCE: Record<EvidenceTone, { icon: LucideIcon; label: string }> = {
  ok: { icon: Icon.success, label: "OK" }, warn: { icon: Icon.warning, label: "Warning" }, fail: { icon: Icon.error, label: "Failed" },
  info: { icon: Icon.info, label: "Info" }, pending: { icon: Icon.pending, label: "Pending" }, none: { icon: Icon.minus, label: "Not available" },
};

/** The icon at the start of an evidence/report row, with a spoken label. */
export function ToneMark({ tone }: { tone: EvidenceTone }) {
  const { icon: Glyph, label } = EVIDENCE[tone] ?? EVIDENCE.none;
  return <span className={`tone-mark ${tone}`}><Glyph size={16} aria-hidden /><span className="sr-only">{label}</span></span>;
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return <span className="spinner-wrap"><Icon.working size={size} className="spin" aria-hidden />{label && <span className="sr-only">{label}</span>}</span>;
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
    <i className="progress-fill" style={{ width: `${clamped}%` }} />
  </div>;
}

type NoticeTone = "info" | "ok" | "warn" | "error" | "working";
const NOTICE_ICON: Record<NoticeTone, LucideIcon> = { info: Icon.info, ok: Icon.success, warn: Icon.warning, error: Icon.error, working: Icon.working };

/** An inline message. `live` announces it to screen readers (alert for errors, status otherwise). */
export function Notice({ tone, title, children, actions, onDismiss, live, className }: {
  tone: NoticeTone; title?: ReactNode; children?: ReactNode; actions?: ReactNode; onDismiss?(): void; live?: boolean; className?: string;
}) {
  const Glyph = NOTICE_ICON[tone];
  return <div className={cx("notice", `notice-${tone}`, className)} role={live ? (tone === "error" ? "alert" : "status") : undefined}>
    <Glyph size={18} className={cx("notice-icon", tone === "working" && "spin")} aria-hidden />
    <div className="notice-body">
      {title && <p className="notice-title">{title}</p>}
      {children}
    </div>
    {(actions || onDismiss) && <div className="notice-actions">
      {actions}
      {onDismiss && <IconButton icon={Icon.close} label="Dismiss" size="sm" tip="end" onClick={onDismiss} />}
    </div>}
  </div>;
}

/* ---------- Layout ---------- */

export function PageHeader({ title, icon: Glyph, crumb, status, actions, note }: {
  title: ReactNode; icon?: LucideIcon; crumb?: ReactNode; status?: ReactNode; actions?: ReactNode; note?: ReactNode;
}) {
  return <header className="page-head">
    <div className="page-title">
      {Glyph && <span className="page-icon" aria-hidden><Glyph size={22} /></span>}
      <div className="page-title-text">
        <h1>{title}</h1>
        {crumb && <p className="crumb">{crumb}</p>}
      </div>
      {status && <div className="page-status">{status}</div>}
    </div>
    {(actions || note) && <div className="page-actions">
      {actions && <div className="row-actions">{actions}</div>}
      {note && <small className="page-note">{note}</small>}
    </div>}
  </header>;
}

export function PanelHead({ icon: Glyph, title, count, aside, as: Tag = "h2" }: {
  icon?: LucideIcon; title: ReactNode; count?: ReactNode; aside?: ReactNode; as?: "h2" | "h3";
}) {
  return <header className="panel-head">
    <Tag className="panel-title">{Glyph && <Glyph size={18} className="panel-title-icon" aria-hidden />}{title}{count !== undefined && <span className="count">({count})</span>}</Tag>
    {aside && <div className="panel-aside">{aside}</div>}
  </header>;
}

export function EmptyState({ icon: Glyph, title, children, actions }: { icon: LucideIcon; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return <section className="panel empty-state">
    <span className="empty-icon" aria-hidden><Glyph size={22} /></span>
    <div className="empty-body">
      <h2>{title}</h2>
      {children}
      {actions && <div className="row-actions">{actions}</div>}
    </div>
  </section>;
}

/** Shown by every project-scoped page when no project is open. */
export function NoProject({ text, onProjects }: { text: string; onProjects(): void }) {
  return <div className="page">
    <EmptyState icon={Icon.projects} title="No project is open" actions={<Button variant="primary" icon={Icon.projects} onClick={onProjects}>Go to Projects</Button>}>
      <p className="muted">{text}</p>
    </EmptyState>
  </div>;
}

export function LoadingPage({ text }: { text: string }) {
  return <div className="page"><p className="loading-line"><Spinner />{text}</p></div>;
}

/** A collapsed-by-default drawer for diagnostics. */
export function Disclosure({ summary, icon: Glyph, children, className, defaultOpen }: {
  summary: ReactNode; icon?: LucideIcon; children: ReactNode; className?: string; defaultOpen?: boolean;
}) {
  return <details className={cx("disclosure", className)} open={defaultOpen}>
    <summary><Icon.expand size={16} className="chev" aria-hidden />{Glyph && <Glyph size={16} aria-hidden />}<span className="disclosure-label">{summary}</span></summary>
    <div className="disclosure-body">{children}</div>
  </details>;
}

/* ---------- Copy / paths ---------- */

/**
 * Copies text (or runs `copy`, for main-process copies) and confirms in place. Errors are shown on the button and passed to `onError`.
 * `text` mode renders a labeled button; otherwise an icon button.
 */
export function CopyButton({ text, copy, label = "Copy", shown, onError, size = "md" }: {
  text?: string; copy?: () => Promise<unknown>; label?: string; shown?: "icon" | "text"; onError?(reason: unknown): void; size?: "sm" | "md";
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);
  const run = async () => {
    try {
      if (copy) await copy(); else await navigator.clipboard.writeText(text ?? "");
      setState("done");
    } catch (reason) { setState("failed"); onError?.(reason); }
  };
  const glyph = state === "done" ? Icon.check : state === "failed" ? Icon.error : Icon.copy;
  const current = state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return <>
    {shown === "text"
      ? <Button variant="secondary" size="sm" icon={glyph} className={cx("copy-btn", state)} onClick={() => void run()}>{current}</Button>
      : <IconButton icon={glyph} label={current} size={size} tip="end" className={cx("copy-btn", state)} onClick={() => void run()} />}
    <span className="sr-only" aria-live="polite">{state === "done" ? "Copied to the clipboard" : state === "failed" ? "Copy failed" : ""}</span>
  </>;
}

/** A selectable path with copy (and optionally open) actions. */
export function PathField({ value, copy, onOpen, openLabel = "Open folder", label, onError }: {
  value: string; copy?: () => Promise<unknown>; onOpen?(): void; openLabel?: string; label?: string; onError?(reason: unknown): void;
}) {
  return <div className="path-field">
    {label && <span className="path-label">{label}</span>}
    <code className="path" title={value}>{value}</code>
    <CopyButton text={value} copy={copy} label={label ? `Copy ${label.toLowerCase()}` : "Copy path"} onError={onError} size="sm" />
    {onOpen && <IconButton icon={Icon.openFolder} label={openLabel} size="sm" tip="end" onClick={onOpen} />}
  </div>;
}

/* ---------- Form controls ---------- */

export function Switch({ checked, onChange, label, describedBy }: { checked: boolean; onChange(value: boolean): void; label?: string; describedBy?: string }) {
  return <span className="switch">
    <input type="checkbox" role="switch" checked={checked} aria-label={label} aria-describedby={describedBy} onChange={(event) => onChange(event.target.checked)} />
    <i aria-hidden />
  </span>;
}

/** Range input whose filled track follows the value. */
export function Slider({ value, min, max, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { value: number; min: number; max: number }) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return <input type="range" className="slider" value={value} min={min} max={max} style={{ "--fill": `${fill}%` } as CSSProperties} {...rest} />;
}

/* ---------- Dialogs ---------- */

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";

/** Modal dialog: traps focus, closes on Escape or a backdrop click, and returns focus to the control that opened it. */
export function Dialog({ title, icon: Glyph, tone = "neutral", children, actions, onClose }: {
  title: ReactNode; icon?: LucideIcon; tone?: "neutral" | "warn" | "danger"; children: ReactNode; actions: ReactNode; onClose(): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = box.current;
    const items = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? items()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (event.key !== "Tab") return;
      const list = items();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={box} className={cx("dialog", `dialog-${tone}`)} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="dialog-head">
        {Glyph && <span className="dialog-icon" aria-hidden><Glyph size={18} /></span>}
        <h2 id={titleId}>{title}</h2>
      </header>
      <div className="dialog-body">{children}</div>
      <footer className="dialog-foot">{actions}</footer>
    </div>
  </div>;
}

/** Confirmation for consequential actions only. The safe choice has initial focus. */
export function ConfirmDialog({ title, icon = Icon.warning, children, confirmLabel, confirmIcon, confirmVariant = "danger", cancelLabel = "Cancel", onConfirm, onCancel, tone = "warn" }: {
  title: ReactNode; icon?: LucideIcon; children: ReactNode; confirmLabel: string; confirmIcon?: LucideIcon; confirmVariant?: ButtonVariant;
  cancelLabel?: string; onConfirm(): void; onCancel(): void; tone?: "neutral" | "warn" | "danger";
}) {
  return <Dialog title={title} icon={icon} tone={tone} onClose={onCancel} actions={<>
    <Button variant="secondary" onClick={onCancel} data-autofocus>{cancelLabel}</Button>
    <Button variant={confirmVariant} icon={confirmIcon} onClick={onConfirm}>{confirmLabel}</Button>
  </>}>{children}</Dialog>;
}
