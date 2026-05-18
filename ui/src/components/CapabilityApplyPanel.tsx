/**
 * LET-396 — Capability Apply panel (G.3).
 *
 * Drives the LET-357 / LET-395 server-owned plan state machine:
 *
 *   pending --[request-approval]--> approval_requested
 *     approval pending / approved / rejected / cancelled / revision_requested
 *   approval_requested --[execute, server checks approval.status=approved]-->
 *     executing --> applied | partially_applied
 *   pending|approval_requested --[cancel by creator]--> cancelled
 *
 * Server is the only authority on:
 *   - dryRunHash (plan integrity)
 *   - optimisticVersion (If-Match)
 *   - approval payload contents (scope summary + sanitized steps)
 *   - approval status transitions (the reviewer accepts/rejects out-of-band
 *     via the approvals UI; this panel only reads the resulting status)
 *
 * The `capability.apply.live` flag stays OFF; only internal_safe steps ever
 * execute, and any non-internal_safe step is server-skipped with a stable
 * `LIVE_EXECUTION_DISABLED` event. The UI never claims a live MCP server,
 * tool, or skill was installed, connected, or invoked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CAPABILITY_APPLY_ERROR_CODES,
  type CapabilityApplyApprovalPayload,
  type CapabilityApplyPlanSummary,
  type CapabilityApplyPlanState,
  type CapabilityApplyStep,
  type CapabilityApplyEvent,
} from "@paperclipai/shared";
import type { ApprovalStatus } from "@paperclipai/shared";
import { capabilityApplyApi, CapabilityApplyApiError } from "../api/capabilityApply";
import { approvalsApi } from "../api/approvals";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface CapabilityApplyPanelProps {
  companyId: string;
  agentId: string;
  /** The effectiveDelta the user can convert into a plan. Optional: when
   *  absent and no plan exists yet, the panel renders the empty "no plan" state. */
  effectiveDelta?: {
    mcpServerChanges?: Array<{
      kind: "add" | "remove" | "update";
      serverId: string;
      displayName: string;
      catalogId?: string;
      transport?: string;
      riskClass?: string;
      requiredSecretNames?: string[];
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
    }>;
    skillRefChanges?: Array<{ kind: "add" | "remove"; ref: string }>;
    toolRefChanges?: Array<{ kind: "add" | "remove"; ref: string }>;
  };
  /** Resume an existing plan by id (e.g. from URL or parent state). */
  currentPlanId?: string | null;
  onPlanCreated?: (plan: CapabilityApplyPlanSummary) => void;
}

// ── Stable status copy ────────────────────────────────────────────────────────

const PLAN_STATE_LABEL: Record<CapabilityApplyPlanState, string> = {
  pending: "Pending — preview built",
  approval_requested: "Approval requested",
  approved: "Approved — ready to execute",
  executing: "Executing",
  applied: "Applied",
  partially_applied: "Partially applied",
  cancelled: "Cancelled",
  declined: "Declined",
  expired: "Expired",
};

const PLAN_STATE_CLASS: Record<CapabilityApplyPlanState, string> = {
  pending: "bg-gray-100 text-gray-800 border-gray-300",
  approval_requested: "bg-blue-100 text-blue-900 border-blue-300",
  approved: "bg-emerald-100 text-emerald-900 border-emerald-300",
  executing: "bg-indigo-100 text-indigo-900 border-indigo-300",
  applied: "bg-emerald-200 text-emerald-950 border-emerald-400",
  partially_applied: "bg-amber-100 text-amber-900 border-amber-300",
  cancelled: "bg-gray-200 text-gray-700 border-gray-300",
  declined: "bg-red-100 text-red-800 border-red-300",
  expired: "bg-gray-300 text-gray-800 border-gray-400",
};

const RISK_CLASS_STYLE: Record<string, string> = {
  internal_safe: "bg-emerald-50 text-emerald-900 border-emerald-200",
  external_readonly: "bg-yellow-50 text-yellow-900 border-yellow-200",
  external_write: "bg-amber-50 text-amber-900 border-amber-300",
  destructive_or_spend: "bg-red-50 text-red-900 border-red-300",
  governance_critical: "bg-red-100 text-red-950 border-red-500",
};

