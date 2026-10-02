import type { IssueThreadInteraction } from "@/lib/issue-thread-interactions";
import { interactionReplacement } from "@/lib/issue-thread-interactions";
import { Link } from "@/lib/router";

/** Read-only navigation to the same issue's existing replacement audit record. */
export function InteractionReplacementNotice({ interaction }: {
  interaction: IssueThreadInteraction;
}) {
  const replacement = interactionReplacement(interaction);
  if (!replacement) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="interaction-replacement-notice">
      <Link to={replacement.href} disableIssueQuicklook className="underline underline-offset-2">
        {replacement.label}
      </Link>
      {". This request is no longer awaiting a response."}
    </p>
  );
}
