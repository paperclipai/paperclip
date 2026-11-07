import { t, useTranslation, i18n } from "@/i18n";
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
import { getAgentConfigDisplayText, getAgentRoleLabel } from "../adapters/display-translations";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";

/* ---- Help text for (?) tooltips ---- */
export const help: Record<string, string> = {
  get name() { return t("agent-config:displayNameForThisAgent_218242d"); },
  get title() { return t("agent-config:pathHelp_aa9834e7"); },
  get role() { return t("agent-config:organizationalRoleDeterminesPositionAndCapabilities_f1327d1"); },
  get reportsTo() { return t("agent-config:theAgentThisOneReportsToInThe_57937e6"); },
  get capabilities() { return t("agent-config:describesWhatThisAgentCanDoShownIn_042371f"); },
  get adapterType() { return t("agent-config:howThisAgentRunsLocalCliClaudeCodex_e1b34e8"); },
  get cwd() { return t("agent-config:deprecatedLegacyWorkingDirectoryFallbackForLocalAdapters_246fdfd"); },
  get promptTemplate() { return t("agent-config:sentOnEveryHeartbeatKeepThisSmallAnd_0535c4f", { interpolation: { skipOnVariables: false } }); },
  get model() { return t("agent-config:overrideTheDefaultModelUsedByTheAdapter_ba4f99e"); },
  get thinkingEffort() { return t("agent-config:controlModelReasoningDepthSupportedValuesVaryBy_ba698c4"); },
  get chrome() { return t("agent-config:enableClaudeSChromeIntegrationByPassingChrome_4952df5"); },
  get dangerouslySkipPermissions() { return t("agent-config:runUnattendedByAutoApprovingAdapterPermissionPrompts_5865926"); },
  get dangerouslyBypassSandbox() { return t("agent-config:runCodexWithoutSandboxRestrictionsRequiredForFilesystem_7ab5938"); },
  get search() { return t("agent-config:enableCodexWebSearchCapabilityDuringRuns_1f3af9b"); },
  get fastMode() { return t("agent-config:enableCodexFastModeThisBurnsCreditsTokens_aa3a9c3"); },
  get workspaceStrategy() { return t("agent-config:howPaperclipShouldRealizeAnExecutionWorkspaceFor_86e70aa"); },
  get workspaceBaseRef() { return t("agent-config:baseGitRefUsedWhenCreatingAWorktree_f61dc23"); },
  get workspaceBranchTemplate() { return t("agent-config:templateForNamingDerivedBranchesSupportsValueValue_0c4469e", { interpolation: { skipOnVariables: false } }); },
  get worktreeParentDir() { return t("agent-config:directoryWhereDerivedWorktreesShouldBeCreatedAbsolute_5156652"); },
  get runtimeServicesJson() { return t("agent-config:optionalWorkspaceRuntimeServiceDefinitionsUseThisFor_31d4eb5"); },
  get maxTurnsPerRun() { return t("agent-config:maximumNumberOfAgenticTurnsToolCallsPer_6549630"); },
  get command() { return t("agent-config:theCommandToExecuteEGNodePython_c5373d1"); },
  get localCommand() { return t("agent-config:overrideThePathToTheCliCommandYou_0072577"); },
  get args() { return t("agent-config:commandLineArgumentsCommaSeparated_1e50e05"); },
  get extraArgs() { return t("agent-config:extraCliArgumentsForLocalAdaptersCommaSeparated_4adf09f"); },
  get envVars() { return t("agent-config:environmentVariablesInjectedIntoTheAdapterProcessUse_50b61dd"); },
  get secretAccess() { return t("agent-config:secretsThisAgentCanReachEnvVarBindings_a13e386"); },
  get bootstrapPrompt() { return t("agent-config:onlySentWhenPaperclipStartsAFreshSession_9eca31c"); },
  get payloadTemplateJson() { return t("agent-config:optionalJsonMergedIntoRemoteAdapterRequestPayloads_8eb267a"); },
  get webhookUrl() { return t("agent-config:theUrlThatReceivesPostRequestsWhenThe_7f1a9d1"); },
  get heartbeatInterval() { return t("agent-config:runThisAgentAutomaticallyOnATimerUseful_7c3c865"); },
  get intervalSec() { return t("agent-config:secondsBetweenAutomaticHeartbeatInvocations_f3cfd77"); },
  get timeoutSec() { return t("agent-config:maximumSecondsARunCanTakeBeforeBeing_9eeb3a8"); },
  get graceSec() { return t("agent-config:secondsToWaitAfterSendingInterruptBeforeForce_06ea360"); },
  get wakeOnDemand() { return t("agent-config:allowThisAgentToBeWokenByAssignments_f809c33"); },
  get cooldownSec() { return t("agent-config:minimumSecondsBetweenConsecutiveHeartbeatRuns_4e9b842"); },
  get maxConcurrentRuns() { return t("agent-config:maximumNumberOfHeartbeatRunsThatCanExecute_a519c30"); },
  get maxTurnContinuationEnabled() { return t("agent-config:automaticallyQueueBoundedContinuationRunsWhenAnAdapter_4c6f145"); },
  get maxTurnContinuationMaxAttempts() { return t("agent-config:maximumAutomaticContinuationsAfterOneMaxTurnStop_8355c4b"); },
  get maxTurnContinuationDelaySec() { return t("agent-config:secondsToWaitBeforeStartingEachMaxTurn_fc22296"); },
  get budgetMonthlyCents() { return t("agent-config:monthlySpendingLimitInCents0MeansNo_6fef348"); },
};