// Map server error codes to user-facing copy. Never leak raw payloads.
function errorCopy(code: string | null, fallback: string): { title: string; detail: string } {
  switch (code) {
    case CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH:
      return {
        title: "Plan hash changed",
        detail:
          "The desired-config dry-run no longer matches this plan's locked hash. Re-run Apply Preview and build a fresh plan. No live action occurred.",
      };
    case CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED:
      return {
        title: "Approval not yet accepted",
        detail:
          "An approver has not accepted this plan. Execution stays blocked until the reviewer accepts the approval. No live action occurred.",
      };
    case CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED:
      return {
        title: "Approval already consumed",
        detail:
          "This single-use approval has already been spent or the plan reached a terminal state. Build a fresh plan to apply again. No live action occurred.",
      };
    case CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE:
      return {
        title: "Separate governance workflow required",
        detail:
          "One or more steps need a separate governance workflow (governance_critical or unverified catalog entries). They cannot be approved here. No live action occurred.",
      };
    case CAPABILITY_APPLY_ERROR_CODES.LIVE_EXECUTION_DISABLED:
      return {
        title: "Live execution disabled",
        detail:
          "Non-internal_safe steps are skipped while capability.apply.live is OFF. The plan recorded intent only — no live action occurred.",
      };
    case CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT:
      return {
        title: "Plan state changed",
        detail:
          "Someone or something else modified this plan since you loaded it. Refresh and retry. No live action occurred.",
      };
    case CAPABILITY_APPLY_ERROR_CODES.SECRET_SHAPED_IDENTIFIER:
      return {
        title: "Secret-shaped identifier rejected",
        detail:
          "A field looks like a raw secret value rather than a named reference. Replace it with a named secret reference. No live action occurred.",
      };
    default:
      return { title: "Request failed", detail: `${fallback} No live action occurred.` };
  }
}

function asApiError(err: unknown): { code: string | null; message: string } {
  if (err instanceof CapabilityApplyApiError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: null, message: err.message };
  return { code: null, message: String(err) };
}

// ── Atom UI primitives ────────────────────────────────────────────────────────

