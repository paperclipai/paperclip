import {
  MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS,
  PAPERCLIP_MCP_TOOL_POLICIES,
  evaluateMissionControlCompletionGate,
  type FinalDeliveryInteraction,
  type Issue,
  type IssueDocument,
  type IssueDocumentSummary,
  type IssueFinalDeliveryDestination,
  type IssueThreadInteraction,
  type IssueValidationHistory,
  type MissionControlCompletionGateResult,
  type ToolPermissionPolicy,
} from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, Clock3, Send, ShieldCheck } from "lucide-react";
import { cn, relativeTime } from "@/lib/utils";

export type MissionControlPanelIssue = Pick<
  Issue,
  | "id"
  | "identifier"
  | "title"
  | "priority"
  | "assigneeAgentId"
  | "executionPolicy"
  | "executionState"
  | "documentSummaries"
>;

type MissionControlPanelDocument = IssueDocument | IssueDocumentSummary;

export interface IssueMissionControlPanelProps {
  issue: MissionControlPanelIssue;
  documents?: MissionControlPanelDocument[];
  documentsLoading?: boolean;
  documentsError?: boolean;
  interactions?: IssueThreadInteraction[];
  validationHistory?: IssueValidationHistory | null;
}

const COMPLETION_REASON_LABELS: Record<MissionControlCompletionGateResult["reason"], string> = {
  mission_control_disabled: "Mission Control disabled",
  missing_documents: "Required documents missing",
  invalid_orchestration_contract: "Invalid orchestration contract",
  orchestration_workstreams_incomplete: "Workstreams incomplete",
  validator_not_passed: "Validator has not passed",
  validator_self_attested: "Validator self-attested",
  validator_identity_mismatch: "Validator identity mismatch",
  missing_ceo_loop_decision: "CEO loop decision missing",
  invalid_ceo_loop_decision: "Invalid CEO loop decision",
  ceo_loop_iteration_mismatch: "CEO loop iteration mismatch",
  ceo_loop_decision_stale: "CEO loop decision stale",
  ceo_loop_decision_from_future: "CEO loop decision from future",
  runtime_exceeded: "Runtime exceeded",
  iteration_exceeded: "Iteration limit exceeded",
  periodic_checkpoint_required: "Checkpoint required",
  partial_completion: "Partial completion",
  approval_required: "Approval required",
  validator_pass_required: "Validator PASS required",
  autonomous_loop_not_complete: "Autonomous loop not complete",
  allowed: "Ready for completion",
};

function isFinalDeliveryInteraction(interaction: IssueThreadInteraction): interaction is FinalDeliveryInteraction {
  return interaction.kind === "final_delivery";
}

function dateMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatRelative(value: Date | string | null | undefined): string {
  if (!value || !dateMs(value)) return "unknown";
  return relativeTime(value);
}

