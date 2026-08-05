import type { Issue, IssueBlockedInboxOwner } from "@paperclipai/shared";

import { Identity } from "@/components/Identity";
import { PropertyRow, PropertySection } from "@/components/issue-properties/primitives";
import { Button } from "@/components/ui/button";

export interface UnblockPropertySectionProps {
  issue: Issue;
  /** Resolved owner display name. */
  ownerName?: string | null;
  onReopen?: () => void;
  onReassign?: () => void;
  reopenPending?: boolean;
}

function ownerIsPerson(owner: IssueBlockedInboxOwner): boolean {
  return (owner.type === "agent" || owner.type === "user") && Boolean(owner.agentId || owner.userId);
}

/**
 * Right-rail "Unblock" panel mirroring the `{owner, action}` unblock descriptor for a stalled
 * blocked chain (P6 surface 1b). Presentational: the caller resolves the owner display name and
 * wires the reopen/reassign handlers.
 */
export function UnblockPropertySection({
  issue,
  ownerName,
  onReopen,
  onReassign,
  reopenPending = false,
}: UnblockPropertySectionProps) {
  const attention = issue.blockedInboxAttention;
  const descriptor = issue.unblockDescriptor ?? null;
  const needsAttention = attention?.state === "needs_attention";
  if (!needsAttention && !descriptor) return null;

  const owner = attention?.owner ?? null;

  let ownerNode: React.ReactNode;
  if (owner && owner.type === "board") {
    ownerNode = <span>Board</span>;
  } else if (owner && ownerIsPerson(owner)) {
    ownerNode = <Identity name={ownerName ?? owner.label ?? "Owner"} size="sm" />;
  } else if (owner) {
    ownerNode = <span className="text-muted-foreground">unrouted — a human must act</span>;
  } else if (descriptor) {
    ownerNode =
      descriptor.owner === "board" ? (
        <span>Board</span>
      ) : (
        <Identity name={ownerName ?? "Owner"} size="sm" />
      );
  } else {
    ownerNode = <span className="text-muted-foreground">unrouted — a human must act</span>;
  }

  const actionLabel = descriptor?.action ?? attention?.action.label ?? null;
  const deadEndIdentifier = attention?.leafIssue?.identifier ?? attention?.sampleIssueIdentifier ?? null;

  return (
    <div data-testid="unblock-property-section">
      <PropertySection title="Unblock">
        <PropertyRow label="Owner">{ownerNode}</PropertyRow>
        <PropertyRow label="Action" wrap>
          <div className="min-w-0 space-y-0.5">
            {actionLabel ? <div className="font-medium">{actionLabel}</div> : null}
            {deadEndIdentifier ? (
              <div className="rounded-md border bg-background/40 px-1.5 py-0.5 text-xs font-mono text-muted-foreground inline-block">
                {deadEndIdentifier}
              </div>
            ) : null}
          </div>
        </PropertyRow>
        {(onReopen || onReassign) && (
          <PropertyRow label="">
            <div className="flex items-center gap-1.5">
              {onReopen ? (
                <Button size="xs" variant="default" onClick={onReopen} disabled={reopenPending}>
                  Reopen
                </Button>
              ) : null}
              {onReassign ? (
                <Button size="xs" variant="outline" onClick={onReassign}>
                  Reassign
                </Button>
              ) : null}
            </div>
          </PropertyRow>
        )}
      </PropertySection>
    </div>
  );
}

export default UnblockPropertySection;
