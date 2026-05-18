/**
 * LET-357 — Read-only Capability Apply panel (live flag OFF, no execute button).
 * Shows current plan state, redacted dry-run diff, and approval status.
 * Permanent banner: "Live execution disabled."
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  CapabilityApplyPlanSummary,
  CapabilityApplyStep,
} from "@paperclipai/shared";

export interface CapabilityApplyPanelProps {
  companyId: string;
  agentId: string;
  /** The effectiveDelta from the LET-140-F apply-preview output */
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
  currentPlanId?: string | null;
  onPlanCreated?: (plan: CapabilityApplyPlanSummary) => void;
}

function riskBadgeStyle(riskClass: string): string {
  switch (riskClass) {
    case "governance_critical":
    case "destructive_or_spend":
      return "bg-red-100 text-red-800";
    case "external_write":
      return "bg-amber-100 text-amber-800";
    case "external_readonly":
      return "bg-yellow-100 text-yellow-800";
    default:
      return "bg-green-100 text-green-800";
  }
}

function StateChip({ state }: { state: string }) {
  const styles: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    approval_requested: "bg-blue-100 text-blue-800",
    approved: "bg-green-100 text-green-800",
    cancelled: "bg-gray-200 text-gray-500",
    declined: "bg-red-100 text-red-700",
    expired: "bg-gray-200 text-gray-500",
    executing: "bg-blue-200 text-blue-900",
    applied: "bg-green-200 text-green-900",
    partially_applied: "bg-amber-100 text-amber-800",
  };
  const cls = styles[state] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {state.replace(/_/g, " ")}
    </span>
  );
}

function StepRow({ step }: { step: CapabilityApplyStep }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-gray-100 bg-white p-3">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-800">{step.target.label}</span>
          {step.target.catalogId && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">{step.target.catalogId}</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
            {step.kind.replace(/_/g, " ")}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-xs ${riskBadgeStyle(step.riskClass)}`}>{step.riskClass}</span>
        </div>
        {step.secretSummary.length > 0 && (
          <p className="mt-1 text-xs text-amber-700">
            Named secrets: {step.secretSummary.join(", ")}
          </p>
        )}
      </div>
      <StateChip state={step.state} />
    </div>
  );
}

export function CapabilityApplyPanel({
  companyId,
  agentId,
  effectiveDelta,
  currentPlanId,
  onPlanCreated,
}: CapabilityApplyPanelProps) {
  const [localPlanId, setLocalPlanId] = useState<string | null>(currentPlanId ?? null);
  const planId = localPlanId;

  // Fetch the current plan if we have one
  const planQuery = useQuery<CapabilityApplyPlanSummary>({
    queryKey: ["capability-apply-plan", companyId, agentId, planId],
    queryFn: async () => {
      if (!planId) throw new Error("No plan ID");
      const res = await fetch(
        `/api/companies/${companyId}/agents/${agentId}/capability-apply/plans/${planId}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!planId,
  });

  const createPlanMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveDelta) throw new Error("No effective delta to plan");
      const res = await fetch(
        `/api/companies/${companyId}/agents/${agentId}/capability-apply/plans`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ effectiveDelta }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<CapabilityApplyPlanSummary>;
    },
    onSuccess: (plan) => {
      setLocalPlanId(plan.id);
      onPlanCreated?.(plan);
    },
  });

  const plan = planQuery.data;

  return (
    <div className="space-y-4">
      {/* Permanent live-execution-disabled banner — always visible, never removed in G.1 */}
      <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="text-sm font-medium text-amber-900">
          Live execution disabled. Approving this plan records intent; no MCP server, tool, or skill is actually
          installed, connected, or invoked.
        </p>
      </div>

      {/* Plan creation */}
      {!planId && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
          <p className="text-sm text-gray-600 mb-3">
            Build an apply plan from the current dry-run preview to begin the approval process.
          </p>
          <button
            type="button"
            disabled={!effectiveDelta || createPlanMutation.isPending}
            onClick={() => createPlanMutation.mutate()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {createPlanMutation.isPending ? "Building plan…" : "Build apply plan"}
          </button>
          {createPlanMutation.isError && (
            <p className="mt-2 text-sm text-red-600">{String(createPlanMutation.error)}</p>
          )}
        </div>
      )}

      {/* Plan details */}
      {planId && (
        <div className="rounded-md border border-gray-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800">Apply Plan</h3>
            {plan && <StateChip state={plan.state} />}
          </div>

          {planQuery.isLoading && (
            <p className="text-sm text-gray-500">Loading plan…</p>
          )}

          {plan && (
            <>
              <div className="space-y-1 text-xs text-gray-500">
                <div>
                  <span className="font-medium">Hash: </span>
                  <code className="font-mono">{plan.dryRunHash}</code>
                </div>
                <div>
                  <span className="font-medium">Version: </span>
                  {plan.optimisticVersion}
                </div>
                {plan.approvalId && (
                  <div>
                    <span className="font-medium">Approval: </span>
                    <code className="font-mono text-blue-700">{plan.approvalId}</code>
                  </div>
                )}
              </div>

              {plan.steps.length === 0 ? (
                <p className="text-sm text-gray-500 italic">No steps in this plan (no-op delta).</p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-gray-600 uppercase tracking-wide">
                    Steps ({plan.steps.length})
                  </p>
                  {plan.steps.map((step) => (
                    <StepRow key={step.stepId} step={step} />
                  ))}
                </div>
              )}

              {/* Approval status note */}
              {plan.state === "approval_requested" && (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                  Approval pending. Once accepted, this plan will be locked. No live action is performed in this
                  milestone.
                </div>
              )}

              {/* No execute button — that's LET-140-G.2 */}
            </>
          )}
        </div>
      )}
    </div>
  );
}
