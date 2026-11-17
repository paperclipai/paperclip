import type { ChatEndpoint } from "../../packages/shared/src/types/chat-channels.js";
import { ConnectionFailure } from "./connection-config.js";
import type { GitHubReviewJourneyConfig } from "./github-review-config.js";
import type { ConnectionApi } from "./connection-target.js";
import { randomUUID } from "node:crypto";
import { awaitJourneyCondition } from "./github-review-browser.js";

const liveRunStatuses = new Set(["queued", "running", "scheduled_retry"]);

/** The issue run source includes history beyond company list windows. Related
 * activity can name a run for another task, so hydrate and check direct ownership. */
export async function readOwnedGitHubReviewRuns(api: Pick<ConnectionApi, "get">, scope: { companyId: string; agentId: string; issueId: string }) {
  const rows = await api.get<Array<{ runId: string }>>(`/api/issues/${scope.issueId}/runs`);
  if (!Array.isArray(rows) || rows.some(row => typeof row.runId !== "string" || !row.runId)) throw new ConnectionFailure("invalid_issue_run_inventory");
  const runs = await Promise.all([...new Set(rows.map(row => row.runId))].map(id => api.get<Record<string, any>>(`/api/heartbeat-runs/${id}`)));
  if (runs.some(run => run.companyId !== scope.companyId)) throw new ConnectionFailure("issue_run_company_mismatch");
  return runs.filter(run => run.issueId === scope.issueId && run.agentId === scope.agentId);
}

/** A failed native run can still own a durable retry. Stop it through the
 * normal audited route and require acknowledgement, not just terminal status. */
export async function stopOwnedGitHubReviewRun(api: Pick<ConnectionApi, "get" | "post">, runId: string,
  scope: { companyId: string; agentId: string; issueId: string }, signal: AbortSignal, timeoutMs = 30_000) {
  const read = async () => {
    const run = await api.get<Record<string, any>>(`/api/heartbeat-runs/${runId}`);
    if (run.id !== runId || run.companyId !== scope.companyId || run.agentId !== scope.agentId || run.issueId !== scope.issueId) {
      throw new ConnectionFailure("cleanup_run_owner_mismatch");
    }
    return run;
  };
  const run = await read();
  const retry = run.runtimeMode === "native" && run.status === "failed" && run.nativePhase === "retryable_failure";
  if (!liveRunStatuses.has(run.status) && !retry) return;
  await api.post(`/api/heartbeat-runs/${runId}/cancel`, run.runtimeMode === "native" ? { cancellationRequestId: randomUUID() } : {});
  await awaitJourneyCondition(async () => {
    const stopped = await read();
    if (run.runtimeMode !== "native") return !liveRunStatuses.has(stopped.status);
    const intent = stopped.resultJson?.nativeCancellation;
    return stopped.status === "cancelled" && intent?.schema === "paperclip.native-cancellation.v1"
      && intent.runId === runId && intent.companyId === scope.companyId && intent.issueId === scope.issueId
      && intent.scope === "run" && intent.reasonCode === "cancellation_run_only" && typeof intent.dispatched === "boolean"
      && intent.dispatchState === "acknowledged" && typeof intent.intentAuditId === "string" && intent.intentAuditId.length > 0
      && typeof intent.acknowledgementAuditId === "string" && intent.acknowledgementAuditId.length > 0;
  }, timeoutMs, "owned_run_cancellation_unconfirmed", signal, "failed");
}

export interface GitHubJourneyResources {
  endpointId?: string; pullNumber?: number; branch: string; appName: string;
  appId?: string; appSlug?: string; appSettingsUrl?: string; installationSettingsUrl?: string;
  issueId?: string; runIds: string[];
}

/** Bind cleanup to GitHub-confirmed identity on this attempt's owned endpoint. */
export function captureOwnedGitHubApp(resources: GitHubJourneyResources, endpoint: ChatEndpoint, config: GitHubReviewJourneyConfig) {
  if (!endpoint.botExternalId || endpoint.setup.github?.registrationStatus !== "completed") return false;
  const app = endpoint.setup.github;
  if (endpoint.id !== resources.endpointId || endpoint.companyId !== config.target.companyId || endpoint.provider !== "github"
    || endpoint.assignedAgentId !== config.agent.id || endpoint.botLabel !== resources.appName
    || !/^[1-9][0-9]*$/.test(endpoint.botExternalId) || !app.appSlug || !/^[a-z0-9-]+$/.test(app.appSlug)
    || endpoint.botUsername !== `${app.appSlug}[bot]` || app.appOwnerType !== config.github.ownerType
    || app.appOwnerLogin?.toLowerCase() !== config.github.appOwner.toLowerCase()
    || (resources.appId && resources.appId !== endpoint.botExternalId)
    || (resources.appSlug && resources.appSlug !== app.appSlug)) throw new ConnectionFailure("owned_github_app_binding_mismatch");
  resources.appId = endpoint.botExternalId;
  resources.appSlug = app.appSlug;
  const owner = encodeURIComponent(app.appOwnerLogin!);
  resources.appSettingsUrl = app.appOwnerType === "organization"
    ? `https://github.com/organizations/${owner}/settings/apps/${app.appSlug}`
    : `https://github.com/settings/apps/${app.appSlug}`;
  // Installation management is a different resource. Uninstalling is not proof
  // that the owned App registration was deleted.
  resources.installationSettingsUrl = app.managementUrl;
  return true;
}
