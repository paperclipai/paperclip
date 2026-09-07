import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
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
import { localizedAgentRoleLabels } from "../lib/entity-labels";

/* ---- Help text for (?) tooltips ---- */
export const help: Record<string, string> = {
  get name() { return t("localizationAgents.help_name"); },
  get title() { return t("localizationAgents.help_title"); },
  get role() { return t("localizationAgents.help_role"); },
  get reportsTo() { return t("localizationAgents.help_reportsTo"); },
  get capabilities() { return t("localizationAgents.help_capabilities"); },
  get adapterType() { return t("localizationAgents.help_adapterType"); },
  get cwd() { return t("localizationAgents.help_cwd"); },
  get promptTemplate() { return t("localizationAgents.help_promptTemplate", { interpolation: { prefix: "{{@", suffix: "@}}" } }); },
  get model() { return t("localizationAgents.help_model"); },
  get thinkingEffort() { return t("localizationAgents.help_thinkingEffort"); },
  get chrome() { return t("localizationAgents.help_chrome"); },
  get dangerouslySkipPermissions() { return t("localizationAgents.help_dangerouslySkipPermissions"); },
  get dangerouslyBypassSandbox() { return t("localizationAgents.help_dangerouslyBypassSandbox"); },
  get search() { return t("localizationAgents.help_search"); },
  get fastMode() { return t("localizationAgents.help_fastMode"); },
  get workspaceStrategy() { return t("localizationAgents.help_workspaceStrategy"); },
  get workspaceBaseRef() { return t("localizationAgents.help_workspaceBaseRef"); },
  get workspaceBranchTemplate() { return t("localizationAgents.help_workspaceBranchTemplate", { interpolation: { prefix: "{{@", suffix: "@}}" } }); },
  get worktreeParentDir() { return t("localizationAgents.help_worktreeParentDir"); },
  get runtimeServicesJson() { return t("localizationAgents.help_runtimeServicesJson"); },
  get maxTurnsPerRun() { return t("localizationAgents.help_maxTurnsPerRun"); },
  get command() { return t("localizationAgents.help_command"); },
  get localCommand() { return t("localizationAgents.help_localCommand"); },
  get args() { return t("localizationAgents.help_args"); },
  get extraArgs() { return t("localizationAgents.help_extraArgs"); },
  get envVars() { return t("localizationAgents.help_envVars"); },
  get secretAccess() { return t("localizationAgents.help_secretAccess"); },
  get bootstrapPrompt() { return t("localizationAgents.help_bootstrapPrompt"); },
  get payloadTemplateJson() { return t("localizationAgents.help_payloadTemplateJson"); },
  get webhookUrl() { return t("localizationAgents.help_webhookUrl"); },
  get heartbeatInterval() { return t("localizationAgents.help_heartbeatInterval"); },
  get intervalSec() { return t("localizationAgents.help_intervalSec"); },
  get timeoutSec() { return t("localizationAgents.help_timeoutSec"); },
  get graceSec() { return t("localizationAgents.help_graceSec"); },
  get wakeOnDemand() { return t("localizationAgents.help_wakeOnDemand"); },
  get cooldownSec() { return t("localizationAgents.help_cooldownSec"); },
  get maxConcurrentRuns() { return t("localizationAgents.help_maxConcurrentRuns"); },
  get maxTurnContinuationEnabled() { return t("localizationAgents.help_maxTurnContinuationEnabled"); },
  get maxTurnContinuationMaxAttempts() { return t("localizationAgents.help_maxTurnContinuationMaxAttempts"); },
  get maxTurnContinuationDelaySec() { return t("localizationAgents.help_maxTurnContinuationDelaySec"); },
  get budgetMonthlyCents() { return t("localizationAgents.help_budgetMonthlyCents"); },
};

import { getAdapterLabels } from "../adapters/adapter-display-registry";

export const adapterLabels = getAdapterLabels();

export const roleLabels = localizedAgentRoleLabels;

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
      {/* Gallery feedback r3: was a hand-rolled h-5 w-9 pill with a bg-green-600
          track — the app's second switch implementation. Converged on the one
          canonical ToggleSwitch (status-green on-state), DESIGN.md principle 1. */}
      <ToggleSwitch
        data-testid={toggleTestId}
        checked={checked}
        onCheckedChange={onChange}
      />
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
        <ToggleSwitch
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
        onClick={() => setOpen(true)}
      >
        {t("localizationAgents.choosePath")}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("localizationAgents.manualPath")}</DialogTitle>
            <DialogDescription>
              {t("localizationAgents.browserPathSecurity")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="space-y-1.5">
              <p className="font-medium">macOS (Finder)</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("localizationAgents.findInFinder")}</li>
                <li><Trans i18nKey="localizationAgents.holdOption" components={{ key: <kbd /> }} /></li>
                <li>{t("localizationAgents.finderCopy")}</li>
                <li>{t("localizationAgents.pastePath")}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                /Users/yourname/Documents/project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{t("localizationAgents.windowsExplorer")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("localizationAgents.findExplorer")}</li>
                <li><Trans i18nKey="localizationAgents.holdShift" components={{ key: <kbd /> }} /></li>
                <li>{t("localizationAgents.copyAsPath")}</li>
                <li>{t("localizationAgents.pastePath")}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                C:\Users\yourname\Documents\project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{t("localizationAgents.terminalFallback")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li><Trans i18nKey="localizationAgents.runCd" components={{ key: <code /> }} /></li>
                <li><Trans i18nKey="localizationAgents.runPwd" components={{ key: <code /> }} /></li>
                <li>{t("localizationAgents.copyOutput")}</li>
              </ol>
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("localizationAgents.understood")}
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
