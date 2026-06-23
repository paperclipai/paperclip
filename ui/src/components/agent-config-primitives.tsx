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
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { t, useTranslation } from "@/i18n";

/* ---- Help text for (?) tooltips ----
 * Exposed as getters so the translated strings are resolved lazily at access
 * time, keeping the existing `help.xxx` access API while reacting to language
 * changes.
 */
export const help: Record<string, string> = {
  get name() {
    return t("components.agentConfigPrimitives.helpName", { defaultValue: "Display name for this agent." });
  },
  get title() {
    return t("components.agentConfigPrimitives.helpTitle", { defaultValue: "Job title shown in the org chart." });
  },
  get role() {
    return t("components.agentConfigPrimitives.helpRole", { defaultValue: "Organizational role. Determines position and capabilities." });
  },
  get reportsTo() {
    return t("components.agentConfigPrimitives.helpReportsTo", { defaultValue: "The agent this one reports to in the org hierarchy." });
  },
  get capabilities() {
    return t("components.agentConfigPrimitives.helpCapabilities", { defaultValue: "Describes what this agent can do. Shown in the org chart and used for task routing." });
  },
  get adapterType() {
    return t("components.agentConfigPrimitives.helpAdapterType", { defaultValue: "How this agent runs: local CLI (Claude/Codex/OpenCode), OpenClaw Gateway, spawned process, or generic HTTP webhook." });
  },
  get cwd() {
    return t("components.agentConfigPrimitives.helpCwd", { defaultValue: "Deprecated legacy working directory fallback for local adapters. Existing agents may still carry this value, but new configurations should use project workspaces instead." });
  },
  get promptTemplate() {
    return t("components.agentConfigPrimitives.helpPromptTemplate", { defaultValue: "Sent on every heartbeat. Keep this small and dynamic. Use it for current-task framing, not large static instructions. Supports {{ agent.id }}, {{ agent.name }}, {{ agent.role }} and other template variables." });
  },
  get model() {
    return t("components.agentConfigPrimitives.helpModel", { defaultValue: "Override the default model used by the adapter." });
  },
  get thinkingEffort() {
    return t("components.agentConfigPrimitives.helpThinkingEffort", { defaultValue: "Control model reasoning depth. Supported values vary by adapter/model." });
  },
  get chrome() {
    return t("components.agentConfigPrimitives.helpChrome", { defaultValue: "Enable Claude's Chrome integration by passing --chrome." });
  },
  get dangerouslySkipPermissions() {
    return t("components.agentConfigPrimitives.helpDangerouslySkipPermissions", { defaultValue: "Run unattended by auto-approving adapter permission prompts when supported." });
  },
  get dangerouslyBypassSandbox() {
    return t("components.agentConfigPrimitives.helpDangerouslyBypassSandbox", { defaultValue: "Run Codex without sandbox restrictions. Required for filesystem/network access." });
  },
  get search() {
    return t("components.agentConfigPrimitives.helpSearch", { defaultValue: "Enable Codex web search capability during runs." });
  },
  get fastMode() {
    return t("components.agentConfigPrimitives.helpFastMode", { defaultValue: "Enable Codex Fast mode. This burns credits/tokens much faster and is supported on GPT-5.4 and manual Codex model IDs." });
  },
  get workspaceStrategy() {
    return t("components.agentConfigPrimitives.helpWorkspaceStrategy", { defaultValue: "How Paperclip should realize an execution workspace for this agent. Keep project_primary for normal cwd execution, or use git_worktree for issue-scoped isolated checkouts." });
  },
  get workspaceBaseRef() {
    return t("components.agentConfigPrimitives.helpWorkspaceBaseRef", { defaultValue: "Base git ref used when creating a worktree branch. Leave blank to use the resolved workspace ref or HEAD." });
  },
  get workspaceBranchTemplate() {
    return t("components.agentConfigPrimitives.helpWorkspaceBranchTemplate", { defaultValue: "Template for naming derived branches. Supports {{issue.identifier}}, {{issue.title}}, {{agent.name}}, {{project.id}}, {{workspace.repoRef}}, and {{slug}}." });
  },
  get worktreeParentDir() {
    return t("components.agentConfigPrimitives.helpWorktreeParentDir", { defaultValue: "Directory where derived worktrees should be created. Absolute, ~-prefixed, and repo-relative paths are supported." });
  },
  get runtimeServicesJson() {
    return t("components.agentConfigPrimitives.helpRuntimeServicesJson", { defaultValue: "Optional workspace runtime service definitions. Use this for shared app servers, workers, or other long-lived companion processes attached to the workspace." });
  },
  get maxTurnsPerRun() {
    return t("components.agentConfigPrimitives.helpMaxTurnsPerRun", { defaultValue: "Maximum number of agentic turns (tool calls) per heartbeat run." });
  },
  get command() {
    return t("components.agentConfigPrimitives.helpCommand", { defaultValue: "The command to execute (e.g. node, python)." });
  },
  get localCommand() {
    return t("components.agentConfigPrimitives.helpLocalCommand", { defaultValue: "Override the path to the CLI command you want the adapter to call (e.g. /usr/local/bin/claude, codex, opencode)." });
  },
  get args() {
    return t("components.agentConfigPrimitives.helpArgs", { defaultValue: "Command-line arguments, comma-separated." });
  },
  get extraArgs() {
    return t("components.agentConfigPrimitives.helpExtraArgs", { defaultValue: "Extra CLI arguments for local adapters, comma-separated." });
  },
  get envVars() {
    return t("components.agentConfigPrimitives.helpEnvVars", { defaultValue: "Environment variables injected into the adapter process. Use plain values or secret references." });
  },
  get bootstrapPrompt() {
    return t("components.agentConfigPrimitives.helpBootstrapPrompt", { defaultValue: "Only sent when Paperclip starts a fresh session. Use this for stable setup guidance that should not be repeated on every heartbeat." });
  },
  get payloadTemplateJson() {
    return t("components.agentConfigPrimitives.helpPayloadTemplateJson", { defaultValue: "Optional JSON merged into remote adapter request payloads before Paperclip adds its standard wake and workspace fields." });
  },
  get webhookUrl() {
    return t("components.agentConfigPrimitives.helpWebhookUrl", { defaultValue: "The URL that receives POST requests when the agent is invoked." });
  },
  get heartbeatInterval() {
    return t("components.agentConfigPrimitives.helpHeartbeatInterval", { defaultValue: "Run this agent automatically on a timer. Useful for periodic tasks like checking for new work." });
  },
  get intervalSec() {
    return t("components.agentConfigPrimitives.helpIntervalSec", { defaultValue: "Seconds between automatic heartbeat invocations." });
  },
  get timeoutSec() {
    return t("components.agentConfigPrimitives.helpTimeoutSec", { defaultValue: "Maximum seconds a run can take before being terminated. 0 means no timeout." });
  },
  get graceSec() {
    return t("components.agentConfigPrimitives.helpGraceSec", { defaultValue: "Seconds to wait after sending interrupt before force-killing the process." });
  },
  get wakeOnDemand() {
    return t("components.agentConfigPrimitives.helpWakeOnDemand", { defaultValue: "Allow this agent to be woken by assignments, API calls, UI actions, or automated systems." });
  },
  get cooldownSec() {
    return t("components.agentConfigPrimitives.helpCooldownSec", { defaultValue: "Minimum seconds between consecutive heartbeat runs." });
  },
  get maxConcurrentRuns() {
    return t("components.agentConfigPrimitives.helpMaxConcurrentRuns", { defaultValue: "Maximum number of heartbeat runs that can execute simultaneously for this agent." });
  },
  get maxTurnContinuationEnabled() {
    return t("components.agentConfigPrimitives.helpMaxTurnContinuationEnabled", { defaultValue: "Automatically queue bounded continuation runs when an adapter stops because its per-run turn cap was exhausted." });
  },
  get maxTurnContinuationMaxAttempts() {
    return t("components.agentConfigPrimitives.helpMaxTurnContinuationMaxAttempts", { defaultValue: "Maximum automatic continuations after one max-turn stop. This is separate from max turns per run." });
  },
  get maxTurnContinuationDelaySec() {
    return t("components.agentConfigPrimitives.helpMaxTurnContinuationDelaySec", { defaultValue: "Seconds to wait before starting each max-turn continuation." });
  },
  get budgetMonthlyCents() {
    return t("components.agentConfigPrimitives.helpBudgetMonthlyCents", { defaultValue: "Monthly spending limit in cents. 0 means no limit." });
  },
};

