import type {
  InstanceExperimentalSettingsWithManaged,
  InstanceGeneralSettings,
  InstanceSsoSettings,
  InstanceSettings,
  IssueGraphLivenessAutoRecoveryPreview,
  PatchInstanceSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
  PatchInstanceSsoSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export const instanceSettingsApi = {
  get: () =>
    api.get<InstanceSettings>("/instance/settings"),
  update: (patch: PatchInstanceSettings) =>
    api.patch<InstanceSettings>("/instance/settings", patch),
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettingsWithManaged>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettingsWithManaged>("/instance/settings/experimental", patch),
  getSso: () =>
    api.get<InstanceSsoSettings>("/instance/settings/sso"),
  updateSso: (patch: PatchInstanceSsoSettings) =>
    api.patch<InstanceSsoSettings>("/instance/settings/sso", patch),
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
      dependencyWakeBackstopChecked: number;
      dependencyWakesHealed: number;
      dependencyWakeExistingSkipped: number;
      dependencyWakeLivePathSkipped: number;
      dependencyWakeInteractionSkipped: number;
      dependencyWakePauseHoldSkipped: number;
      dependencyWakeNotReadySkipped: number;
      dependencyWakeCandidateLimitSkipped: number;
      dependencyWakeDeferredOrFailed: number;
      dependencyWakeEnqueueFailed: number;
      dependencyWakeIssueIds: string[];
      escalationIssueIds: string[];
    }>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
      input,
    ),
};
