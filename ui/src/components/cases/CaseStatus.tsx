import type { CaseStatus as CaseStatusValue } from "@/api/cases";
import { StatusBadge } from "@/components/StatusBadge";

export const CASE_STATUS_LABELS: Record<CaseStatusValue, string> = {
  draft: "Draft",
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  done: "Done",
  cancelled: "Cancelled",
};

export function CaseStatus({ status, className }: { status: CaseStatusValue; className?: string }) {
  return <StatusBadge status={status} label={CASE_STATUS_LABELS[status]} className={className} />;
}
