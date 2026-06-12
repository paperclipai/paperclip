import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import type { Approval } from "@paperclipai/shared";
import { approvalsApi } from "../../api/approvals";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "@/lib/utils";
import { gatePlanRootIssueId, isGateType } from "../../lib/gates";

interface PlanGateRollupProps {
  companyId: string | null;
  planIssueId: string;
}

// Plan-root summary of dev-team gates: the plan-approval verdict plus a
// passed/total roll-up of the per-leaf code and wiring review gates. Reads the
// company approvals and filters to this plan via payload.planRootIssueId.
export function PlanGateRollup({ companyId, planIssueId }: PlanGateRollupProps) {
  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(companyId!),
    queryFn: () => approvalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const planGates = (approvals ?? []).filter(
    (a) => isGateType(a.type) && gatePlanRootIssueId(a.payload) === planIssueId,
  );
  if (planGates.length === 0) return null;

  const planApproval = planGates.find((a) => (a.type as string) === "gate_plan_approval") ?? null;
  const code = countGate(planGates, "gate_code_review");
  const wiring = countGate(planGates, "gate_wiring_review");

  return (
    <div className="space-y-1.5" aria-label="Plan gate summary">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Gates</h3>
      <div className="space-y-1 text-xs">
        {planApproval && (
          <div className="flex items-center gap-1.5">
            <StatusDot status={planApproval.status} />
            <span>Plan approval</span>
            <span className="capitalize text-muted-foreground">· {planApproval.status}</span>
          </div>
        )}
        {code.total > 0 && <GateCountRow label="Code review" passed={code.passed} total={code.total} />}
        {wiring.total > 0 && <GateCountRow label="Wiring review" passed={wiring.passed} total={wiring.total} />}
      </div>
    </div>
  );
}

function countGate(gates: Approval[], type: string): { passed: number; total: number } {
  const rows = gates.filter((g) => g.type === type);
  return { passed: rows.filter((g) => g.status === "approved").length, total: rows.length };
}

function GateCountRow({ label, passed, total }: { label: string; passed: number; total: number }) {
  const complete = passed === total;
  return (
    <div className="flex items-center gap-1.5">
      <StatusDot status={complete ? "approved" : "pending"} />
      <span>{label}</span>
      <span className="tabular-nums text-muted-foreground">
        · {passed}/{total} passed
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "approved") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-400" aria-hidden="true" />;
  if (status === "rejected") return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />;
  return <Clock className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground")} aria-hidden="true" />;
}
