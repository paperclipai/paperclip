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
  preview: (connectionId: string) =>
    api.post<CloudUpstreamPreview>(`/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs/preview`, {}),
  createRun: (connectionId: string, input?: { retryOfRunId?: string | null }) =>
    api.post<CloudUpstreamRun>(`/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs`, input ?? {}),
  getRun: (connectionId: string, runId: string) =>
    api.get<CloudUpstreamRun>(
      `/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs/${encodeURIComponent(runId)}`,
    ),
  cancelRun: (connectionId: string, runId: string) =>
    api.post<CloudUpstreamRun>(
      `/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs/${encodeURIComponent(runId)}/cancel`,
      {},
    ),
  activateEntities: (
    connectionId: string,
    runId: string,
    input: { entityType: CloudUpstreamActivationEntityType },
  ) =>
    api.post<CloudUpstreamRun>(
      `/cloud-upstreams/${encodeURIComponent(connectionId)}/push-runs/${encodeURIComponent(runId)}/activation`,
      input,
    ),
};
