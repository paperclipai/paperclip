import { Check, Clock, X, RotateCcw } from "lucide-react";
import type { GateApprovalType, IssueGateState, IssueGateSummary } from "@paperclipai/shared";

// Short label per gate type for the compact card row.
const GATE_LABEL: Record<GateApprovalType, string> = {
  gate_plan_approval: "plan",
  gate_code_review: "code",
  gate_wiring_review: "wiring",
  gate_completeness_review: "done-check",
};

// Per-status icon + color. Mirrors the gate lifecycle: pending → approved /
// rejected / revision_requested.
const STATUS_STYLE: Record<
  IssueGateState["status"],
  { className: string; Icon: typeof Check; title: string }
> = {
  approved: {
    className: "text-emerald-700 dark:text-emerald-300",
    Icon: Check,
    title: "approved",
  },
  pending: {
    className: "text-amber-700 dark:text-amber-300",
    Icon: Clock,
    title: "pending",
  },
  rejected: {
    className: "text-red-700 dark:text-red-300",
    Icon: X,
    title: "rejected",
  },
  revision_requested: {
    className: "text-violet-700 dark:text-violet-300",
    Icon: RotateCcw,
    title: "revision requested",
  },
};

// Compact gate breakdown shown on board cards that have gates. One chip per gate
// type, each carrying its current state. Renders nothing when there are no gates
// (callers also guard on a null summary).
export function GateBadgeRow({ summary }: { summary: IssueGateSummary }) {
  if (summary.gates.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1" aria-label="Gate status">
      {summary.gates.map((gate) => {
        const style = STATUS_STYLE[gate.status];
        const Icon = style.Icon;
        return (
          <span
            key={gate.type}
            title={`${GATE_LABEL[gate.type]}: ${style.title}`}
            className={`inline-flex items-center gap-0.5 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium ${style.className}`}
          >
            <Icon className="h-2.5 w-2.5" />
            {GATE_LABEL[gate.type]}
          </span>
        );
      })}
    </div>
  );
}