function formatDestination(destination: IssueFinalDeliveryDestination): string {
  if (destination.platform === "telegram") {
    return ["Telegram", `chat ${destination.chatId}`, destination.threadId ? `thread ${destination.threadId}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  return ["Slack", `channel ${destination.channelId}`, destination.threadTs ? `thread ${destination.threadTs}` : null]
    .filter(Boolean)
    .join(" · ");
}

function redactSecretLikeText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._:-]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization|api[_-]?key|token|password|secret)(\s*[:=]\s*)(["']?)[^\s"',;)]+/gi, "$1$2$3[REDACTED]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[REDACTED]");
}

function truncateText(text: string, max = 180): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeDisplayText(text: string | null | undefined, max = 180): string | null {
  if (!text) return null;
  const redacted = redactSecretLikeText(text);
  return truncateText(redacted, max);
}

function validationStatusLabel(entry: IssueValidationHistory["latest"]): string {
  if (!entry?.verdict) return "No verdict";
  return entry.completionScore === null ? entry.verdict : `${entry.verdict} · score ${entry.completionScore}/10`;
}

function validationToneClass(verdict: NonNullable<IssueValidationHistory["latest"]>["verdict"]): string {
  if (verdict === "PASS") {
    return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300";
  }
  if (verdict === "REQUEST_CHANGES" || verdict === "ESCALATE") {
    return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function deliveryOutcomeLabel(interaction: FinalDeliveryInteraction): string {
  if (interaction.result?.outcome) return interaction.result.outcome;
  if (interaction.status === "pending") return "queued";
  if (interaction.status === "accepted") return "accepted";
  if (interaction.status === "rejected") return "rejected";
  if (interaction.status === "cancelled") return "cancelled";
  return interaction.status;
}

function deliveryToneClass(outcome: string): string {
  if (outcome === "delivered" || outcome === "accepted") {
    return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300";
  }
  if (outcome === "failed" || outcome === "rejected" || outcome === "cancelled") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  if (outcome === "sending" || outcome === "queued" || outcome === "pending") {
    return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function gateToneClass(gate: MissionControlCompletionGateResult): string {
  if (!gate.enabled) return "border-border bg-muted text-muted-foreground";
  if (gate.allowed) {
    return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300";
  }
  return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300";
}

function documentToneClass(present: boolean): string {
  return present
    ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300"
    : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300";
}

const MCP_TOOL_POLICIES = Object.values(PAPERCLIP_MCP_TOOL_POLICIES).sort((a, b) => a.toolName.localeCompare(b.toolName));
const MCP_READ_ONLY_ALLOWED_COUNT = MCP_TOOL_POLICIES.filter((policy) => policy.category === "read_only" && !policy.requiresExplicitApproval).length;
const MCP_APPROVAL_REQUIRED_POLICIES = MCP_TOOL_POLICIES.filter((policy) => policy.requiresExplicitApproval);
const MCP_HIGHLIGHTED_POLICIES = [
  PAPERCLIP_MCP_TOOL_POLICIES.paperclipApiRequest,
  PAPERCLIP_MCP_TOOL_POLICIES.paperclipControlIssueWorkspaceServices,
  PAPERCLIP_MCP_TOOL_POLICIES.paperclipApprovalDecision,
  PAPERCLIP_MCP_TOOL_POLICIES.paperclipRestoreIssueDocumentRevision,
].filter(Boolean);

function toolPolicyToneClass(policy: ToolPermissionPolicy): string {
  if (policy.toolName === "paperclipApiRequest") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  if (policy.requiresExplicitApproval) {
    return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300";
  }
  if (policy.category === "read_only") {
    return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function toolPolicyStatusLabel(policy: ToolPermissionPolicy): string {
  if (policy.toolName === "paperclipApiRequest") return `blocked until ${policy.requiredApprovalGate} approval`;
  if (policy.requiresExplicitApproval) return `requires ${policy.requiredApprovalGate} approval`;
  if (policy.category === "read_only") return "allowed";
  return "route guarded";
}

export function IssueMissionControlPanel({
  issue,
  documents,
  documentsLoading = false,
  documentsError = false,
  interactions = [],
  validationHistory = null,
}: IssueMissionControlPanelProps) {
  const finalDeliveryPolicy = issue.executionPolicy?.finalDelivery ?? null;
  const documentsForGate = documents && documents.length > 0 ? documents : issue.documentSummaries ?? [];
  const gate = evaluateMissionControlCompletionGate({
    issue,
    documents: documentsForGate,
  });
  const policy = gate.policy;
  const finalDeliveries = interactions
    .filter(isFinalDeliveryInteraction)
    .sort((a, b) => dateMs(b.createdAt) - dateMs(a.createdAt));
  const latestDelivery = finalDeliveries[0] ?? null;
  const validationEntries = validationHistory?.entries.length
    ? validationHistory.entries
    : validationHistory?.latest
      ? [validationHistory.latest]
      : [];
  const latestValidation = validationHistory?.latest ?? validationEntries[0] ?? null;
  const shouldRender = Boolean(
    policy?.enabled || finalDeliveryPolicy?.enabled || finalDeliveries.length > 0 || validationEntries.length > 0,
  );

  if (!shouldRender) return null;

  const requiredKeys = policy?.requiredDocumentKeys?.length
    ? policy.requiredDocumentKeys
    : [...MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS];
  const docsByKey = new Map(documentsForGate.map((doc) => [doc.key.trim().toLowerCase(), doc]));
  const latestOutcome = latestDelivery ? deliveryOutcomeLabel(latestDelivery) : null;

  return (
    <section data-testid="issue-mission-control-panel" className="space-y-4 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Mission Control
          </h3>
          <p className="text-xs text-muted-foreground">
            Completion gates, validator evidence, and final delivery for this issue.
          </p>
        </div>
        <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", gateToneClass(gate))}>
          {gate.enabled ? (gate.allowed ? "Gate: ready" : "Gate: blocked") : "Gate: off"}
        </span>
      </div>

      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reason</div>
          <div className="mt-1 text-foreground">{COMPLETION_REASON_LABELS[gate.reason]}</div>
        </div>
        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Risk / approval</div>
          <div className="mt-1 font-mono text-foreground">
            {policy ? `${policy.riskClass} · ${gate.requiredApprovalGate}` : "not configured"}
          </div>
        </div>
        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Validator</div>
          <div className="mt-1 font-mono text-foreground">
            {gate.validatorVerdict ?? (policy?.enabled ? "missing" : "not required")}
          </div>
        </div>
      </div>

      {policy?.enabled ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Required documents</div>
            {documentsLoading ? <span className="text-xs text-muted-foreground">Loading document bodies…</span> : null}
            {documentsError ? <span className="text-xs text-destructive">Could not load document bodies.</span> : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {requiredKeys.map((key) => {
              const doc = docsByKey.get(key.toLowerCase());
              const present = Boolean(doc);
              return (
                <span
                  key={key}
                  className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", documentToneClass(present))}
                  title={present ? `Updated ${formatRelative(doc?.updatedAt)}` : "Missing required Mission Control document"}
                >
                  {key}: {present ? "present" : "missing"}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="space-y-2 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">MCP/tool permissions</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Read-only tools stay allowed; live/destructive/generic actions are surfaced before execution.
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
              Read-only allowed {MCP_READ_ONLY_ALLOWED_COUNT}
            </span>
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
              Requires approval {MCP_APPROVAL_REQUIRED_POLICIES.length}
            </span>
            <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              Blocked generic API
            </span>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {MCP_HIGHLIGHTED_POLICIES.map((policy) => (
            <div key={policy.toolName} className="rounded border border-border/60 bg-card/60 px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs text-foreground">{policy.toolName}</span>
                <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", toolPolicyToneClass(policy))}>
                  {toolPolicyStatusLabel(policy)}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {policy.category} · {policy.actionRiskLevel} · {policy.riskClass}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" />
            Execution stage
          </div>
          <div className="mt-1 text-foreground">
            {issue.executionState?.status ?? "idle"}
            {issue.executionState?.currentStageType ? ` · ${issue.executionState.currentStageType}` : ""}
          </div>
          {issue.executionState?.lastDecisionOutcome ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Last decision: {issue.executionState.lastDecisionOutcome}
            </div>
          ) : null}
        </div>

        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Send className="h-3.5 w-3.5" />
            Final delivery
          </div>
          <div className="mt-1 text-foreground">
            {finalDeliveryPolicy?.enabled
              ? formatDestination(finalDeliveryPolicy.destination)
              : latestDelivery
                ? formatDestination(latestDelivery.payload.destination)
                : "not configured"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {latestDelivery && latestOutcome ? `Latest: ${latestOutcome} · ${formatRelative(latestDelivery.result?.deliveredAt ?? latestDelivery.updatedAt)}` : "No deliveries queued yet"}
          </div>
        </div>
      </div>

      {latestValidation ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Validation history</div>
            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", validationToneClass(latestValidation.verdict))}>
              {validationStatusLabel(latestValidation)}
            </span>
          </div>
          <div className="space-y-2">
            {validationEntries.slice(0, 3).map((entry) => {
              const summary = safeDisplayText(entry.summary ?? entry.bodyPreview, 260);
              const evidence = entry.evidence.map((item) => safeDisplayText(item, 180)).filter(Boolean).slice(0, 3);
              const criteria = entry.criteriaChecked.map((item) => safeDisplayText(item, 120)).filter(Boolean).slice(0, 3);
              const blockers = entry.blockingIssues.map((item) => safeDisplayText(item, 180)).filter(Boolean).slice(0, 3);
              const exactFix = safeDisplayText(entry.exactFixIfFailed, 220);
              return (
                <div key={`${entry.source}-${entry.id}`} className="rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-foreground">{entry.label}</div>
                    <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", validationToneClass(entry.verdict))}>
                      {validationStatusLabel(entry)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {entry.source === "validator_report" ? "Validator report" : "Execution decision"} · {formatRelative(entry.createdAt)}
                    {entry.revisionNumber ? ` · rev ${entry.revisionNumber}` : ""}
                    {entry.decisionOutcome ? ` · ${entry.decisionOutcome}` : ""}
                  </div>
                  {summary ? <div className="mt-2 text-sm text-foreground">{summary}</div> : null}
                  {criteria.length > 0 ? <div className="mt-1 text-xs text-muted-foreground">Criteria: {criteria.join(" · ")}</div> : null}
                  {evidence.length > 0 ? <div className="mt-1 text-xs text-muted-foreground">Evidence: {evidence.join(" · ")}</div> : null}
                  {blockers.length > 0 ? (
                    <div className="mt-2 rounded border border-amber-300/50 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                      Blockers: {blockers.join(" · ")}
                    </div>
                  ) : null}
                  {exactFix ? <div className="mt-1 text-xs text-muted-foreground">Fix: {exactFix}</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {finalDeliveries.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Delivery history</div>
          <div className="space-y-2">
            {finalDeliveries.slice(0, 3).map((delivery) => {
              const outcome = deliveryOutcomeLabel(delivery);
              const error = delivery.result?.error ? truncateText(redactSecretLikeText(delivery.result.error)) : null;
              return (
                <div key={delivery.id} className="rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {outcome === "delivered" ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : outcome === "failed" ? (
                        <AlertTriangle className="h-4 w-4 text-destructive" />
                      ) : (
                        <Send className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="font-medium text-foreground">{delivery.title ?? "Final delivery"}</span>
                    </div>
                    <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", deliveryToneClass(outcome))}>
                      {outcome}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Queued {formatRelative(delivery.payload.queuedAt ?? delivery.createdAt)} · attempts {delivery.result?.attemptCount ?? 0}
                    {delivery.result?.externalMessageId ? ` · external ${delivery.result.externalMessageId}` : ""}
                    {delivery.payload.artifacts.length > 0 ? ` · artifacts ${delivery.payload.artifacts.length}` : ""}
                  </div>
                  {delivery.summary ? <div className="mt-1 text-xs text-muted-foreground">{delivery.summary}</div> : null}
                  {error ? <div className="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
