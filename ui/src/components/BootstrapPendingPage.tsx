import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import type { AuthSession } from "../api/auth";

export function BootstrapPendingPage({
  hasActiveInvite = false,
  session = null,
  onClaim,
  isClaiming = false,
  claimError = null,
  signInPath = "/auth",
}: {
  hasActiveInvite?: boolean;
  session?: AuthSession | null;
  onClaim?: () => void;
  isClaiming?: boolean;
  claimError?: string | null;
  signInPath?: string;
}) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No instance admin exists yet.
          {session
            ? " Claim this instance from the browser, or use the bootstrap invite flow if you want to complete setup from another device."
            : " Sign in to claim it from the browser, or use the bootstrap invite flow if you want to complete setup from another device."}
        </p>
        {session ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={onClaim} disabled={isClaiming}>
              {isClaiming ? "Claiming…" : "Claim instance admin"}
            </Button>
            <span className="text-sm text-muted-foreground">
              Signed in as {session.user.name?.trim() || session.user.email || session.user.id}
            </span>
          </div>
        ) : (
          <div className="mt-4">
            <Button asChild>
              <Link to={signInPath}>Sign in / Create account</Link>
            </Button>
          </div>
        )}
        {claimError ? <p className="mt-3 text-sm text-destructive">{claimError}</p> : null}
        <p className="mt-4 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "A bootstrap invite is already active. Check your Paperclip startup logs for the first admin invite URL, or run this command to rotate it:"
            : "Run this command in your Paperclip environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm paperclipai onboard`}
        </pre>
      </div>
    </div>
  );
}
