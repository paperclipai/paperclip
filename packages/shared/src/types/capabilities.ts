import type { CompanySettingsSurface } from "../constants.js";
import type { FeedbackDataSharingPreference } from "./feedback.js";
import type {
  InstanceExecutionMode,
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
} from "./instance.js";

/**
 * Explicit, reviewed allowlist of instance settings the frontend branches on.
 * Delivered via `GET /cli-auth/me` capabilities so the UI never reads
 * `/instance/settings*` directly (those reads are instance-admin-only).
 * Anything not listed here stays server-private.
 */
export interface PublicFeatureFlags {
  // Derived from instance experimental settings.
  enableEnvironments: boolean;
  enableIsolatedWorkspaces: boolean;
  enableApps: boolean;
  enablePipelines: boolean;
  enableCases: boolean;
  enableConferenceRoomChat: boolean;
  enableTaskWatchdogs: boolean;
  enableIssuePlanDecompositions: boolean;
  enableExperimentalFileViewer: boolean;
  enableCloudSync: boolean;
  enableExternalObjects: boolean;
  enableSmokeLab: boolean;
  enableBuiltInAgents: boolean;
  enableDecisions: boolean;
  enableGoalsSidebarLink: boolean;
  enableServerInfoDebugView: boolean;
  cloudBilling: boolean;
  cloudTrialBanner: boolean;
  // Derived from instance general settings / instance defaults. These ride
  // the capabilities payload because the /instance/settings reads that used
  // to serve them are instance-admin-only as of PR-1.
  keyboardShortcuts: boolean;
  censorUsernameInLogs: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  executionMode: InstanceExecutionMode;
  defaultEnvironmentId: string | null;
}

/**
 * Effective company standing (PR-3 contract, defined in PR-1).
 * PR-1 always returns an empty `companyStandings` map.
 */
export type EffectiveStanding = {
  status: "active" | "grace" | "blocked";
  reason?: string;
  message?: string;
  actionUrl?: string;
};

export interface BoardCapabilities {
  /** Company surfaces the caller may use. Full list for instance admins. */
  exposedSurfaces: CompanySettingsSurface[];
  features: PublicFeatureFlags;
  /** Keyed by company id. Empty until PR-3 populates it. */
  companyStandings: Record<string, EffectiveStanding>;
}

export function derivePublicFeatureFlags(input: {
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  defaultEnvironmentId: string | null;
}): PublicFeatureFlags {
  const { general, experimental, defaultEnvironmentId } = input;
  return {
    enableEnvironments: experimental.enableEnvironments === true,
    enableIsolatedWorkspaces: experimental.enableIsolatedWorkspaces === true,
    enableApps: experimental.enableApps === true,
    enablePipelines: experimental.enablePipelines === true,
    enableCases: experimental.enableCases === true,
    enableConferenceRoomChat: experimental.enableConferenceRoomChat === true,
    enableTaskWatchdogs: experimental.enableTaskWatchdogs === true,
    enableIssuePlanDecompositions: experimental.enableIssuePlanDecompositions === true,
    enableExperimentalFileViewer: experimental.enableExperimentalFileViewer === true,
    enableCloudSync: experimental.enableCloudSync === true,
    enableExternalObjects: experimental.enableExternalObjects === true,
    enableSmokeLab: experimental.enableSmokeLab === true,
    enableBuiltInAgents: experimental.enableBuiltInAgents === true,
    enableDecisions: experimental.enableDecisions === true,
    enableGoalsSidebarLink: experimental.enableGoalsSidebarLink === true,
    enableServerInfoDebugView: experimental.enableServerInfoDebugView === true,
    cloudBilling: experimental.cloudBilling === true,
    cloudTrialBanner: experimental.cloudTrialBanner === true,
    keyboardShortcuts: general.keyboardShortcuts === true,
    censorUsernameInLogs: general.censorUsernameInLogs === true,
    feedbackDataSharingPreference: general.feedbackDataSharingPreference,
    executionMode: general.executionMode ?? "any",
    defaultEnvironmentId,
  };
}
