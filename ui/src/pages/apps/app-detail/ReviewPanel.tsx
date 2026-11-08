import { useTranslation } from "@/i18n";
import { ReviewQueueCard } from "../ReviewQueueCard";
import { QuarantinedActionsReview } from "./SetupPanel";
import type { AppDetailSectionProps } from "./types";

export function ReviewPanel({
  connectionId,
  quarantined = [],
  pending = false,
  onReviewQuarantined,
}: Pick<AppDetailSectionProps, "connectionId"> &
  Partial<Pick<AppDetailSectionProps, "quarantined" | "pending">> & {
    onReviewQuarantined?: (enabledIds: string[]) => void;
  }) {
  const { t } = useTranslation("connections");
  const showsQuarantinedActions = quarantined.length > 0 && !!onReviewQuarantined;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-foreground">{t("review_e29a79f")}</h2>
      {showsQuarantinedActions ? (
        <QuarantinedActionsReview
          entries={quarantined}
          disabled={pending}
          onSubmit={onReviewQuarantined}
        />
      ) : null}
      <ReviewQueueCard
        connectionId={connectionId}
        heading={t("waiting_for_your_ok_9911c4f")}
        emptyState={showsQuarantinedActions ? "hidden" : "reassure"}
        plain
      />
    </div>
  );
}
