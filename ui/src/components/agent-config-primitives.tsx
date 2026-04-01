import { useState, useRef, useEffect, useCallback } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HelpCircle, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { useI18n } from "../i18n";

/* ---- Help text for (?) tooltips ---- */
export function useAgentConfigHelp(): Record<string, string> {
  const { t } = useI18n();
  return {
    name: t("agentConfig.help.name"),
    title: t("agentConfig.help.title"),
    role: t("agentConfig.help.role"),
    reportsTo: t("agentConfig.help.reportsTo"),
    capabilities: t("agentConfig.help.capabilities"),
    adapterType: t("agentConfig.help.adapterType"),
    cwd: t("agentConfig.help.cwd"),
    promptTemplate: t("agentConfig.help.promptTemplate"),
    model: t("agentConfig.help.model"),
    thinkingEffort: t("agentConfig.help.thinkingEffort"),
    chrome: t("agentConfig.help.chrome"),
    dangerouslySkipPermissions: t("agentConfig.help.dangerouslySkipPermissions"),
    dangerouslyBypassSandbox: t("agentConfig.help.dangerouslyBypassSandbox"),
    search: t("agentConfig.help.search"),
    workspaceStrategy: t("agentConfig.help.workspaceStrategy"),
    workspaceBaseRef: t("agentConfig.help.workspaceBaseRef"),
    workspaceBranchTemplate: t("agentConfig.help.workspaceBranchTemplate"),
    worktreeParentDir: t("agentConfig.help.worktreeParentDir"),
    runtimeServicesJson: t("agentConfig.help.runtimeServicesJson"),
    maxTurnsPerRun: t("agentConfig.help.maxTurnsPerRun"),
    command: t("agentConfig.help.command"),
    localCommand: t("agentConfig.help.localCommand"),
    args: t("agentConfig.help.args"),
    extraArgs: t("agentConfig.help.extraArgs"),
    envVars: t("agentConfig.help.envVars"),
    bootstrapPrompt: t("agentConfig.help.bootstrapPrompt"),
    payloadTemplateJson: t("agentConfig.help.payloadTemplateJson"),
    webhookUrl: t("agentConfig.help.webhookUrl"),
    heartbeatInterval: t("agentConfig.help.heartbeatInterval"),
    intervalSec: t("agentConfig.help.intervalSec"),
    timeoutSec: t("agentConfig.help.timeoutSec"),
    graceSec: t("agentConfig.help.graceSec"),
    wakeOnDemand: t("agentConfig.help.wakeOnDemand"),
    cooldownSec: t("agentConfig.help.cooldownSec"),
    maxConcurrentRuns: t("agentConfig.help.maxConcurrentRuns"),
    budgetMonthlyCents: t("agentConfig.help.budgetMonthlyCents"),
  };
}

export const adapterLabels: Record<string, string> = {
  claude_local: "Claude (local)",
  codex_local: "Codex (local)",
  gemini_local: "Gemini CLI (local)",
  opencode_local: "OpenCode (local)",
  openclaw_gateway: "OpenClaw Gateway",
  cursor: "Cursor (local)",
  hermes_local: "Hermes Agent",
  process: "Process",
  http: "HTTP",
};

export function useAdapterLabels(): Record<string, string> {
  const { t } = useI18n();
  return {
    claude_local: t("agentConfig.adapterLabels.claudeLocal"),
    codex_local: t("agentConfig.adapterLabels.codexLocal"),
    gemini_local: t("agentConfig.adapterLabels.geminiLocal"),
    opencode_local: t("agentConfig.adapterLabels.opencodeLocal"),
    openclaw_gateway: t("agentConfig.adapterLabels.openclawGateway"),
    cursor: t("agentConfig.adapterLabels.cursor"),
    hermes_local: t("agentConfig.adapterLabels.hermesLocal"),
    process: t("agentConfig.adapterLabels.process"),
    http: t("agentConfig.adapterLabels.http"),
  };
}

export const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/* ---- Primitive components ---- */

