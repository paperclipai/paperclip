import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ExecutionBlocker, Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

export function WorkspaceFileRecovery({ issueId, issueStatus, blocker, canManage, onRecorded }: {
  issueId: string;
  issueStatus: Issue["status"];
  blocker: ExecutionBlocker;
  canManage: boolean;
  onRecorded: () => void;
}) {
  const noteId = useId();
  const confirmationId = useId();
  const [evidence, setEvidence] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const record = useMutation({
    mutationFn: () => issuesApi.resolveRecoveryAction(issueId, {
      actionId: blocker.recoveryActionId!, outcome: "restored", sourceIssueStatus: issueStatus,
      resolutionNote: evidence.trim(),
      executionReconciliation: {
        runId: blocker.runId!, providerStopped: true, actionOutcome: "mixed",
        outcomeEvidence: "This request records recovered workspace files only. It does not replay the source run or certify its external action outcomes.",
        workspaceRepairEvidence: evidence.trim(),
      },
    }),
    onSuccess: onRecorded,
  });
  if (!blocker.workspaceRepairRequired || !blocker.canRecordWorkspaceRepair || blocker.cause !== "legacy_execution_requires_reconciliation"
    || !blocker.recoveryActionId || !blocker.runId) return null;
  return <section aria-label="Record workspace file recovery" className="flex w-full flex-col gap-2">
    {record.isSuccess ? <p role="status">File recovery recorded. The task status is unchanged. Continue the task when it is ready.</p>
      : canManage ? <>
        <Label htmlFor={noteId}>Recovered files and verification</Label>
        <Textarea id={noteId} value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={12_000}
          placeholder="Describe how you recovered and verified the files from the original workspace. Include the backup or artifact link."
          disabled={record.isPending} />
        <div className="flex items-center gap-2">
          <Checkbox id={confirmationId} checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} disabled={record.isPending} />
          <Label htmlFor={confirmationId}>I recovered and verified the original workspace files.</Label>
        </div>
        <p className="text-muted-foreground">This records file recovery. It keeps the current task status and does not start a run. Paperclip verifies that the original execution stopped.</p>
        <div className="flex justify-end">
          <Button disabled={record.isPending || !confirmed || evidence.trim().length < 20} onClick={() => record.mutate()}>
            {record.isPending ? "Recording…" : "Record file recovery"}
          </Button>
        </div>
        {record.isError && <p role="alert" className="text-destructive">{record.error.message}</p>}
      </> : <p className="text-muted-foreground">A board member with runtime access can record verified file recovery here.</p>}
  </section>;
}
