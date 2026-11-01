import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { NativeSelect } from "./ui/select";

export function WorkspaceReconstructionRecovery({ issueId, blocker, canManage, onRecorded }: {
  issueId: string; blocker: ExecutionBlocker; canManage: boolean; onRecorded: () => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [missingWork, setMissingWork] = useState("");
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const [actionOutcome, setActionOutcome] = useState<"completed" | "not_performed" | "mixed">("mixed");
  const [acknowledged, setAcknowledged] = useState(false);
  const files = useQuery({ queryKey: queryKeys.issues.attachments(issueId),
    queryFn: () => issuesApi.listAttachments(issueId), enabled: canManage });
  const currentSelection = selected.filter(id => files.data?.some(file => file.id === id));
  const submit = useMutation({
    mutationFn: () => issuesApi.reconstructWorkspace(issueId, {
      actionId: blocker.recoveryActionId!, runId: blocker.runId!, expectedStatusVersion: blocker.workspaceRecoveryStatusVersion!,
      attachmentIds: currentSelection, missingWork: missingWork.trim(), actionOutcome, outcomeEvidence: outcomeEvidence.trim(), acknowledgeLostWork: true,
    }), onSuccess: onRecorded,
  });
  return <details className="w-full">
    <summary className="cursor-pointer">Continue from saved sources</summary>
    <p>The original workspace was destroyed before its edits were saved. Its last run will remain failed.</p>
    {canManage ? <div className="flex flex-col gap-2">
      <p>Select task attachments to rebuild from and record what remains missing. Paperclip starts a fresh session through its normal execution checks. Existing work limits still apply.</p>
      <fieldset disabled={submit.isPending} className="flex flex-col gap-2">
        <legend>Saved source attachments</legend>
        {files.data?.map(file => <div key={file.id} className="flex items-center gap-2">
          <Checkbox id={`${id}-${file.id}`} checked={selected.includes(file.id)} onCheckedChange={checked =>
            setSelected(current => checked === true ? [...current, file.id] : current.filter(value => value !== file.id))} />
          <Label htmlFor={`${id}-${file.id}`}>{file.originalFilename ?? "Attachment"} ({file.byteSize} bytes)</Label>
        </div>)}
        {files.isPending && <p>Loading saved attachments…</p>}
        {files.data?.length === 0 && <p>Attach the surviving source files to this task first.</p>}
        <Label htmlFor={`${id}-missing`}>Missing work and reconstruction plan</Label>
        <Textarea id={`${id}-missing`} maxLength={12000} value={missingWork} onChange={event => setMissingWork(event.target.value)} />
        <Label htmlFor={`${id}-outcome`}>Previously completed external actions</Label>
        <NativeSelect id={`${id}-outcome`} value={actionOutcome} onChange={event => setActionOutcome(event.target.value as typeof actionOutcome)}>
          <option value="mixed">Some completed, some not performed</option>
          <option value="not_performed">None performed</option>
          <option value="completed">All completed</option>
        </NativeSelect>
        <Label htmlFor={`${id}-evidence`}>Evidence and actions that must not be repeated</Label>
        <Textarea id={`${id}-evidence`} maxLength={12000} value={outcomeEvidence} onChange={event => setOutcomeEvidence(event.target.value)} />
        <div className="flex items-center gap-2">
          <Checkbox id={`${id}-ack`} checked={acknowledged} onCheckedChange={checked => setAcknowledged(checked === true)} />
          <Label htmlFor={`${id}-ack`}>Continue from these sources. The missing edits have not been recovered.</Label>
        </div>
      </fieldset>
      <div className="flex justify-end">
        <Button disabled={submit.isPending || !acknowledged || currentSelection.length === 0 || missingWork.trim().length < 20 || outcomeEvidence.trim().length < 20}
          onClick={() => submit.mutate()}>{submit.isPending ? "Queuing…" : "Rebuild and continue"}</Button>
      </div>
      {files.isError && <p role="alert" className="text-destructive">{files.error.message}</p>}
      {submit.isError && <p role="alert" className="text-destructive">{submit.error.message}</p>}
    </div> : <p>A board member with runtime access can continue from the surviving task attachments.</p>}
  </details>;
}