import { getAdapterLabel, getAdapterLabels } from "../adapters/adapter-display-registry";

export const adapterLabels: Record<string, string> = Object.defineProperties({}, Object.fromEntries(
  Object.keys(getAdapterLabels()).map((type) => [type, { enumerable: true, get: () => getAdapterLabel(type) }]),
));

export const roleLabels: Record<string, string> = Object.defineProperties({}, Object.fromEntries(
  Object.keys(AGENT_ROLE_LABELS).map((role) => [role, { enumerable: true, get: () => getAgentRoleLabel(role) }]),
));

/* ---- Primitive components ---- */

export function HintIcon({ text }: { text: string }) {
  useTranslation("agent-config");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={text} className="inline-flex text-muted-foreground/50 hover:text-muted-foreground transition-colors">
          <HelpCircle className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode; configSection?: import("../adapters/types").AdapterConfigSection }) {
  useTranslation("agent-config");
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
  useTranslation("agent-config");
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
        aria-label={label}
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
  useTranslation("agent-config");
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
  useTranslation("agent-config");
  return (
    <div className={cn(bordered && "border-t border-border")}>
      <button
        type="button"
        aria-expanded={open}
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
  useTranslation("agent-config");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight, i18n.resolvedLanguage]);

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
  useTranslation("agent-config");
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
  useTranslation("agent-config");
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
  }, [minHeight, i18n.resolvedLanguage]);

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
  useTranslation("agent-config");
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
  const { t } = useTranslation("agent-config");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
        onClick={() => setOpen(true)}
      >{t("agent-config:choose_78b7c9f")}</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("agent-config:pathHelp_69e3ccf6")}</DialogTitle>
            <DialogDescription>{t("agent-config:pathHelp_518ee87d")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="space-y-1.5">
              <p className="font-medium">{t("agent-config:pathHelp_3062366d")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("agent-config:pathHelp_104cd52e")}</li>
                <li>{t("agent-config:hold_3bd3283")} <kbd>{t("agent-config:option_e31d972")}</kbd> {t("agent-config:andRightClickTheFolder_bb9f12a")}</li>
                <li>{t("agent-config:pathHelp_32393ab7")}</li>
                <li>{t("agent-config:pathHelp_17b3e1f6")}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                /Users/yourname/Documents/project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{t("agent-config:pathHelp_4301ae38")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("agent-config:pathHelp_90ba5754")}</li>
                <li>{t("agent-config:hold_3bd3283")} <kbd>{t("agent-config:shift_469d5b1")}</kbd> {t("agent-config:andRightClickTheFolder_bb9f12a")}</li>
                <li>{t("agent-config:pathHelp_752e3bff")}</li>
                <li>{t("agent-config:pathHelp_17b3e1f6")}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">{"C:\\Users\\yourname\\Documents\\project"}</p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{t("agent-config:pathHelp_ed492ced")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{t("agent-config:run_b1b3926")} <code>cd /path/to/folder</code>.</li>
                <li>{t("agent-config:run_b1b3926")} <code>pwd</code>.</li>
                <li>{t("agent-config:pathHelp_a1b1947e")}</li>
              </ol>
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("agent-config:pathHelp_9ce3bd42")}</Button>
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
  useTranslation("agent-config");
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
