import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type IssueBlockedMetaPanelProps = {
  blockedReason?: string | null;
  blockedUntil?: string | null;
  isEditing: boolean;
  blockedReasonDraft: string;
  blockedUntilDraft: string;
  isSaving?: boolean;
  onBlockedReasonDraftChange: (value: string) => void;
  onBlockedUntilDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: () => void;
};

export function IssueBlockedMetaPanel({
  blockedReason,
  blockedUntil,
  isEditing,
  blockedReasonDraft,
  blockedUntilDraft,
  isSaving = false,
  onBlockedReasonDraftChange,
  onBlockedUntilDraftChange,
  onSave,
  onCancel,
  onEdit,
}: IssueBlockedMetaPanelProps) {
  return (
    <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-3 text-sm text-yellow-700 dark:text-yellow-400 space-y-3">
      {isEditing ? (
        <div className="space-y-2">
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              value={blockedReasonDraft}
              onChange={(event) => onBlockedReasonDraftChange(event.target.value)}
              placeholder="Why is this blocked?"
              className="bg-background/80 text-foreground"
            />
            <Input
              value={blockedUntilDraft}
              onChange={(event) => onBlockedUntilDraftChange(event.target.value)}
              placeholder="Until what condition or time?"
              className="bg-background/80 text-foreground"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onSave} disabled={isSaving}>
              Save blocked info
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <dl className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1">
              <dt className="text-xs font-semibold uppercase tracking-wide text-yellow-700/80 dark:text-yellow-300/80">
                Blocked
              </dt>
              <dd className="min-w-0 break-words text-sm text-yellow-900 dark:text-yellow-100">
                {blockedReason || "No reason set"}
              </dd>
            </div>
            {blockedUntil && (
              <div className="space-y-1">
                <dt className="text-xs font-semibold uppercase tracking-wide text-yellow-700/70 dark:text-yellow-300/70">
                  Until
                </dt>
                <dd className="min-w-0 break-words text-sm text-yellow-700 dark:text-yellow-300">
                  {blockedUntil}
                </dd>
              </div>
            )}
          </dl>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={onEdit}>
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}