function PlanStateChip({ state }: { state: CapabilityApplyPlanState }) {
  const cls = PLAN_STATE_CLASS[state] ?? "bg-gray-100 text-gray-800 border-gray-300";
  const label = PLAN_STATE_LABEL[state] ?? state;
  return (
    <span
      role="status"
      aria-label={`Plan state: ${label}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      <span aria-hidden="true" className="text-[10px] uppercase tracking-wide opacity-70">
        state
      </span>
      <span>{label}</span>
    </span>
  );
}

function ApprovalStatusChip({ status }: { status: ApprovalStatus }) {
  const map: Record<ApprovalStatus, { label: string; cls: string }> = {
    pending: { label: "Pending reviewer", cls: "bg-blue-50 text-blue-900 border-blue-200" },
    revision_requested: { label: "Revision requested", cls: "bg-amber-50 text-amber-900 border-amber-200" },
    approved: { label: "Approved", cls: "bg-emerald-50 text-emerald-900 border-emerald-200" },
    rejected: { label: "Rejected", cls: "bg-red-50 text-red-900 border-red-200" },
    cancelled: { label: "Cancelled", cls: "bg-gray-100 text-gray-700 border-gray-300" },
  };
  const { label, cls } = map[status];
  return (
    <span
      aria-label={`Approval status: ${label}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function RiskChip({ riskClass }: { riskClass: string }) {
  const cls = RISK_CLASS_STYLE[riskClass] ?? "bg-gray-50 text-gray-800 border-gray-200";
  return (
    <span
      aria-label={`Risk class: ${riskClass}`}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {riskClass.replace(/_/g, " ")}
    </span>
  );
}

function StepRow({ step }: { step: CapabilityApplyStep }) {
  return (
    <li className="rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{step.target.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span aria-label="Step kind" className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {step.kind.replace(/_/g, " ")}
            </span>
            {step.target.catalogId && (
              <>
                {" · "}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{step.target.catalogId}</code>
              </>
            )}
            {step.target.transport && (
              <>
                {" · "}
                <span className="rounded bg-muted px-1 py-0.5 text-[10px]">{step.target.transport}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RiskChip riskClass={step.riskClass} />
          <span
            aria-label={`Step state: ${step.state}`}
            className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
          >
            {step.state}
          </span>
        </div>
      </div>
      {step.target.namedSecretRefs.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Named secret refs: {step.target.namedSecretRefs.join(", ")}.{" "}
          <span className="text-amber-700 dark:text-amber-300">
            Values never leave the secrets store — only references are tracked.
          </span>
        </p>
      )}
    </li>
  );
}

// ── Events timeline ───────────────────────────────────────────────────────────

const SERVER_OWNED_EVENT_KINDS = new Set([
  "capability_apply_plan_created",
  "capability_apply_approval_requested",
  "capability_apply_execute_started",
  "capability_apply_step_started",
  "capability_apply_step_completed",
  "capability_apply_step_skipped",
  "capability_apply_step_failed",
  "capability_apply_plan_completed",
  "capability_apply_plan_partially_applied",
  "capability_apply_plan_cancelled",
]);

function formatEventKind(kind: string): string {
  return kind.replace(/^capability_apply_/, "").replace(/_/g, " ");
}

function EventsTimeline({ events }: { events: CapabilityApplyEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        No events yet for this plan.
      </p>
    );
  }
  return (
    <ol
      aria-label="Apply plan events timeline"
      className="space-y-1 rounded-md border border-border bg-background/60 p-2"
    >
      {events.map((event) => {
        const code =
          typeof event.payload?.code === "string" ? (event.payload.code as string) : null;
        const isServerOwned = SERVER_OWNED_EVENT_KINDS.has(event.kind);
        return (
          <li
            key={event.id}
            className="flex flex-wrap items-baseline justify-between gap-2 rounded px-2 py-1 text-xs"
          >
            <div className="flex items-baseline gap-2">
              <span
                aria-label={isServerOwned ? "Server-owned event" : "Client-observed event"}
                className={
                  isServerOwned
                    ? "rounded border border-emerald-300 bg-emerald-50 px-1 text-[9px] uppercase tracking-wide text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
                    : "rounded border border-amber-300 bg-amber-50 px-1 text-[9px] uppercase tracking-wide text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                }
              >
                {isServerOwned ? "server" : "observed"}
              </span>
              <span className="font-mono text-[11px]">{formatEventKind(event.kind)}</span>
              {code && (
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  code: {code}
                </span>
              )}
            </div>
            <time
              dateTime={event.createdAt}
              className="font-mono text-[10px] text-muted-foreground"
            >
              {event.createdAt}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

// ── Live-OFF banner ───────────────────────────────────────────────────────────

function LiveDisabledBanner() {
  return (
    <div
      role="note"
      aria-label="Live execution disabled"
      className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
    >
      Live execution disabled. No MCP server, tool, or skill is installed, connected, invoked, or
      materialized by this panel. Approved plans record intent only.
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function CapabilityApplyPanel({
  companyId,
  agentId,
  effectiveDelta,
  currentPlanId,
  onPlanCreated,
}: CapabilityApplyPanelProps) {
  const queryClient = useQueryClient();
  const [localPlanId, setLocalPlanId] = useState<string | null>(currentPlanId ?? null);
  const planId = localPlanId;

  // Keep the local plan id in sync if the parent passes a new one.
  const prevCurrentPlanId = useRef<string | null | undefined>(currentPlanId);
  useEffect(() => {
    if (prevCurrentPlanId.current !== currentPlanId) {
      prevCurrentPlanId.current = currentPlanId;
      if (currentPlanId !== undefined) setLocalPlanId(currentPlanId);
    }
  }, [currentPlanId]);

  // ── Queries ────────────────────────────────────────────────────────────────

  const planQueryKey = ["capability-apply", companyId, agentId, "plan", planId] as const;
  const planQuery = useQuery<CapabilityApplyPlanSummary>({
    queryKey: planQueryKey,
    queryFn: () => {
      if (!planId) throw new Error("planId required");
      return capabilityApplyApi.getPlan(companyId, agentId, planId);
    },
    enabled: !!planId,
    // Refetch automatically while executing so the UI follows server-side
    // step progression without manual reload.
    refetchInterval: (query) => {
      const data = query.state.data as CapabilityApplyPlanSummary | undefined;
      return data?.state === "executing" ? 1500 : false;
    },
  });

  const plan = planQuery.data;

  const eventsQueryKey = ["capability-apply", companyId, agentId, "events", planId] as const;
  const eventsQuery = useQuery<CapabilityApplyEvent[]>({
    queryKey: eventsQueryKey,
    queryFn: () => {
      if (!planId) throw new Error("planId required");
      return capabilityApplyApi.listEvents(companyId, agentId, planId);
    },
    enabled: !!planId,
    refetchInterval: (query) => {
      const data = planQuery.data;
      return data?.state === "executing" ? 1500 : false;
    },
  });

  const approvalQueryKey = ["capability-apply", "approval", plan?.approvalId ?? null] as const;
  const approvalQuery = useQuery({
    queryKey: approvalQueryKey,
    queryFn: () => approvalsApi.get(plan!.approvalId!),
    enabled: Boolean(plan?.approvalId),
    refetchInterval: (query) => {
      // While we're waiting for an external reviewer, poll periodically.
      const data = query.state.data as { status: ApprovalStatus } | undefined;
      if (!data) return false;
      return data.status === "pending" || data.status === "revision_requested" ? 3000 : false;
    },
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const [pendingActionError, setPendingActionError] = useState<{ code: string | null; message: string } | null>(null);
  const [requestedApprovalPayload, setRequestedApprovalPayload] = useState<CapabilityApplyApprovalPayload | null>(null);

  const createPlanMutation = useMutation({
    mutationFn: () => {
      if (!effectiveDelta) throw new Error("No effective delta to plan");
      return capabilityApplyApi.createPlan(companyId, agentId, { effectiveDelta });
    },
    onSuccess: async (created) => {
      setLocalPlanId(created.id);
      setPendingActionError(null);
      onPlanCreated?.(created);
      // Pre-seed cache so the next render shows the plan immediately.
      queryClient.setQueryData(["capability-apply", companyId, agentId, "plan", created.id], created);
      await queryClient.invalidateQueries({ queryKey: ["capability-apply", companyId, agentId] });
    },
    onError: (err) => setPendingActionError(asApiError(err)),
  });

  const requestApprovalMutation = useMutation({
    mutationFn: () => {
      if (!plan) throw new Error("plan required");
      return capabilityApplyApi.requestApproval(companyId, agentId, plan.id, plan.optimisticVersion);
    },
    onSuccess: async (result) => {
      setRequestedApprovalPayload(result.approvalPayload);
      setPendingActionError(null);
      queryClient.setQueryData(planQueryKey, result.plan);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: planQueryKey }),
        queryClient.invalidateQueries({ queryKey: eventsQueryKey }),
      ]);
    },
    onError: (err) => setPendingActionError(asApiError(err)),
  });

  const executeMutation = useMutation({
    mutationFn: () => {
      if (!plan) throw new Error("plan required");
      return capabilityApplyApi.execute(companyId, agentId, plan.id, plan.optimisticVersion);
    },
    onSuccess: async (next) => {
      setPendingActionError(null);
      queryClient.setQueryData(planQueryKey, next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: planQueryKey }),
        queryClient.invalidateQueries({ queryKey: eventsQueryKey }),
        queryClient.invalidateQueries({ queryKey: approvalQueryKey }),
      ]);
    },
    onError: (err) => setPendingActionError(asApiError(err)),
  });

  const cancelMutation = useMutation({
    mutationFn: () => {
      if (!plan) throw new Error("plan required");
      return capabilityApplyApi.cancel(companyId, agentId, plan.id, plan.optimisticVersion);
    },
    onSuccess: async (next) => {
      setPendingActionError(null);
      queryClient.setQueryData(planQueryKey, next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: planQueryKey }),
        queryClient.invalidateQueries({ queryKey: eventsQueryKey }),
      ]);
    },
    onError: (err) => setPendingActionError(asApiError(err)),
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const approvalStatus = approvalQuery.data?.status ?? null;
  const isApprovalApproved = approvalStatus === "approved";
  const isApprovalRejected = approvalStatus === "rejected";
  const isApprovalCancelled = approvalStatus === "cancelled";
  const isApprovalRevisionRequested = approvalStatus === "revision_requested";

  const isNonExecutable = useMemo(() => {
    if (!plan) return false;
    return plan.steps.some((s) => s.riskClass !== "internal_safe");
  }, [plan]);

  // Execute is allowed only when the plan state is approval_requested|approved
  // AND the underlying approval is approved. The server is the authority — UI
  // gating is the *first* check; the request still carries If-Match so the
  // server retains final say.
  const canRequestExecute =
    !!plan &&
    (plan.state === "approval_requested" || plan.state === "approved") &&
    isApprovalApproved &&
    !executeMutation.isPending &&
    !cancelMutation.isPending;

  const canRequestApproval =
    !!plan && plan.state === "pending" && plan.steps.length > 0 && !requestApprovalMutation.isPending;

  const canCancel =
    !!plan &&
    (plan.state === "pending" || plan.state === "approval_requested" || plan.state === "approved") &&
    !cancelMutation.isPending;

  // ── Empty state ────────────────────────────────────────────────────────────

  if (!planId) {
    const stepCount =
      (effectiveDelta?.mcpServerChanges?.length ?? 0) +
      (effectiveDelta?.skillRefChanges?.length ?? 0) +
      (effectiveDelta?.toolRefChanges?.length ?? 0);
    return (
      <section
        aria-labelledby="capability-apply-panel-title"
        className="space-y-3 rounded-lg border border-border bg-card p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 id="capability-apply-panel-title" className="text-sm font-semibold">
              Apply panel
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Build a server-locked apply plan from the current dry-run preview. Approval and
              execution are gated separately; no MCP/tool/skill is installed, connected, or
              invoked from this panel.
            </p>
          </div>
          <PlanStateChip state="pending" />
        </div>
        <LiveDisabledBanner />
        {effectiveDelta ? (
          <div className="rounded-md border border-border bg-background/60 p-3">
            <p className="text-xs text-muted-foreground">
              The current preview contains <strong>{stepCount}</strong> proposed change
              {stepCount === 1 ? "" : "s"}. Building a plan locks the dry-run hash and prepares
              an approval request — it does not execute anything.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => createPlanMutation.mutate()}
                disabled={stepCount === 0 || createPlanMutation.isPending}
                className="min-h-[32px] rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
                aria-label="Build apply plan from current preview"
              >
                {createPlanMutation.isPending ? "Building plan…" : "Build apply plan"}
              </button>
              {stepCount === 0 && (
                <span className="text-[11px] text-muted-foreground">
                  No-op preview — nothing to plan.
                </span>
              )}
            </div>
            {pendingActionError && (
              <ErrorBlock title="Build plan failed" error={pendingActionError} />
            )}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            Run a dry-run preview first. The Apply panel is enabled once a preview has produced an
            effective delta.
          </p>
        )}
      </section>
    );
  }

  // ── Loading + load-error states ────────────────────────────────────────────

  if (planQuery.isLoading) {
    return (
      <section className="rounded-lg border border-border bg-card p-4" role="status">
        <p className="text-sm text-muted-foreground">Loading apply plan… No live action occurred.</p>
      </section>
    );
  }

  if (planQuery.error || !plan) {
    const err = asApiError(planQuery.error);
    return (
      <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-4" role="alert">
        <p className="text-sm font-medium text-destructive">
          Failed to load apply plan. No live action occurred.
        </p>
        <p className="mt-1 text-xs text-destructive/80">{err.message}</p>
      </section>
    );
  }

  const stepCount = plan.steps.length;
  const internalSafeStepCount = plan.steps.filter((s) => s.riskClass === "internal_safe").length;
  const skippedStepCount = plan.steps.filter((s) => s.state === "skipped").length;
  const failedStepCount = plan.steps.filter((s) => s.state === "failed").length;
  const completedStepCount = plan.steps.filter((s) => s.state === "completed").length;

  return (
    <section
      aria-labelledby="capability-apply-panel-title"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="capability-apply-panel-title" className="text-sm font-semibold">
            Apply panel
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Server-owned state machine for this plan. Approval payload is built by the server from
            the locked dry-run hash; no client-supplied approval payload is trusted.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PlanStateChip state={plan.state} />
          {approvalStatus && <ApprovalStatusChip status={approvalStatus} />}
        </div>
      </header>

      <LiveDisabledBanner />

      {/* Plan facts */}
      <dl className="grid gap-2 rounded-md border border-border bg-background/60 p-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Dry-run hash</dt>
          <dd>
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{plan.dryRunHash}</code>
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Optimistic version</dt>
          <dd>{plan.optimisticVersion}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Approval</dt>
          <dd>
            {plan.approvalId ? (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{plan.approvalId}</code>
            ) : (
              <span className="text-muted-foreground">none yet</span>
            )}
          </dd>
        </div>
      </dl>

      {/* Step summary */}
      <div className="grid gap-2 sm:grid-cols-4">
        <SummaryStat label="Steps" value={stepCount} />
        <SummaryStat label="Internal-safe" value={internalSafeStepCount} />
        <SummaryStat label="Completed" value={completedStepCount} />
        <SummaryStat label="Skipped/failed" value={skippedStepCount + failedStepCount} />
      </div>

      {/* State-specific banners */}
      {plan.state === "approval_requested" && approvalStatus === "pending" && (
        <StatusBanner
          tone="info"
          title="Awaiting approval"
          body="A reviewer must accept this approval before any execution can proceed. No live action will occur even after acceptance — only internal_safe steps run while live execution is OFF."
        />
      )}
      {plan.state === "approval_requested" && isApprovalRevisionRequested && (
        <StatusBanner
          tone="warning"
          title="Revision requested"
          body="The reviewer asked for revisions. Build a fresh plan from a re-run preview to resubmit. No live action occurred."
        />
      )}
      {plan.state === "approval_requested" && isApprovalRejected && (
        <StatusBanner
          tone="error"
          title="Approval rejected"
          body="The approval was rejected. Cancel this plan and reopen the desired-config draft. No live action occurred."
        />
      )}
      {plan.state === "approval_requested" && isApprovalCancelled && (
        <StatusBanner
          tone="warning"
          title="Approval cancelled or expired"
          body="The approval was cancelled or expired without acceptance. This is distinct from a still-pending approval — the single-use approval cannot be reused. Build a fresh plan to retry. No live action occurred."
        />
      )}
      {plan.state === "approval_requested" && isApprovalApproved && (
        <StatusBanner
          tone="success"
          title="Approved — ready to execute"
          body={
            isNonExecutable
              ? "Internal_safe steps will execute. Non-internal_safe steps are skipped while capability.apply.live is OFF — they record intent only."
              : "All steps are internal_safe. Execution records intent; no live MCP/tool/skill is installed, connected, or invoked."
          }
        />
      )}
      {plan.state === "executing" && (
        <StatusBanner
          tone="info"
          title="Executing"
          body="Server is walking the plan's state machine. Progress updates automatically. No live MCP/tool/skill action occurs while live execution is OFF."
        />
      )}
      {plan.state === "applied" && (
        <StatusBanner
          tone="success"
          title="Applied"
          body="All steps recorded completed. No live MCP/tool/skill was installed, connected, or invoked — the approval recorded intent only."
        />
      )}
      {plan.state === "partially_applied" && (
        <StatusBanner
          tone="warning"
          title="Partially applied"
          body={`${skippedStepCount} step(s) skipped, ${failedStepCount} step(s) failed. Non-internal_safe steps were skipped while capability.apply.live is OFF. No live MCP/tool/skill was installed, connected, or invoked.`}
        />
      )}
      {plan.state === "declined" && (
        <StatusBanner
          tone="error"
          title="Declined"
          body="This plan was declined and is now in a terminal state. Build a fresh plan to try again. No live action occurred."
        />
      )}
      {plan.state === "expired" && (
        <StatusBanner
          tone="warning"
          title="Expired"
          body="This plan expired without being executed. Single-use approvals cannot be reused. Build a fresh plan from a re-run preview. No live action occurred."
        />
      )}
      {plan.state === "cancelled" && (
        <StatusBanner
          tone="warning"
          title="Cancelled"
          body="This plan was cancelled and cannot be executed. No live action occurred."
        />
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        {canRequestApproval && (
          <button
            type="button"
            onClick={() => requestApprovalMutation.mutate()}
            disabled={requestApprovalMutation.isPending}
            className="min-h-[32px] rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
            aria-label="Request approval for this apply plan"
          >
            {requestApprovalMutation.isPending ? "Requesting approval…" : "Request approval"}
          </button>
        )}
        {plan.state === "approval_requested" && !isApprovalApproved && (
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-label="Execute (disabled — approval not yet accepted)"
            title="Execute is disabled until an approver accepts the request"
            className="min-h-[32px] cursor-not-allowed rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground"
          >
            Execute (awaiting approval)
          </button>
        )}
        {canRequestExecute && (
          <button
            type="button"
            onClick={() => executeMutation.mutate()}
            disabled={executeMutation.isPending}
            className="min-h-[32px] rounded-md bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            aria-label="Execute approved apply plan (internal_safe only)"
          >
            {executeMutation.isPending ? "Executing…" : "Execute approved plan"}
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
            className="min-h-[32px] rounded-md border border-border bg-background px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            aria-label="Cancel this apply plan"
          >
            {cancelMutation.isPending ? "Cancelling…" : "Cancel plan"}
          </button>
        )}
      </div>

      {pendingActionError && (
        <ErrorBlock
          title={
            executeMutation.isError
              ? "Execute failed"
              : requestApprovalMutation.isError
                ? "Request approval failed"
                : cancelMutation.isError
                  ? "Cancel failed"
                  : "Request failed"
          }
          error={pendingActionError}
        />
      )}

      {/* Sanitized scope summary surfaced from the most recent request-approval response. */}
      {requestedApprovalPayload && (
        <details className="rounded-md border border-border bg-background/60 p-3 text-xs">
          <summary className="cursor-pointer font-medium">
            Sanitized approval scope (server-built)
          </summary>
          <div className="mt-2 space-y-2">
            <p>
              Plan revision <code className="rounded bg-muted px-1 py-0.5 font-mono">{requestedApprovalPayload.planRevisionId}</code>
              {" — "}
              dry-run hash{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{requestedApprovalPayload.dryRunHash}</code>.
            </p>
            <p>
              Agent <strong>{requestedApprovalPayload.scopeSummary.agentLabel}</strong> — total{" "}
              <strong>{requestedApprovalPayload.scopeSummary.totalSteps}</strong> step(s),{" "}
              <strong>{requestedApprovalPayload.scopeSummary.totalNamedSecretRefs}</strong> named
              secret ref(s). Live execution flag: <code>{requestedApprovalPayload.liveExecutionFlagState}</code>.
            </p>
            <p className="text-muted-foreground">
              Secret values are never present in the approval payload — only named references.
            </p>
          </div>
        </details>
      )}

      {/* Steps */}
      {plan.steps.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No steps in this plan (no-op delta).
        </p>
      ) : (
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Steps ({plan.steps.length})
          </h4>
          <ul className="space-y-2">
            {plan.steps.map((step) => (
              <StepRow key={step.stepId} step={step} />
            ))}
          </ul>
        </div>
      )}

      {/* Events */}
      <div>
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Audit timeline
          </h4>
          {eventsQuery.isFetching && (
            <span className="text-[10px] text-muted-foreground" role="status">
              refreshing…
            </span>
          )}
        </div>
        {eventsQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading events…</p>
        ) : eventsQuery.error ? (
          <p className="text-xs text-destructive">Failed to load events.</p>
        ) : (
          <EventsTimeline events={eventsQuery.data ?? []} />
        )}
      </div>
    </section>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-2 text-xs">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold">{value}</p>
    </div>
  );
}

function StatusBanner({
  tone,
  title,
  body,
}: {
  tone: "info" | "success" | "warning" | "error";
  title: string;
  body: string;
}) {
  const toneClass: Record<typeof tone, string> = {
    info: "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-400/40 dark:bg-blue-950/30 dark:text-blue-100",
    success:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-950/30 dark:text-emerald-100",
    warning:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100",
    error: "border-red-300 bg-red-50 text-red-900 dark:border-red-400/40 dark:bg-red-950/30 dark:text-red-100",
  };
  const role = tone === "error" ? "alert" : "status";
  return (
    <div role={role} className={`rounded-md border px-3 py-2 text-xs ${toneClass[tone]}`}>
      <p className="font-medium">{title}</p>
      <p className="mt-0.5">{body}</p>
    </div>
  );
}

function ErrorBlock({
  title,
  error,
}: {
  title: string;
  error: { code: string | null; message: string };
}) {
  const copy = errorCopy(error.code, error.message);
  return (
    <div
      role="alert"
      className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
    >
      <p className="font-medium">{title}: {copy.title}</p>
      <p className="mt-0.5 text-destructive/80">{copy.detail}</p>
      {error.code && (
        <p className="mt-1 font-mono text-[10px] text-destructive/70">code: {error.code}</p>
      )}
    </div>
  );
}
