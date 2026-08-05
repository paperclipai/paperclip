import { Fragment } from "react";
import { RotateCcw } from "lucide-react";
import type { Issue, IssueBlockedInboxOwner } from "@paperclipai/shared";

import { InlineBanner } from "@/components/InlineBanner";
import { DeadEndBadge } from "@/components/DeadEndBadge";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";

export interface NeedsAttentionBannerProps {
  issue: Issue;
  /** Resolved display name for the routed owner (may be null). */
  ownerName?: string | null;
  onReopenDeadEnd?: () => void;
  onReassign?: () => void;
  reopenPending?: boolean;
  className?: string;
}

/** A blocked chain has a routable owner when a concrete agent/user is named, or the board owns it. */
function ownerIsRoutable(owner: IssueBlockedInboxOwner): boolean {
  if (owner.type === "unknown") return false;
  if (owner.type === "board") return true;
  return Boolean(owner.agentId) || Boolean(owner.userId);
}

function issueHref(identifier: string | null, id: string): string {
  return `/issues/${identifier ?? id}`;
}

interface BreadcrumbNode {
  id: string;
  identifier: string | null;
  title: string;
}

/**
 * Needs-attention banner for a stalled blocked chain (P6 surface 1b). Presentational: the caller
 * resolves the owner name and wires the reopen/reassign handlers. Renders nothing unless the issue's
 * blocked-inbox attention is in the `needs_attention` state. Prose is driven entirely by the
 * `action` descriptor so the copy adapts to the concrete blocker reason.
 */
export function NeedsAttentionBanner({
  issue,
  ownerName,
  onReopenDeadEnd,
  onReassign,
  reopenPending = false,
  className,
}: NeedsAttentionBannerProps) {
  const attention = issue.blockedInboxAttention;
  if (attention?.state !== "needs_attention") return null;

  const routable = ownerIsRoutable(attention.owner);
  const tone = routable ? "warning" : "danger";

  const leaf = attention.leafIssue;
  const leafIdentifier =
    leaf?.identifier ?? attention.sampleIssueIdentifier ?? issue.blockerAttention?.sampleBlockerIdentifier ?? null;
  const leafHref = leaf ? issueHref(leaf.identifier, leaf.id) : null;

  const age = attention.stoppedSinceAt ? relativeTime(attention.stoppedSinceAt) : null;
  const blockedClause = routable ? "blocked" : "blocked with no routable owner";
  const ageClause = age ? ` for ${age}` : "";

  // root -> ... -> parent -> self, followed by the dead-end leaf as the final node.
  const pathNodes: BreadcrumbNode[] = [
    ...(issue.ancestors ?? []).map((ancestor) => ({
      id: ancestor.id,
      identifier: ancestor.identifier,
      title: ancestor.title,
    })),
    { id: issue.id, identifier: issue.identifier, title: issue.title },
  ];

  const actionDetail = attention.action.detail;

  const actions = (
    <>
      {onReopenDeadEnd ? (
        <Button variant="default" size="sm" onClick={onReopenDeadEnd} disabled={reopenPending}>
          <RotateCcw aria-hidden="true" />
          Reopen dead end
        </Button>
      ) : null}
      {onReassign ? (
        <Button variant="outline" size="sm" onClick={onReassign}>
          Reassign
        </Button>
      ) : null}
      {leaf && leafHref ? (
        <Button variant="ghost" size="sm" asChild>
          <Link to={leafHref}>Open {leaf.identifier ?? leaf.id}</Link>
        </Button>
      ) : null}
    </>
  );

  return (
    <InlineBanner
      tone={tone}
      title="This chain is stalled and needs attention"
      actions={actions}
      className={className}
    >
      <div className="space-y-2">
        <p>
          {leafIdentifier ? <span className="font-mono font-semibold">{leafIdentifier}</span> : null}
          {leaf ? <> — &ldquo;{leaf.title}&rdquo;</> : null} — <span className="font-semibold">{blockedClause}{ageClause}</span>.
          {actionDetail ? <> {actionDetail}</> : null}
        </p>
        <nav
          aria-label="Blocker path"
          data-testid="needs-attention-breadcrumb"
          className="flex flex-wrap items-center gap-1.5"
        >
          {pathNodes.map((node, index) => (
            <Fragment key={node.id}>
              <Link
                to={issueHref(node.identifier, node.id)}
                title={node.title}
                className={cn(
                  "rounded-md border bg-background/40 px-1.5 py-0.5 text-xs font-mono",
                  "underline-offset-2 hover:underline",
                )}
              >
                {node.identifier ?? node.id.slice(0, 8)}
              </Link>
              {index < pathNodes.length - 1 ? (
                <span className="text-xs text-muted-foreground" aria-hidden="true">
                  &rarr;
                </span>
              ) : null}
            </Fragment>
          ))}
          {leafIdentifier ? (
            <>
              <span className="text-xs text-muted-foreground" aria-hidden="true">
                &rarr;
              </span>
              {leaf && leafHref ? (
                <Link to={leafHref} title={leaf.title} className="max-w-full min-w-0">
                  <DeadEndBadge className="font-mono">{`${leafIdentifier} · dead end`}</DeadEndBadge>
                </Link>
              ) : (
                <DeadEndBadge className="font-mono">{`${leafIdentifier} · dead end`}</DeadEndBadge>
              )}
            </>
          ) : null}
        </nav>
      </div>
    </InlineBanner>
  );
}

export default NeedsAttentionBanner;
