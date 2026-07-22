import { useMemo, useState } from "react";
import type { AgentConfigRevision } from "@paperclipai/shared";
import { ChevronRight, RotateCcw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatDate } from "../lib/utils";
import { formatAgentConfigValue } from "../lib/agent-config-changeset";

function valueAt(snapshot: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, snapshot);
}

export function revisionDiff(revision: AgentConfigRevision) {
  return revision.changedKeys.map((key) => ({
    key,
    before: valueAt(revision.beforeConfig, key),
    after: valueAt(revision.afterConfig, key),
  }));
}

function RevisionDiffRows({ revision }: { revision: AgentConfigRevision }) {
  return (
    <div className="divide-y divide-border">
      {revisionDiff(revision).map((entry) => (
        <div key={entry.key} className="space-y-2 py-3">
          <div className="font-mono text-xs text-muted-foreground">{entry.key}</div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="min-w-0 rounded-md bg-muted/40 p-2 font-mono break-words">{formatAgentConfigValue(entry.before)}</div>
            <div className="min-w-0 rounded-md bg-muted/40 p-2 font-mono break-words">{formatAgentConfigValue(entry.after)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function AgentConfigHistory({
  revisions,
  onRestore,
  restoring,
}: {
  revisions: AgentConfigRevision[];
  onRestore: (revisionId: string) => void;
  restoring: boolean;
}) {
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [restoreRevisionId, setRestoreRevisionId] = useState<string | null>(null);
  const selectedRevision = useMemo(() => revisions.find((revision) => revision.id === selectedRevisionId) ?? null, [revisions, selectedRevisionId]);
  const restoreRevision = useMemo(() => revisions.find((revision) => revision.id === restoreRevisionId) ?? null, [revisions, restoreRevisionId]);

  if (revisions.length === 0) return <p className="text-sm text-muted-foreground">No configuration revisions yet.</p>;

  return (
    <>
      <div className="divide-y divide-border">
        {revisions.map((revision) => (
          <div key={revision.id} className="flex items-start gap-3 py-3">
            <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50" />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedRevisionId(revision.id)}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{revision.source === "rollback" ? "Configuration restored" : "Configuration saved"}</span>
                {revision.source === "rollback" ? <Zap className="h-3.5 w-3.5 text-amber-500" aria-label="Instant apply" /> : null}
                <span className="text-xs text-muted-foreground">{formatDate(revision.createdAt)}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {revision.createdByUserId ? "Board" : revision.createdByAgentId ? `Agent ${revision.createdByAgentId.slice(0, 8)}` : "System"} · {revision.source}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {revision.changedKeys.map((key) => <Badge key={key} variant="secondary" className="font-mono text-xs">{key}</Badge>)}
              </div>
            </button>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setRestoreRevisionId(revision.id)}><RotateCcw className="h-3.5 w-3.5" />Restore</Button>
              <Button variant="ghost" size="icon" aria-label="View revision diff" onClick={() => setSelectedRevisionId(revision.id)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        ))}
      </div>

      <Sheet open={Boolean(selectedRevision)} onOpenChange={(open) => { if (!open) setSelectedRevisionId(null); }}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Configuration changes</SheetTitle>
            <SheetDescription>{selectedRevision ? `${formatDate(selectedRevision.createdAt)} · ${selectedRevision.source}` : ""}</SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4 pb-4">{selectedRevision ? <RevisionDiffRows revision={selectedRevision} /> : null}</div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={Boolean(restoreRevision)} onOpenChange={(open) => { if (!open) setRestoreRevisionId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this configuration?</AlertDialogTitle>
            <AlertDialogDescription>Review the values that will be restored. This applies immediately and creates a new history entry.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-64 overflow-y-auto">{restoreRevision ? <RevisionDiffRows revision={restoreRevision} /> : null}</div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={restoring} onClick={() => { if (restoreRevision) onRestore(restoreRevision.id); }}>
              {restoring ? "Restoring…" : "Restore configuration"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
