import { t, useTranslation } from "@/i18n";
import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { isNativeWorkspaceExportRepairCause } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

/** Copyback repair preserves the accepted result and never wakes the provider. */
export function WorkspaceExportRecovery({ issueId, action, canManage, onQueued }: {
  issueId: string; action: IssueRecoveryAction | null; canManage: boolean; onQueued: () => void;
}) {
  useTranslation();
  const noteId = useId();
  const [repairNote, setRepairNote] = useState("");
  const [queuedActionVersion, setQueuedActionVersion] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () => issuesApi.retryWorkspaceExport(issueId, {
      actionId: action!.id, runId: action!.evidence.runId as string, repairNote: repairNote.trim(),
    }),
    onSuccess: () => { setQueuedActionVersion(String(action!.updatedAt)); onQueued(); },
  });
  if (!action || !isNativeWorkspaceExportRepairCause(action.cause) || action.ownerType !== "board"
    || !["active", "escalated"].includes(action.status) || typeof action.evidence.runId !== "string") return null;
  const queued = queuedActionVersion === String(action.updatedAt) || action.wakePolicy?.kind === "resume_native_run";
  return <section aria-label={t("oct5Core.s0103")} className="flex flex-col gap-2 p-4 text-sm">
    <p className="font-medium">{t("oct5Core.s0104")}</p>
    {queued ? <p role="status">{t("oct5Core.s0105")}</p> : <>
      <p className="text-muted-foreground">{t("oct5Core.s0106")}</p>
      {canManage ? <>
        <Label htmlFor={noteId}>{t("oct5Core.s0107")}</Label>
        <Textarea id={noteId} value={repairNote} onChange={event => setRepairNote(event.target.value)} maxLength={12_000}
          placeholder={t("oct5Core.s0108")} disabled={retry.isPending} />
        <div className="flex justify-end">
          <Button onClick={() => retry.mutate()} disabled={retry.isPending || repairNote.trim().length < 20}>
            {retry.isPending ? t("oct5Core.s0109") : t("oct5Core.s0110")}
          </Button>
        </div>
      </> : <p className="text-muted-foreground">{t("oct5Core.s0111")}</p>}
      {retry.isError && <p role="alert" className="text-destructive">{retry.error instanceof Error ? retry.error.message : t("oct5Core.s0112")}</p>}
    </>}
  </section>;
}