export function HintIcon({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex text-muted-foreground/50 hover:text-muted-foreground transition-colors">
          <HelpCircle className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <label className="text-xs text-muted-foreground">{label}</label>
        {hint && <HintIcon text={hint} />}
      </div>
      {children}
    </div>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
  toggleTestId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  toggleTestId?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        {hint && <HintIcon text={hint} />}
      </div>
      <button
        data-slot="toggle"
        data-testid={toggleTestId}
        type="button"
        className={cn(
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
          checked ? "bg-green-600" : "bg-muted"
        )}
        onClick={() => onChange(!checked)}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
            checked ? "translate-x-4.5" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}

export function ToggleWithNumber({
  label,
  hint,
  checked,
  onCheckedChange,
  number,
  onNumberChange,
  numberLabel,
  numberHint,
  numberPrefix,
  showNumber,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  number: number;
  onNumberChange: (v: number) => void;
  numberLabel: string;
  numberHint?: string;
  numberPrefix?: string;
  showNumber: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          {hint && <HintIcon text={hint} />}
        </div>
        <button
          data-slot="toggle"
          className={cn(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0",
            checked ? "bg-green-600" : "bg-muted"
          )}
          onClick={() => onCheckedChange(!checked)}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
              checked ? "translate-x-4.5" : "translate-x-0.5"
            )}
          />
        </button>
      </div>
      {showNumber && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {numberPrefix && <span>{numberPrefix}</span>}
          <input
            type="number"
            className="w-16 rounded-md border border-border px-2 py-0.5 bg-transparent outline-none text-xs font-mono text-center"
            value={number}
            onChange={(e) => onNumberChange(Number(e.target.value))}
          />
          <span>{numberLabel}</span>
          {numberHint && <HintIcon text={numberHint} />}
        </div>
      )}
    </div>
  );
}

export function CollapsibleSection({
  title,
  icon,
  open,
  onToggle,
  bordered,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(bordered && "border-t border-border")}>
      <button
        className="flex items-center gap-2 w-full px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/30 transition-colors"
        onClick={onToggle}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon}
        {title}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

export function AutoExpandTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  minRows,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  minRows?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { adjustHeight(); }, [value, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 resize-none overflow-hidden"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      style={{ minHeight }}
    />
  );
}

/**
 * Text input that manages internal draft state.
 * Calls `onCommit` on blur (and optionally on every change if `immediate` is set).
 */
export function DraftInput({
  value,
  onCommit,
  immediate,
  className,
  ...props
}: {
  value: string;
  onCommit: (v: string) => void;
  immediate?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      className={className}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      {...props}
    />
  );
}

/**
 * Auto-expanding textarea with draft state and blur-commit.
 */
export function DraftTextarea({
  value,
  onCommit,
  immediate,
  placeholder,
  minRows,
}: {
  value: string;
  onCommit: (v: string) => void;
  immediate?: boolean;
  placeholder?: string;
  minRows?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { adjustHeight(); }, [draft, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 resize-none overflow-hidden"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      style={{ minHeight }}
    />
  );
}

/**
 * Number input with draft state and blur-commit.
 */
export function DraftNumberInput({
  value,
  onCommit,
  immediate,
  className,
  ...props
}: {
  value: number;
  onCommit: (v: number) => void;
  immediate?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className" | "type">) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <input
      type="number"
      className={className}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(Number(e.target.value) || 0);
      }}
      onBlur={() => {
        const num = Number(draft) || 0;
        if (num !== value) onCommit(num);
      }}
      {...props}
    />
  );
}

/**
 * "Choose" button that opens a dialog explaining the user must manually
 * type the path due to browser security limitations.
 */
export function ChoosePathButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
        onClick={() => setOpen(true)}
      >
        {t("pathModal.choose")}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("pathModal.title")}</DialogTitle>
            <DialogDescription>
              {t("pathModal.descriptionPrefix")} <code>/Users/yourname/Documents/project</code> {t("pathModal.descriptionSuffix")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="space-y-1.5">
              <p className="font-medium">{t("pathModal.macLabel")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("pathModal.steps.mac1")}</li>
                <li>{t("pathModal.steps.mac2")}</li>
                <li>{t("pathModal.steps.mac3")}</li>
                <li>{t("pathModal.steps.mac4")}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                /Users/yourname/Documents/project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{t("pathModal.windowsLabel")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("pathModal.steps.windows1")}</li>
                <li>{t("pathModal.steps.windows2")}</li>
                <li>{t("pathModal.steps.windows3")}</li>
                <li>{t("pathModal.tips.windows")}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                C:\Users\yourname\Documents\project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{t("pathModal.terminalLabel")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("pathModal.steps.linux1")}</li>
                <li>{t("pathModal.steps.linux2")}</li>
                <li>{t("pathModal.steps.linux3")}</li>
              </ol>
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Label + input rendered on the same line (inline layout for compact fields).
 */
export function InlineField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 shrink-0">
        <label className="text-xs text-muted-foreground">{label}</label>
        {hint && <HintIcon text={hint} />}
      </div>
      <div className="w-24 ml-auto">{children}</div>
    </div>
  );
}
