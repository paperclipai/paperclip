import type {
  CloudTrialInferenceStatus,
  CloudTrialTelemetryEventInput,
  MigrateCloudTrialAgentsInput,
  MigrateCloudTrialAgentsResult,
} from "@paperclipai/shared";
import { api } from "./client";

export const cloudInferenceApi = {
  getStatus: (companyId: string, opts?: { refresh?: boolean }) =>
    api.get<CloudTrialInferenceStatus>(
      `/companies/${encodeURIComponent(companyId)}/cloud-inference/status${opts?.refresh ? "?refresh=1" : ""}`,
    ),
  migrate: (companyId: string, input: MigrateCloudTrialAgentsInput) =>
    api.post<MigrateCloudTrialAgentsResult>(
      `/companies/${encodeURIComponent(companyId)}/cloud-inference/migrate`,
      input,
    ),
  trackTelemetry: (companyId: string, input: CloudTrialTelemetryEventInput) =>
    api.post<void>(
      `/companies/${encodeURIComponent(companyId)}/cloud-inference/telemetry`,
      input,
    ),
};
