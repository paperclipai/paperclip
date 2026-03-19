import { useTranslation } from "react-i18next";
import { Link, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { queryKeys } from "../lib/queryKeys";

function isSafeExternalUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-28 shrink-0 text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

export function ExecutionWorkspaceDetail() {
  const { t } = useTranslation("settings");
  const { workspaceId } = useParams<{ workspaceId: string }>();

  const { data: workspace, isLoading, error } = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId!),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("executionWorkspaceDetail.loading")}</p>;
  if (error) return <p className="text-sm text-destructive">{error instanceof Error ? error.message : t("executionWorkspaceDetail.loadError")}</p>;
  if (!workspace) return null;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">{t("executionWorkspaceDetail.subtitle")}</div>
        <h1 className="text-2xl font-semibold">{workspace.name}</h1>
        <div className="text-sm text-muted-foreground">
          {workspace.status} · {workspace.mode} · {workspace.providerType}
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <DetailRow label={t("executionWorkspaceDetail.fields.project")}>
          {workspace.projectId ? <Link to={`/projects/${workspace.projectId}`} className="hover:underline">{workspace.projectId}</Link> : t("executionWorkspaceDetail.none")}
        </DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.sourceIssue")}>
          {workspace.sourceIssueId ? <Link to={`/issues/${workspace.sourceIssueId}`} className="hover:underline">{workspace.sourceIssueId}</Link> : t("executionWorkspaceDetail.none")}
        </DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.branch")}>{workspace.branchName ?? t("executionWorkspaceDetail.none")}</DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.baseRef")}>{workspace.baseRef ?? t("executionWorkspaceDetail.none")}</DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.workingDir")}>
          <span className="break-all font-mono text-xs">{workspace.cwd ?? t("executionWorkspaceDetail.none")}</span>
        </DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.providerRef")}>
          <span className="break-all font-mono text-xs">{workspace.providerRef ?? t("executionWorkspaceDetail.none")}</span>
        </DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.repoUrl")}>
          {workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? (
            <a href={workspace.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
              {workspace.repoUrl}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : workspace.repoUrl ? (
            <span className="break-all font-mono text-xs">{workspace.repoUrl}</span>
          ) : t("executionWorkspaceDetail.none")}
        </DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.opened")}>{new Date(workspace.openedAt).toLocaleString()}</DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.lastUsed")}>{new Date(workspace.lastUsedAt).toLocaleString()}</DetailRow>
        <DetailRow label={t("executionWorkspaceDetail.fields.cleanup")}>
          {workspace.cleanupEligibleAt ? `${new Date(workspace.cleanupEligibleAt).toLocaleString()}${workspace.cleanupReason ? ` · ${workspace.cleanupReason}` : ""}` : t("executionWorkspaceDetail.notScheduled")}
        </DetailRow>
      </div>
    </div>
  );
}
