import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ROUTE_ESCALATION_REASONS,
  TASK_AFFECTED_LAYERS,
  TASK_CLASSES,
  TASK_RISK_FLAGS,
  type ExecutionProfile,
  type RouteDecisionParticipant,
  type RouteEscalationReason,
  type TaskAffectedLayer,
  type TaskClass,
  type TaskFactsInput,
  type TaskRiskFlag,
} from "@paperclipai/shared";
import { ApiError } from "../../api/client";
import { routingApi } from "../../api/routing";
import { queryKeys } from "../../lib/queryKeys";
import { formatDateTime } from "../../lib/utils";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { PropertyChip, PropertyRow, PropertySection } from "./primitives";

/**
 * Routing failures must stay explicit on the operator surface: 409 revision
 * conflicts name the current revision, 422 invariant violations surface their
 * `details.code` verbatim, and route states are never rewritten into generic
 * failure text.
 */
export function describeRoutingActionError(error: unknown): string {
  if (error instanceof ApiError) {
    const details = (error.body as { details?: { code?: string; currentRevision?: number } } | null)?.details;
    if (error.status === 409 && details?.code === "route_revision_conflict") {
      return `Route changed to revision ${details.currentRevision}; reload before retrying.`;
    }
    if (error.status === 409 && details?.code === "route_decision_superseded") {
      return "Route decision superseded during dispatch (route_decision_superseded); reload before retrying.";
    }
    if (error.status === 422 && details?.code) return details.code;
    return error.message;
  }
  return error instanceof Error ? error.message : "Request failed";
}

const selectClass =
  "max-w-full min-w-0 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)";

function ParticipantRow({
  label,
  participant,
}: {
  label: string;
  participant: RouteDecisionParticipant | null;
}) {
  if (!participant) return null;
  return (
    <PropertyRow label={label}>
      <PropertyChip>{participant.providerFamily}</PropertyChip>
      <span className="min-w-0 truncate text-xs" title={`${participant.model} · ${participant.effort}`}>
        {participant.model} · {participant.effort}
      </span>
    </PropertyRow>
  );
}

const EMPTY_FACTS: TaskFactsInput = {
  taskClass: "feature_standard",
  riskFlags: [],
  affectedLayers: [],
  reproductionKnown: false,
  acceptanceDefined: false,
  architecturalDecisionOpen: false,
  consequential: false,
};

type PanelKind = "route" | "escalate" | "rescue" | "override" | null;

