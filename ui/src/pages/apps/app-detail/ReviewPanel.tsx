import { ReviewQueueCard } from "../ReviewQueueCard";

export function ReviewPanel({ connectionId }: { connectionId: string }) {
  return <ReviewQueueCard connectionId={connectionId} heading="Waiting for your OK" emptyState="reassure" />;
}
