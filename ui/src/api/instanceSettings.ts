import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  IssueGraphLivenessAutoRecoveryPreview,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export interface SystemPauseState {
  paused: boolean;
  pausedAt: string | null;
  pauseReason: string | null;
  queuedRunCount: number;
}

export interface AgentQueuedCount {
  agentId: string;
  queuedCount: number;
}

export const instanceSettingsApi = {
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
  getAdminStatus: () =>
    api.get<SystemPauseState>("/admin/status"),
  getAgentQueuedCounts: () =>
    api.get<AgentQueuedCount[]>("/admin/agents/queued-counts"),
  adminUnpause: () =>
    api.post<SystemPauseState>("/admin/unpause", {}),
  adminPause: (reason?: string) =>
    api.post<SystemPauseState>("/admin/pause", { reason }),
  previewIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<IssueGraphLivenessAutoRecoveryPreview>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
      input,
    ),
  runIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<{
      findings: number;
      autoRecoveryEnabled: boolean;
      lookbackHours: number;
      cutoff: string;
      escalationsCreated: number;
      existingEscalations: number;
      skipped: number;
      skippedAutoRecoveryDisabled: number;
      skippedOutsideLookback: number;
      escalationIssueIds: string[];
    }>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
      input,
    ),
};
