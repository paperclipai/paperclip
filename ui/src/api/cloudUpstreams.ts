import type {
  CloudUpstreamActivationEntityType,
  CloudUpstreamConnectStartResponse,
  CloudUpstreamConnection,
  CloudUpstreamPreview,
  CloudUpstreamRun,
  CloudUpstreamsState,
} from "@paperclipai/shared";
import { api } from "./client";

export const cloudUpstreamsApi = {
  list: (companyId: string) =>
    api.get<CloudUpstreamsState>(`/cloud-upstreams?companyId=${encodeURIComponent(companyId)}`),
  startConnect: (input: { companyId: string; remoteUrl: string; redirectUri: string }) =>
    api.post<CloudUpstreamConnectStartResponse>("/cloud-upstreams/connect/start", input),
  finishConnect: (input: { pendingConnectionId: string; code: string; state: string }) =>
    api.post<CloudUpstreamConnection>("/cloud-upstreams/connect/finish", input),
  preview: (connectionId: string, input: { companyId: string }) =>
    api.post<CloudUpstreamPreview>(`/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs/preview`, input),
  createRun: (connectionId: string, input: { companyId: string; retryOfRunId?: string | null }) =>
    api.post<CloudUpstreamRun>(`/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs`, input ?? {}),
  getRun: (connectionId: string, runId: string, companyId: string) =>
    api.get<CloudUpstreamRun>(
      `/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs/${encodeURIComponent(runId)}?companyId=${encodeURIComponent(companyId)}`,
    ),
  cancelRun: (connectionId: string, runId: string, input: { companyId: string }) =>
    api.post<CloudUpstreamRun>(
      `/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs/${encodeURIComponent(runId)}/cancel`,
      input,
    ),
  activateEntities: (
    connectionId: string,
    runId: string,
    input: { companyId: string; entityType: CloudUpstreamActivationEntityType },
  ) =>
    api.post<CloudUpstreamRun>(
      `/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs/${encodeURIComponent(runId)}/activation`,
      input,
    ),
};
