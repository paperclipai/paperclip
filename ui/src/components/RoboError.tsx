import { AgentFace } from "./AgentFace";
import { Button } from "@/components/ui/button";
import { resolveError } from "../lib/error-codes";

/**
 * Full-surface error state — the Robo eyes flatlined clay-red (blocked) above a
 * numbered error code, so any failure is instantly identifiable. App errors show a
 * VOS-xxxx code; errors that already carry a universal code (HTTP / SQLSTATE) show
 * that code as-is. See ui/src/lib/error-codes.ts.
 */
export function RoboError({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const { code, title, detail, universal } = resolveError(error);
  return (
    <div
      className={
        "flex min-h-[45vh] flex-col items-center justify-center gap-4 px-4 text-center" +
        (className ? ` ${className}` : "")
      }
      role="alert"
    >
      <AgentFace state="blocked" size={56} />
      <div className="space-y-1.5">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-status-error">
          {universal ? code : `error ${code}`}
        </p>
        <h2 className="font-serif text-xl font-medium">{title}</h2>
        {detail && detail.toLowerCase() !== title.toLowerCase() && (
          <p className="mx-auto max-w-md break-words font-mono text-xs text-muted-foreground">{detail}</p>
        )}
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
