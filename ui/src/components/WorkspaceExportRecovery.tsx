import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { isNativeWorkspaceExportRepairCause } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
import { Textarea } from "./ui/textarea";

/** Copyback repair preserves the accepted result and never wakes the provider. */
export function WorkspaceExportRecovery({ issueId, action, canManage, onQueued, className }: {
  className?: string;
  issueId: string; action: IssueRecoveryAction | null; canManage: boolean; onQueued: () => void;
}) {
  const noteId = useId();
  const confirmationId = useId();
  const [stopped, setStopped] = useState(false);
  const ownerRecovery = action?.cause === "native_workspace_finalization_owner_unverified";
  const owner = action?.evidence?.owner as { token?: string; hostname?: string; pid?: number; processStartedAt?: string } | undefined;
  const [repairNote, setRepairNote] = useState("");
  const [queuedActionVersion, setQueuedActionVersion] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () => ownerRecovery ? issuesApi.resumeWorkspaceFinalization(issueId, {
      actionId: action!.id, runId: action!.evidence.runId as string, ownerToken: owner!.token!,
      controllerAndCopybackStopped: true, stopEvidence: repairNote.trim(),
    }) : issuesApi.retryWorkspaceExport(issueId, {
      actionId: action!.id, runId: action!.evidence.runId as string, repairNote: repairNote.trim(),
    }),
    onSuccess: () => { setQueuedActionVersion(String(action!.updatedAt)); onQueued(); },
  });
  if (!action || (!ownerRecovery && !isNativeWorkspaceExportRepairCause(action.cause)) || action.ownerType !== "board"
    || !["active", "escalated"].includes(action.status) || typeof action.evidence.runId !== "string") return null;
  if (ownerRecovery && typeof owner?.token !== "string") return null;
  const queued = !!action.evidence.workspaceOwnerStop || queuedActionVersion === String(action.updatedAt) || action.wakePolicy?.kind === "resume_native_run";
  return <section aria-label={ownerRecovery ? "Workspace finalization recovery" : "Workspace export repair"} className={cn("task-context-notice flex flex-col gap-2", className)}>
    <p className="font-medium">{ownerRecovery ? "Workspace finalization needs recovery" : "Workspace export needs repair"}</p>
    {queued ? <p role="status">{ownerRecovery ? "Workspace finalization is queued for the saved result." : "Export is queued for the saved result."} The agent will not repeat its work.</p> : <>
      <p className="text-muted-foreground">{ownerRecovery ? "The agent’s result is saved. Before resuming, verify through the deployment platform that the previous controller and all its workspace-copyback processes have stopped. Keep the saved workspace intact." : "Automatic workspace export retries stopped. Inspect the export failure, restore provider or destination availability, and preserve the saved files in the retained sandbox. Retry export here when the cause is resolved."}</p>
      {ownerRecovery && <p className="font-mono text-muted-foreground">{owner?.hostname} · PID {owner?.pid} · started {owner?.processStartedAt}</p>}
      {canManage ? <>
        <Label htmlFor={noteId}>{ownerRecovery ? "Deployment stop evidence" : "Repair performed"}</Label>
        <Textarea id={noteId} value={repairNote} onChange={event => setRepairNote(event.target.value)} maxLength={12_000}
          placeholder={ownerRecovery ? "Record how the deployment platform confirmed this controller and all copyback processes stopped." : "Describe the repair and how the saved workspace files were preserved."} disabled={retry.isPending} />
        {ownerRecovery && <div className="flex items-center gap-2">
          <Checkbox id={confirmationId} checked={stopped} onCheckedChange={value => setStopped(value === true)} disabled={retry.isPending} />
          <Label htmlFor={confirmationId}>I verified that this controller and all its copyback processes have stopped.</Label>
        </div>}
        <div className="flex justify-end">
          <Button onClick={() => retry.mutate()} disabled={retry.isPending || repairNote.trim().length < 20 || (ownerRecovery && !stopped)}>
            {retry.isPending ? "Queueing…" : ownerRecovery ? "Resume saved result" : "Retry workspace export"}
          </Button>
        </div>
      </> : <p className="text-muted-foreground">A board member with runtime access can recover this workspace.</p>}
      {retry.isError && <p role="alert" className="text-destructive">{retry.error instanceof Error ? retry.error.message : "Could not queue export. Refresh the task and inspect its run."}</p>}
    </>}
  </section>;
}
