import { t, useTranslation, Trans } from "@/i18n";
import { useQueryView } from "@/components/QueryView";
import { describeError } from "@/api/errors";
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
  useTranslation("task-components");
  const id = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [missingWork, setMissingWork] = useState("");
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const [actionOutcome, setActionOutcome] = useState<"completed" | "not_performed" | "mixed">("mixed");
  const [acknowledged, setAcknowledged] = useState(false);
  const files = useQuery({ queryKey: queryKeys.issues.attachments(issueId),
    queryFn: () => issuesApi.listAttachments(issueId), enabled: canManage });
  const filesView = useQueryView(files);
  const currentSelection = selected.filter(id => files.data?.some(file => file.id === id));
  const submit = useMutation({
    mutationFn: () => issuesApi.reconstructWorkspace(issueId, {
      actionId: blocker.recoveryActionId!, runId: blocker.runId!, expectedStatusVersion: blocker.workspaceRecoveryStatusVersion!,
      attachmentIds: currentSelection, missingWork: missingWork.trim(), actionOutcome, outcomeEvidence: outcomeEvidence.trim(), acknowledgeLostWork: true,
    }), onSuccess: onRecorded,
  });
  return <details className="w-full">
    <summary className="cursor-pointer">{t("task-components:continueFromSavedSources_8e121d5d")}</summary>
    <p>{t("task-components:theOriginalWorkspaceWasDestroyedBeforeIts_4eb3a16c")}</p>
    {canManage ? <div className="flex flex-col gap-2">
      <p>{t("task-components:selectTaskAttachmentsToRebuildFromAnd_81eba32b")}</p>
      <fieldset disabled={submit.isPending} className="flex flex-col gap-2">
        <legend>{t("task-components:savedSourceAttachments_905d6825")}</legend>
        {files.data?.map(file => <div key={file.id} className="flex items-center gap-2">
          <Checkbox id={`${id}-${file.id}`} checked={selected.includes(file.id)} onCheckedChange={checked =>
            setSelected(current => checked === true ? [...current, file.id] : current.filter(value => value !== file.id))} />
          <Label htmlFor={`${id}-${file.id}`}><Trans ns="task-components" i18nKey="sentence_0753a29ae761" components={{ part1: <>{file.originalFilename ?? "Attachment"}</>, part2: <>{file.byteSize}</> }} /></Label>
        </div>)}
        {files.isPending && <p>{t("task-components:loadingSavedAttachments_32fa1e46")}</p>}
        {files.data?.length === 0 && <p>{t("task-components:attachTheSurvivingSourceFilesToThis_40213a41")}</p>}
        <Label htmlFor={`${id}-missing`}>{t("task-components:missingWorkAndReconstructionPlan_72180f14")}</Label>
        <Textarea id={`${id}-missing`} maxLength={12000} value={missingWork} onChange={event => setMissingWork(event.target.value)} />
        <Label htmlFor={`${id}-outcome`}>{t("task-components:previouslyCompletedExternalActions_9929947a")}</Label>
        <NativeSelect id={`${id}-outcome`} value={actionOutcome} onChange={event => setActionOutcome(event.target.value as typeof actionOutcome)}>
          <option value="mixed">{t("task-components:someCompletedSomeNotPerformed_ce9ef19d")}</option>
          <option value="not_performed">{t("task-components:nonePerformed_380c7897")}</option>
          <option value="completed">{t("task-components:allCompleted_1c935e34")}</option>
        </NativeSelect>
        <Label htmlFor={`${id}-evidence`}>{t("task-components:evidenceAndActionsThatMustNotBe_9f1e6f66")}</Label>
        <Textarea id={`${id}-evidence`} maxLength={12000} value={outcomeEvidence} onChange={event => setOutcomeEvidence(event.target.value)} />
        <div className="flex items-center gap-2">
          <Checkbox id={`${id}-ack`} checked={acknowledged} onCheckedChange={checked => setAcknowledged(checked === true)} />
          <Label htmlFor={`${id}-ack`}>{t("task-components:continueFromTheseSourcesTheMissingEdits_d3b05444")}</Label>
        </div>
      </fieldset>
      <div className="flex justify-end">
        <Button disabled={submit.isPending || !acknowledged || currentSelection.length === 0 || missingWork.trim().length < 20 || outcomeEvidence.trim().length < 20}
          onClick={() => submit.mutate()}>{submit.isPending ? t("task-components:queuing_37255b74") : t("task-components:rebuildAndContinue_f95a0b77")}</Button>
      </div>
      {(filesView.kind === "error") && <p role="alert" className="text-destructive">{describeError(files.error).body}</p>}
      {submit.error && <p role="alert" className="text-destructive">{describeError(submit.error).body}</p>}
    </div> : <p>{t("task-components:aBoardMemberWithRuntimeAccessCan_bff7d5a9")}</p>}
  </details>;
}