export function RoutingSection({
  issueId,
  companyId,
  streamlined,
}: {
  issueId: string;
  companyId: string | null;
  streamlined?: boolean;
}) {
  const queryClient = useQueryClient();

  const routingQuery = useQuery({
    queryKey: queryKeys.routing.issue(issueId),
    queryFn: () => routingApi.getIssueRouting(issueId),
  });
  const profilesQuery = useQuery({
    queryKey: companyId ? queryKeys.routing.profiles(companyId) : ["routing", "__disabled__", "profiles"],
    queryFn: () => routingApi.listProfiles(companyId!),
    enabled: !!companyId,
  });

  const [panel, setPanel] = useState<PanelKind>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  /**
   * Revision snapshot captured when the override panel opens. An override must
   * assert the revision the operator was looking at, not whatever a background
   * refetch delivered since — a stale token correctly 409s instead of silently
   * overriding a route the operator never saw.
   */
  const [overrideExpectedRevision, setOverrideExpectedRevision] = useState<number | null>(null);
  const [facts, setFacts] = useState<TaskFactsInput>(EMPTY_FACTS);
  const [escalationReason, setEscalationReason] = useState<RouteEscalationReason>(
    ROUTE_ESCALATION_REASONS[0],
  );
  const [rescueReason, setRescueReason] = useState<RouteEscalationReason>(ROUTE_ESCALATION_REASONS[0]);
  const [override, setOverride] = useState({
    workerProfileId: "",
    reviewerProfileId: "",
    advisorProfileId: "",
    note: "",
  });

  const routing = routingQuery.data;
  const current = routing?.current ?? null;
  const profiles = profilesQuery.data ?? [];
  const profileById = (id: string): ExecutionProfile | undefined =>
    profiles.find((profile) => profile.id === id);

  // A dispatch/review outcome can park or unpark the parent issue, so the
  // issue detail refreshes alongside the routing snapshot.
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.routing.issue(issueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) }),
    ]);

  const runAction = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setActionError(null);
      setActionNotice(null);
      setPanel(null);
      await invalidate();
    },
    onError: (error) => setActionError(describeRoutingActionError(error)),
  });

  const dispatchMutation = useMutation({
    mutationFn: () => routingApi.dispatch(issueId),
    onSuccess: async (result) => {
      setActionError(null);
      // HTTP 200 does not mean dispatched; refusals carry their reason in the body.
      setActionNotice(
        result.dispatched
          ? null
          : result.reason === "parked"
            ? "Dispatch parked: the scheduler bound the run to a durable carrier; the slot stays held."
            : `Dispatch refused: ${result.reason}`,
      );
      await invalidate();
    },
    onError: (error) => setActionError(describeRoutingActionError(error)),
  });

  const reviewMutation = useMutation({
    mutationFn: () => routingApi.requestReview(issueId),
    onSuccess: async (result) => {
      setActionError(null);
      if (result.state === "reviewer-unavailable") {
        setActionNotice(`Review request blocked: reviewer-unavailable`);
      } else if (result.state === "reviewer-capacity-exhausted") {
        setActionNotice(`Review request deferred: reviewer-capacity-exhausted`);
      } else if (result.state === "not-required") {
        setActionNotice("Review not required for this route.");
      } else {
        setActionNotice(null);
      }
      await invalidate();
    },
    onError: (error) => setActionError(describeRoutingActionError(error)),
  });

  const rescueMutation = useMutation({
    mutationFn: () => routingApi.rescue(issueId, { reason: rescueReason }),
    onSuccess: async (result) => {
      setActionError(null);
      if (result.dispatchError) {
        // The rescue revision WAS recorded; only its dispatch was refused.
        setActionNotice(
          `Rescue recorded as revision ${result.decision.revision}; dispatch refused: ${
            result.dispatchError.code ?? result.dispatchError.message
          }`,
        );
      } else if (result.dispatch && !result.dispatch.dispatched) {
        setActionNotice(result.dispatch.reason === "parked" ? "Rescue parked on a durable carrier; the slot stays held." : `Dispatch refused: ${result.dispatch.reason}`);
      } else if (!result.dispatch && result.decision.state !== "routed") {
        // The rescue escalation itself refused; the state row shows the exact state.
        setActionNotice(`Rescue not dispatched: ${result.decision.state}`);
      } else {
        setActionNotice(null);
      }
      setPanel(null);
      await invalidate();
    },
    onError: (error) => setActionError(describeRoutingActionError(error)),
  });

  const actionPending =
    runAction.isPending || dispatchMutation.isPending || reviewMutation.isPending || rescueMutation.isPending;
  const routingLoaded = routingQuery.isSuccess;
  const profilesLoaded = profilesQuery.isSuccess;

  const toggleListValue = <T,>(values: T[], value: T): T[] =>
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value];

  if (routingQuery.isLoading) {
    return (
      <PropertySection title="Routing" streamlined={streamlined}>
        <div className="py-1 text-xs text-muted-foreground">Loading routing...</div>
      </PropertySection>
    );
  }

  return (
    <PropertySection title="Routing" streamlined={streamlined}>
      {routingQuery.error ? (
        <div role="alert" className="flex items-center gap-2 py-1 text-xs text-destructive">
          <span className="min-w-0">Failed to load routing: {describeRoutingActionError(routingQuery.error)}</span>
          <Button size="sm" variant="outline" onClick={() => routingQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {profilesQuery.error ? (
        <div role="alert" className="flex items-center gap-2 py-1 text-xs text-destructive">
          <span className="min-w-0">
            Failed to load execution profiles: {describeRoutingActionError(profilesQuery.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => profilesQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {current ? (
        <>
          <PropertyRow label="State">
            {/* The exact RouteDecisionState string, verbatim — never generic failure text. */}
            <PropertyChip>{current.state}</PropertyChip>
          </PropertyRow>
          <PropertyRow label="Task class">
            <span className="text-xs">{current.effectiveTaskClass}</span>
          </PropertyRow>
          <PropertyRow label="Policy">
            <span className="min-w-0 truncate text-xs" title={current.policyVersion}>
              {current.policyVersion}
            </span>
          </PropertyRow>
          <PropertyRow label="Revision">
            <span className="text-xs">{current.revision} · {current.revisionKind}</span>
          </PropertyRow>
          <ParticipantRow label="Worker" participant={current.worker} />
          <ParticipantRow label="Advisor" participant={current.advisor} />
          <ParticipantRow label="Reviewer" participant={current.reviewer} />
          <ParticipantRow label="Rev. fallback" participant={current.reviewerFallback} />
          <ParticipantRow label="Rescue" participant={current.rescue} />
          <PropertyRow label="Cross-family">
            <span className="text-xs">{current.requireCrossFamilyReview ? "Required" : "Not required"}</span>
          </PropertyRow>
          {current.reasonCodes.length > 0 ? (
            <PropertyRow label="Reasons" wrap>
              <div className="flex flex-wrap gap-1">
                {current.reasonCodes.map((reason) => (
                  <PropertyChip key={reason}>{reason}</PropertyChip>
                ))}
              </div>
            </PropertyRow>
          ) : null}
          {current.escalationReason ? (
            <PropertyRow label="Escalation">
              <PropertyChip>{current.escalationReason}</PropertyChip>
            </PropertyRow>
          ) : null}
        </>
      ) : routingLoaded ? (
        <PropertyRow label="State">
          <span className="text-xs text-muted-foreground">Not routed</span>
        </PropertyRow>
      ) : null}

      {routing?.activeClaims.length ? (
        <PropertyRow label="Claims" wrap>
          <div className="flex flex-col items-start gap-1">
            {routing.activeClaims.map((claim) => {
              const profile = profileById(claim.profileId);
              return (
                <span key={claim.id} className="flex items-center gap-1.5 text-xs">
                  <PropertyChip>{claim.role}</PropertyChip>
                  {claim.runId && profile ? (
                    <Link
                      to={`/agents/${profile.agentId}/runs/${claim.runId}`}
                      className="text-muted-foreground underline-offset-2 hover:underline"
                    >
                      View run
                    </Link>
                  ) : null}
                </span>
              );
            })}
          </div>
        </PropertyRow>
      ) : null}

      {routing?.reviewIssueId ? (
        <PropertyRow label="Review task">
          <Link
            to={`/issues/${routing.reviewIssueId}`}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Open review task
          </Link>
        </PropertyRow>
      ) : null}

      {routing && routing.history.length > 0 ? (
        <PropertyRow label="History" wrap>
          <div className="flex flex-col items-start gap-0.5">
            {routing.history.map((decision) => (
              <span key={decision.id} className="text-xs text-muted-foreground">
                r{decision.revision} · {decision.revisionKind} · {decision.state} · {formatDateTime(decision.createdAt)}
              </span>
            ))}
          </div>
        </PropertyRow>
      ) : null}

      {actionError ? (
        <div role="alert" className="py-1 text-xs text-destructive">{actionError}</div>
      ) : null}
      {actionNotice ? (
        <div role="status" className="py-1 text-xs text-muted-foreground">{actionNotice}</div>
      ) : null}

      <div className="flex flex-wrap gap-1.5 py-1">
        <Button
          size="sm"
          variant="outline"
          disabled={!routingLoaded}
          onClick={() => setPanel(panel === "route" ? null : "route")}
        >
          Route
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={actionPending || !routingLoaded}
          onClick={() => dispatchMutation.mutate()}
        >
          Dispatch
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={actionPending || !routingLoaded}
          onClick={() => reviewMutation.mutate()}
        >
          Request review
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!routingLoaded}
          onClick={() => setPanel(panel === "escalate" ? null : "escalate")}
        >
          Escalate
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!routingLoaded}
          onClick={() => setPanel(panel === "rescue" ? null : "rescue")}
        >
          Rescue
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!routingLoaded || !profilesLoaded || !current}
          onClick={() => {
            if (panel === "override") {
              setPanel(null);
              setOverrideExpectedRevision(null);
            } else {
              setPanel("override");
              setOverrideExpectedRevision(current ? current.revision : null);
            }
          }}
        >
          Override
        </Button>
      </div>

      {panel === "route" ? (
        <div className="space-y-2 rounded-md border border-border p-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Task class
            <select
              aria-label="Routing task class"
              className={selectClass}
              value={facts.taskClass}
              onChange={(e) => setFacts({ ...facts, taskClass: e.target.value as TaskClass })}
            >
              {TASK_CLASSES.map((taskClass) => (
                <option key={taskClass} value={taskClass}>{taskClass}</option>
              ))}
            </select>
          </label>
          <fieldset className="text-xs text-muted-foreground">
            <legend>Risk flags</legend>
            <div className="flex flex-wrap gap-2">
              {TASK_RISK_FLAGS.map((flag) => (
                <label key={flag} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={facts.riskFlags.includes(flag)}
                    onChange={() =>
                      setFacts({ ...facts, riskFlags: toggleListValue<TaskRiskFlag>([...facts.riskFlags], flag) })}
                  />
                  {flag}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="text-xs text-muted-foreground">
            <legend>Affected layers</legend>
            <div className="flex flex-wrap gap-2">
              {TASK_AFFECTED_LAYERS.map((layer) => (
                <label key={layer} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={facts.affectedLayers.includes(layer)}
                    onChange={() =>
                      setFacts({
                        ...facts,
                        affectedLayers: toggleListValue<TaskAffectedLayer>([...facts.affectedLayers], layer),
                      })}
                  />
                  {layer}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {([
              ["reproductionKnown", "Reproduction known"],
              ["acceptanceDefined", "Acceptance defined"],
              ["architecturalDecisionOpen", "Architectural decision open"],
              ["consequential", "Consequential"],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={facts[key]}
                  onChange={() => setFacts({ ...facts, [key]: !facts[key] })}
                />
                {label}
              </label>
            ))}
          </div>
          <Button
            size="sm"
            disabled={runAction.isPending}
            onClick={() => runAction.mutate(() => routingApi.routeIssue(issueId, facts))}
          >
            Route task
          </Button>
        </div>
      ) : null}

      {panel === "escalate" || panel === "rescue" ? (
        <div className="flex min-w-0 flex-wrap items-end gap-2 rounded-md border border-border p-2">
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted-foreground">
            Reason
            <select
              aria-label={`${panel} reason`}
              className={selectClass}
              value={panel === "escalate" ? escalationReason : rescueReason}
              onChange={(e) => {
                const reason = e.target.value as RouteEscalationReason;
                if (panel === "escalate") setEscalationReason(reason);
                else setRescueReason(reason);
              }}
            >
              {ROUTE_ESCALATION_REASONS.map((reason) => (
                <option key={reason} value={reason}>{reason}</option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            className="shrink-0"
            disabled={actionPending}
            onClick={() => {
              if (panel === "escalate") {
                runAction.mutate(() => routingApi.escalate(issueId, { reason: escalationReason }));
              } else {
                rescueMutation.mutate();
              }
            }}
          >
            {panel === "escalate" ? "Escalate route" : "Rescue route"}
          </Button>
        </div>
      ) : null}

      {panel === "override" ? (
        <div className="space-y-2 rounded-md border border-border p-2">
          {([
            ["workerProfileId", "Worker profile"],
            ["reviewerProfileId", "Reviewer profile"],
            ["advisorProfileId", "Advisor profile"],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {label}
              <select
                aria-label={`Override ${label.toLowerCase()}`}
                className={selectClass}
                value={override[key]}
                onChange={(e) => setOverride({ ...override, [key]: e.target.value })}
              >
                <option value="">Keep current</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Note (required)
            <input
              aria-label="Override note"
              className={selectClass}
              value={override.note}
              onChange={(e) => setOverride({ ...override, note: e.target.value })}
            />
          </label>
          <Button
            size="sm"
            disabled={
              actionPending ||
              !profilesLoaded ||
              overrideExpectedRevision === null ||
              override.note.trim().length === 0
            }
            onClick={() =>
              runAction.mutate(() =>
                routingApi.override(issueId, {
                  expectedRevision: overrideExpectedRevision!,
                  ...(override.workerProfileId ? { workerProfileId: override.workerProfileId } : {}),
                  ...(override.reviewerProfileId ? { reviewerProfileId: override.reviewerProfileId } : {}),
                  ...(override.advisorProfileId ? { advisorProfileId: override.advisorProfileId } : {}),
                  note: override.note,
                }),
              )}
          >
            Apply override
          </Button>
        </div>
      ) : null}
    </PropertySection>
  );
}
