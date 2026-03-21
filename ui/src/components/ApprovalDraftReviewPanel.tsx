import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getApprovalDraftText(payload: Record<string, unknown>): string | null {
  const direct = [
    payload.draft,
    payload.fullDraft,
    payload.plan,
    payload.description,
    payload.strategy,
    payload.text,
  ];
  for (const candidate of direct) {
    const value = stringValue(candidate);
    if (value) return value;
  }

  const nested = payload.draftContent;
  if (typeof nested === "object" && nested !== null) {
    const body = stringValue((nested as Record<string, unknown>).body);
    if (body) return body;
  }
  return null;
}

type ApprovalDraftReviewPanelProps = {
  draftText: string | null;
  status: string;
  onApprove: () => void;
  onNeedsEdits: () => void;
  onReject: () => void;
  approvePending?: boolean;
  needsEditsPending?: boolean;
  rejectPending?: boolean;
};

export function ApprovalDraftReviewPanel({
  draftText,
  status,
  onApprove,
  onNeedsEdits,
  onReject,
  approvePending = false,
  needsEditsPending = false,
  rejectPending = false,
}: ApprovalDraftReviewPanelProps) {
  const isActionable = status === "pending" || status === "revision_requested";
  return (
    <section className="border border-border rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Full draft preview</h3>
        <p className="text-xs text-muted-foreground">
          Review the entire draft before deciding.
        </p>
      </div>

      {draftText ? (
        <div className="rounded-md border border-border/60 bg-muted/20 p-3 max-h-[28rem] overflow-y-auto">
          <MarkdownBody className="text-sm">{draftText}</MarkdownBody>
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
          No draft content was provided in this approval payload.
        </div>
      )}

      {isActionable ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            className="bg-green-700 hover:bg-green-600 text-white"
            onClick={onApprove}
            disabled={approvePending}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onNeedsEdits}
            disabled={needsEditsPending}
          >
            Needs edits
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onReject}
            disabled={rejectPending}
          >
            Reject
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          This approval is already resolved.
        </p>
      )}
    </section>
  );
}
