import type { BoardCapabilities, PublicFeatureFlags } from "@paperclipai/shared";
import { COMPANY_SETTINGS_SURFACES } from "@paperclipai/shared";
import type { CurrentBoardAccess } from "@/api/access";

export const DEFAULT_PUBLIC_FEATURES: PublicFeatureFlags = {
  enableEnvironments: false,
  enableIsolatedWorkspaces: false,
  enableApps: false,
  enablePipelines: false,
  enableCases: false,
  enableConferenceRoomChat: false,
  enableTaskWatchdogs: false,
  enableIssuePlanDecompositions: false,
  enableExperimentalFileViewer: false,
  enableCloudSync: false,
  enableExternalObjects: false,
  enableSmokeLab: false,
  enableBuiltInAgents: false,
  enableDecisions: false,
  enableGoalsSidebarLink: false,
  enableServerInfoDebugView: false,
  cloudBilling: false,
  cloudTrialBanner: false,
  keyboardShortcuts: false,
  censorUsernameInLogs: false,
  feedbackDataSharingPreference: "prompt",
  executionMode: "any",
  defaultEnvironmentId: null,
};

export function buildCurrentBoardAccess(overrides?: {
  isInstanceAdmin?: boolean;
  exposedSurfaces?: BoardCapabilities["exposedSurfaces"];
  features?: Partial<PublicFeatureFlags>;
  companyIds?: string[];
  memberships?: CurrentBoardAccess["memberships"];
}): CurrentBoardAccess {
  return {
    user: { id: "user-1", email: "user@example.com", name: "User One", image: null },
    userId: "user-1",
    isInstanceAdmin: overrides?.isInstanceAdmin ?? false,
    companyIds: overrides?.companyIds ?? ["company-1"],
    memberships:
      overrides?.memberships ??
      [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    source: "session",
    keyId: null,
    cloudStack: null,
    capabilities: {
      exposedSurfaces: overrides?.exposedSurfaces ?? [...COMPANY_SETTINGS_SURFACES],
      features: { ...DEFAULT_PUBLIC_FEATURES, ...overrides?.features },
      companyStandings: {},
    },
  };
}
