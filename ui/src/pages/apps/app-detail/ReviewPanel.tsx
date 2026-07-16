import { ReviewQueueCard } from "../ReviewQueueCard";
import { QuarantinePill } from "./SetupPanel";
import type { AppDetailSectionProps } from "./types";

export function ReviewPanel({
  connectionId,
  quarantined = [],
  pending = false,
  onTurnOnQuarantined,
}: Pick<AppDetailSectionProps, "connectionId"> &
  Partial<Pick<AppDetailSectionProps, "quarantined" | "pending">> & {
    onTurnOnQuarantined?: (ids: string[]) => void;
  }) {
  const showsQuarantinedActions = quarantined.length > 0 && !!onTurnOnQuarantined;

  return (
    <div className="space-y-4">
      {showsQuarantinedActions ? (
        <QuarantinePill
          count={quarantined.length}
          entries={quarantined}
          disabled={pending}
          onTurnOn={onTurnOnQuarantined}
        />
      ) : null}
      <ReviewQueueCard
        connectionId={connectionId}
        heading="Waiting for your OK"
        emptyState={showsQuarantinedActions ? "hidden" : "reassure"}
      />
    </div>
  );
}
