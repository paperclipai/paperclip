import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";

/** GitHub page that resolves a failed Refresh access, such as Unsuspend. */
function githubAccessRecoveryUrl(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
  const details = (error.body as { details?: { code?: unknown; managementUrl?: unknown } }).details;
  if (details?.code !== "github_installation_required" || typeof details.managementUrl !== "string") return null;
  try {
    const url = new URL(details.managementUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A connection that needs attention without a new login: its saved health
 * message, a link to the GitHub page that fixes the last failed refresh, and a
 * retry.
 */
export function AccessRetryBanner({ message, error, pending, onRetry }: {
  message: string | null | undefined;
  error: unknown;
  pending: boolean;
  onRetry: () => void;
}) {
  const recoveryUrl = githubAccessRecoveryUrl(error);
  return (
    <div role="status">
      <p>{message || "GitHub access could not be checked. Try again."}</p>
      {recoveryUrl ? (
        <Button asChild variant="outline">
          <a href={recoveryUrl} target="_blank" rel="noreferrer">Open installation settings on GitHub</a>
        </Button>
      ) : null}
      <Button variant="outline" disabled={pending} onClick={onRetry}>
        Retry access
      </Button>
    </div>
  );
}
