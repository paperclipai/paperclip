import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, MinusCircle, RotateCcw, XCircle } from "lucide-react";
import type { Approval, ApprovalStatus } from "@paperclipai/shared";
import { agentsApi } from "../../api/agents";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  GATE_LABEL,
  GATE_ORDER,
  gateDesignatedAgentId,
  isGateType,
  type GateType,
} from "../../lib/gates";

interface GateLedgerProps {
  issueId: string;
  companyId: string | null;
}

// Audit ledger of the dev-team gate decisions on a single issue: which gate,
// the verdict, the responsible agent, when it was decided, and the note. Reads
// the issue's gate_* approvals directly — decided rows carry status/decidedAt/
// decisionNote, pending rows show who still owes the decision.
export function GateLedger({ issueId, companyId }: GateLedgerProps) {
  const { data: approvals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId),
    queryFn: () => issuesApi.listApprovals(issueId),
    enabled: !!issueId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  const gates = (approvals ?? [])
    .filter((a) => isGateType(a.type))
    .sort((a, b) => GATE_ORDER[a.type as GateType] - GATE_ORDER[b.type as GateType]);

  if (gates.length === 0) return null;

  const agentName = (id: string | null): string => {
    if (!id) return "Board owner";
    return agents?.find((a) => a.id === id)?.name ?? `${id.slice(0, 8)}…`;
  };

  return (
    <section className="mb-3 space-y-2" aria-label="Gate ledger">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Gate ledger</h3>
      <ul className="space-y-1.5">
        {gates.map((gate) => (
          <GateRow key={gate.id} gate={gate} agentName={agentName(gateDesignatedAgentId(gate.payload))} />
        ))}
      </ul>
    </section>
  );
}

function GateRow({ gate, agentName }: { gate: Approval; agentName: string }) {
  const presentation = statusPresentation(gate.status);
  const Icon = presentation.icon;
  return (
    <li className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2 text-xs">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", presentation.className)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{GATE_LABEL[gate.type as GateType]}</span>
          <span className={cn("shrink-0 font-medium capitalize", presentation.className)}>
            {presentation.label}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">{agentName}</span>
          {gate.decidedAt && <span className="shrink-0 tabular-nums">{formatDecidedAt(gate.decidedAt)}</span>}
        </div>
        {gate.decisionNote && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{gate.decisionNote}</p>}
      </div>
    </li>
  );
}

function statusPresentation(status: ApprovalStatus): {
  icon: typeof CheckCircle2;
  label: string;
  className: string;
} {
  switch (status) {
    case "approved":
      return { icon: CheckCircle2, label: "approved", className: "text-green-400" };
    case "rejected":
      return { icon: XCircle, label: "rejected", className: "text-red-400" };
    case "revision_requested":
      return { icon: RotateCcw, label: "revision", className: "text-yellow-400" };
    case "cancelled":
      return { icon: MinusCircle, label: "cancelled", className: "text-muted-foreground" };
    default:
      return { icon: Clock, label: "pending", className: "text-muted-foreground" };
  }
}

function formatDecidedAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
