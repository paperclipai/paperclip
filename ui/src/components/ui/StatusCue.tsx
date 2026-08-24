import type { BackgroundJobStatus } from "@paperclipai/shared";

interface StatusCueProps {
  status: BackgroundJobStatus | "idle" | "loading";
  progress: number;
  progressMessage: string | null;
  error: string | null;
  isRunning: boolean;
  isDone: boolean;
  /** Optional label override (defaults to status). */
  label?: string;
  className?: string;
}

const STATUS_COLORS: Record<string, string> = {
  idle: "text-muted-foreground",
  loading: "text-blue-500",
  queued: "text-blue-400",
  running: "text-blue-500",
  succeeded: "text-green-500",
  failed: "text-red-500",
};

const STATUS_LABELS: Record<string, string> = {
  idle: "Waiting",
  loading: "Loading",
  queued: "Queued",
  running: "Running",
  succeeded: "Complete",
  failed: "Failed",
};

/**
 * A compact status indicator for background jobs.
 *
 * Displays:
 * - A colored dot and status label
 * - A progress bar when the job is running
 * - A progress message when available
 * - An error message when the job has failed
 */
export function StatusCue({
  status,
  progress,
  progressMessage,
  error,
  isRunning,
  isDone,
  label,
  className = "",
}: StatusCueProps) {
  const color = STATUS_COLORS[status] ?? "text-muted-foreground";
  const displayLabel = label ?? STATUS_LABELS[status] ?? status;

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      {/* Status dot */}
      <span
        className={`inline-block w-2 h-2 rounded-full ${
          isRunning ? "bg-blue-500 animate-pulse" : isDone ? "bg-green-500" : status === "failed" ? "bg-red-500" : "bg-muted-foreground"
        }`}
        aria-hidden="true"
      />

      {/* Status label */}
      <span className={`text-sm font-medium ${color}`}>{displayLabel}</span>

      {/* Progress bar for running jobs */}
      {isRunning && progress > 0 && (
        <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-500"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}

      {/* Progress percentage */}
      {isRunning && progress > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {progress}%
        </span>
      )}

      {/* Progress message */}
      {progressMessage && (
        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
          {progressMessage}
        </span>
      )}

      {/* Error message */}
      {error && (
        <span className="text-xs text-red-500 truncate max-w-[300px]" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}