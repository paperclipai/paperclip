import { t, useTranslation } from "@/i18n";
import { useMutation } from "@tanstack/react-query";
import { ENVIRONMENT_LEASE_POLICIES, WORKSPACE_SOURCE_VERIFICATION_REASONS } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { formatDateTime } from "../lib/utils";
import { WorkspaceExportRecovery } from "./WorkspaceExportRecovery";

function recordedFailure(evidence: Record<string, unknown>): string {
  const recovery = evidence.systemRecovery;
  if (!recovery || typeof recovery !== "object" || !("failure" in recovery)) return t("agents.recordedFailure.noFailure");
  const failure = recovery.failure;
  if (!failure || typeof failure !== "object" || !("code" in failure) || typeof failure.code !== "string")
    return t("agents.recordedFailure.noFailure");
  const detail = "sourceVerification" in failure ? failure.sourceVerification : null;
  if (!detail || typeof detail !== "object" || !("reason" in detail) || typeof detail.reason !== "string" ||
    !(WORKSPACE_SOURCE_VERIFICATION_REASONS as readonly string[]).includes(detail.reason)) return failure.code;
  const policy = "observedLeasePolicy" in detail ? detail.observedLeasePolicy : null;
  const allowedPolicy = typeof policy === "string" &&
    (policy === "unrecognized" || (ENVIRONMENT_LEASE_POLICIES as readonly string[]).includes(policy));
  return [failure.code, detail.reason, ...(allowedPolicy ? [t("agents.recordedFailure.leasePolicy", { policy })] : [])].join(" · ");
}

export function RunWorkspaceSourceInspection({ issueId, runId, companyId }: { issueId: string; runId: string; companyId: string }) {
  const { t } = useTranslation();
  const listing = useMutation({ mutationFn: () => issuesApi.recoveryActions(issueId, { runId }) });
  const inspection = useMutation({ mutationFn: (actionId: string) => issuesApi.recoveryActions(issueId, { runId, actionId }) });
  const pending = listing.isPending || inspection.isPending;
  const error = listing.error ?? inspection.error;
  const current = inspection.data?.sourceInspection;
  return (
    <div className="space-y-2" data-testid="run-workspace-source-inspection">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => { inspection.reset(); listing.mutate(); }}>
        {pending ? t("agents.RunWorkspaceSourceInspection.inspectingRecovery") : t("agents.RunWorkspaceSourceInspection.inspectRecovery")}
      </Button>
      {error ? <p role="alert" className="text-xs text-destructive">
        {error instanceof Error ? error.message : t("agents.RunWorkspaceSourceInspection.recoveryInspectionFailed")}
      </p> : null}
      {listing.data?.actions.length === 0 ? <p className="text-xs text-muted-foreground">{t("agents.RunWorkspaceSourceInspection.noRecoveryAction")}</p> : null}
      {listing.data?.actions.map(action => (
        <div key={action.id} className="space-y-2 text-xs">
          <p>{t("agents.RunWorkspaceSourceInspection.recordedFailureLabel")} <code className="font-mono">{recordedFailure(action.evidence)}</code></p>
          <p className="font-mono text-muted-foreground">{action.id} · {action.status}</p>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => inspection.mutate(action.id)}>
            {t("agents.RunWorkspaceSourceInspection.inspectCurrentSource")}
          </Button>
          {action.evidence.runId === runId ? <WorkspaceExportRecovery action={action}
            issueId={issueId} companyId={companyId} showStatus={false} /> : null}
        </div>
      ))}
      {current ? <div className="space-y-2 text-xs" role="status">
        <p className="font-medium">{t("agents.RunWorkspaceSourceInspection.currentIdentityTitle")}</p>
        <p className="font-mono text-muted-foreground">{t("agents.RunWorkspaceSourceInspection.actionIdLabel", { actionId: current.actionId })}</p>
        <p className="text-muted-foreground">{t("agents.RunWorkspaceSourceInspection.readOnlyNote")}</p>
        {current.status === "verified" ? <p>{t("agents.RunWorkspaceSourceInspection.verifiedStatus")}</p>
          : current.status === "not_inspected" ? <p>{t("agents.RunWorkspaceSourceInspection.notInspectedStatus")}</p>
          : <p>{t("agents.RunWorkspaceSourceInspection.blockedLabel")} <code className="font-mono">{current.sourceVerification?.reason ?? current.failureCode}</code>
            {current.sourceVerification?.observedLeasePolicy ? <> · {t("agents.RunWorkspaceSourceInspection.leasePolicyLabel")} <code className="font-mono">{current.sourceVerification.observedLeasePolicy}</code></> : null}</p>}
        <p className="font-mono text-muted-foreground">{t("agents.RunWorkspaceSourceInspection.observedAt", { date: formatDateTime(current.observedAt) })}</p>
      </div> : null}
    </div>
  );
}