import { getAdapterLabels } from "../adapters/adapter-display-registry";

export const adapterLabels = getAdapterLabels();

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
        {t("components.agentConfigPrimitives.choose", { defaultValue: "Choose" })}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("components.agentConfigPrimitives.specifyPathManually", { defaultValue: "Specify path manually" })}</DialogTitle>
            <DialogDescription>
              {t("components.agentConfigPrimitives.specifyPathDescription", { defaultValue: "Browser security blocks apps from reading full local paths via a file picker. Copy the absolute path and paste it into the input." })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="space-y-1.5">
              <p className="font-medium">{t("components.agentConfigPrimitives.macosFinder", { defaultValue: "macOS (Finder)" })}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("components.agentConfigPrimitives.macosStep1", { defaultValue: "Find the folder in Finder." })}</li>
                <li>{t("components.agentConfigPrimitives.macosStep2Prefix", { defaultValue: "Hold" })} <kbd>Option</kbd> {t("components.agentConfigPrimitives.macosStep2Suffix", { defaultValue: "and right-click the folder." })}</li>
                <li>{t("components.agentConfigPrimitives.macosStep3", { defaultValue: "Click \"Copy <folder name> as Pathname\"." })}</li>
                <li>{t("components.agentConfigPrimitives.pasteResultStep", { defaultValue: "Paste the result into the path input." })}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                /Users/yourname/Documents/project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{t("components.agentConfigPrimitives.windowsFileExplorer", { defaultValue: "Windows (File Explorer)" })}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("components.agentConfigPrimitives.windowsStep1", { defaultValue: "Find the folder in File Explorer." })}</li>
                <li>{t("components.agentConfigPrimitives.windowsStep2Prefix", { defaultValue: "Hold" })} <kbd>Shift</kbd> {t("components.agentConfigPrimitives.windowsStep2Suffix", { defaultValue: "and right-click the folder." })}</li>
                <li>{t("components.agentConfigPrimitives.windowsStep3", { defaultValue: "Click \"Copy as path\"." })}</li>
                <li>{t("components.agentConfigPrimitives.pasteResultStep", { defaultValue: "Paste the result into the path input." })}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                C:\Users\yourname\Documents\project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{t("components.agentConfigPrimitives.terminalFallback", { defaultValue: "Terminal fallback (macOS/Linux)" })}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("components.agentConfigPrimitives.terminalStep1Prefix", { defaultValue: "Run" })} <code>cd /path/to/folder</code>.</li>
                <li>{t("components.agentConfigPrimitives.terminalStep2Prefix", { defaultValue: "Run" })} <code>pwd</code>.</li>
                <li>{t("components.agentConfigPrimitives.terminalStep3", { defaultValue: "Copy the output and paste it into the path input." })}</li>
              </ol>
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("components.agentConfigPrimitives.ok", { defaultValue: "OK" })}
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
