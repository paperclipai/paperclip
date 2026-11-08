import { describeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation, Trans } from "@/i18n";
import { useMutation } from "@tanstack/react-query";
import { ENVIRONMENT_LEASE_POLICIES, WORKSPACE_SOURCE_VERIFICATION_REASONS } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { formatDateTime } from "../lib/utils";
import { WorkspaceExportRecovery } from "./WorkspaceExportRecovery";

function recordedFailure(evidence: Record<string, unknown>): string {
  const recovery = evidence.systemRecovery;
  if (!recovery || typeof recovery !== "object" || !("failure" in recovery)) return t("final-components-b:RunWorkspaceSourceInspection.No_recorded_system_recovery_failure_4680e4");
  const failure = recovery.failure;
  if (!failure || typeof failure !== "object" || !("code" in failure) || typeof failure.code !== "string")
    return t("final-components-b:RunWorkspaceSourceInspection.No_recorded_system_recovery_failure_4680e4");
  const detail = "sourceVerification" in failure ? failure.sourceVerification : null;
  if (!detail || typeof detail !== "object" || !("reason" in detail) || typeof detail.reason !== "string" ||
    !(WORKSPACE_SOURCE_VERIFICATION_REASONS as readonly string[]).includes(detail.reason)) return failure.code;
  const policy = "observedLeasePolicy" in detail ? detail.observedLeasePolicy : null;
  const allowedPolicy = typeof policy === "string" &&
    (policy === "unrecognized" || (ENVIRONMENT_LEASE_POLICIES as readonly string[]).includes(policy));
  return [failure.code, detail.reason, ...(allowedPolicy ? [`lease policy ${policy}`] : [])].join(" · ");
}

export function RunWorkspaceSourceInspection({ issueId, runId, companyId }: { issueId: string; runId: string; companyId: string }) {
  useTranslation("task-components");
  const listing = useMutation({ mutationFn: () => issuesApi.recoveryActions(issueId, { runId }) });
  const inspection = useMutation({ mutationFn: (actionId: string) => issuesApi.recoveryActions(issueId, { runId, actionId }) });
  const pending = listing.isPending || inspection.isPending;
  const error = listing.error ?? inspection.error;
  const current = inspection.data?.sourceInspection;
  return (
    <div className="space-y-2" data-testid="run-workspace-source-inspection">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => { inspection.reset(); listing.mutate(); }}>
        {pending ? t("final-components-b:RunWorkspaceSourceInspection.Inspecting_recovery_d0e50e") : t("final-components-b:RunWorkspaceSourceInspection.Inspect_recovery_dec40e")}
      </Button>
      {error ? <p role="alert" className="text-xs text-destructive">
        {error instanceof Error ? describeUiError(error).body : t("final-components-b:RunWorkspaceSourceInspection.Recovery_inspection_failed_Try_inspecting_again_5a03f7")}
      </p> : null}
      {listing.data?.actions.length === 0 ? <p className="text-xs text-muted-foreground">{t("task-components:sentence_4de95c98e00f")}</p> : null}
      {listing.data?.actions.map(action => (
        <div key={action.id} className="space-y-2 text-xs">
          <p><Trans ns="task-components" i18nKey="sentence_36808c360831" components={{ part1: <>{<code className="font-mono">{recordedFailure(action.evidence)}</code>}</> }} /></p>
          <p className="font-mono text-muted-foreground">{action.id} · {action.status}</p>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => inspection.mutate(action.id)}>{t("task-components:sentence_c9d0068f960a")}</Button>
          {action.evidence.runId === runId ? <WorkspaceExportRecovery action={action}
            issueId={issueId} companyId={companyId} showStatus={false} /> : null}
        </div>
      ))}
      {current ? <div className="space-y-2 text-xs" role="status">
        <p className="font-medium">{t("task-components:sentence_3e500d99cbd3")}</p>
        <p className="font-mono text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_aeaadaec152c" components={{ part1: <>{current.actionId}</> }} /></p>
        <p className="text-muted-foreground">{t("task-components:sentence_652889e29670")}</p>
        {current.status === "verified" ? <p>{t("task-components:sentence_0db2db4d805a")}</p>
          : current.status === "not_inspected" ? <p>{t("task-components:sourceInspectionLimit")}</p>
          : <p>{t("task-components:blocked_3e75b484")}<code className="font-mono">{current.sourceVerification?.reason ?? current.failureCode}</code>
            {current.sourceVerification?.observedLeasePolicy ? <><Trans ns="task-components" i18nKey="sentence_2586ac826cb3" components={{ part1: <>{<code className="font-mono">{current.sourceVerification.observedLeasePolicy}</code>}</> }} /></> : null}</p>}
        <p className="font-mono text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_cac6245fce13" components={{ part1: <>{formatDateTime(current.observedAt)}</> }} /></p>
      </div> : null}
    </div>
  );
}
