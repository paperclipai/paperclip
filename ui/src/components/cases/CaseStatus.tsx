import { t, useTranslation } from "@/i18n";
import type { CaseStatus as CaseStatusValue } from "@/api/cases";
import { StatusBadge } from "@/components/StatusBadge";

export const CASE_STATUS_LABELS: Record<CaseStatusValue, string> = {
  get draft() { return t("final-components-a:draft_ebf12ef4"); },
  get in_progress() { return t("final-components-a:inProgress_c1f88e9d"); },
  get in_review() { return t("final-components-a:inReview_c3905914"); },
  get approved() { return t("final-components-a:approved_87b42e40"); },
  get done() { return t("final-components-a:done_11a6767d"); },
  get cancelled() { return t("final-components-a:cancelled_d353a99e"); },
};

export function CaseStatus({ status, className }: { status: CaseStatusValue; className?: string }) {
  useTranslation("final-components-a");
  return <StatusBadge status={status} label={CASE_STATUS_LABELS[status]} className={className} />;
}
