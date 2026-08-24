import type { BackgroundJobStatus } from "@paperclipai/shared";

interface IncompleteDataNoticeProps {
  jobStatus: BackgroundJobStatus | "idle" | "loading";
  /** Optional human-readable label for what's being loaded. */
  subject?: string;
  className?: string;
}

/**
 * A banner shown when data is not yet available because a background
 * job hasn't finished.
 *
 * Example: displayed in place of search results while the activity
 * search job is still queued or running.
 */
export function IncompleteDataNotice({
  jobStatus,
  subject = "search results",
  className = "",
}: IncompleteDataNoticeProps) {
  if (jobStatus === "succeeded" || jobStatus === "failed") return null;

  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-muted bg-muted/30 px-3 py-2 text-sm text-muted-foreground ${className}`}
      role="status"
    >
      {jobStatus === "queued" || jobStatus === "running" ? (
        <>
          <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" aria-hidden="true" />
          <span>
            {subject === "search results"
              ? jobStatus === "queued"
                ? "Search queued — results will appear shortly"
                : "Searching activity..."
              : jobStatus === "queued"
                ? `${subject} are being prepared...`
                : `Loading ${subject}...`}
          </span>
        </>
      ) : jobStatus === "idle" || jobStatus === "loading" ? (
        <span>Loading {subject}...</span>
      ) : (
        <span>Preparing {subject}...</span>
      )}
    </div>
  );
}