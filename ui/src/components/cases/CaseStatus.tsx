import { t, useTranslation } from "@/i18n";
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

export function caseStatusLabel(status: CaseStatusValue): string {
  const key = { draft: "oct26Cases.status.draft", in_progress: "oct26Cases.status.in_progress", in_review: "oct26Cases.status.in_review", approved: "oct26Cases.status.approved", done: "oct26Cases.status.done", cancelled: "oct26Cases.status.cancelled" }[status];
  return key ? t(key) : status;
}

export function CaseStatus({ status, className }: { status: CaseStatusValue; className?: string }) {
  useTranslation();
  return <StatusBadge status={status} label={caseStatusLabel(status)} className={className} />;
}
