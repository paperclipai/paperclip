import { describe, expect, it } from "vitest";
import {
  instanceExperimentalSettingsSchema,
  instanceGeneralSettingsSchema,
} from "../validators/instance.js";
import { derivePublicFeatureFlags, type EffectiveStanding } from "./capabilities.js";

const defaultGeneral = instanceGeneralSettingsSchema.parse({});
const defaultExperimental = instanceExperimentalSettingsSchema.parse({});

describe("derivePublicFeatureFlags", () => {
  it("derives the full allowlist with safe defaults", () => {
    expect(
      derivePublicFeatureFlags({
        general: defaultGeneral,
        experimental: defaultExperimental,
        defaultEnvironmentId: null,
      }),
    ).toEqual({
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
      cloudBilling: defaultExperimental.cloudBilling,
      cloudTrialBanner: defaultExperimental.cloudTrialBanner,
      keyboardShortcuts: false,
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: defaultGeneral.feedbackDataSharingPreference,
      executionMode: "any",
      defaultEnvironmentId: null,
    });
  });

  it("passes through enabled flags and instance defaults", () => {
    const flags = derivePublicFeatureFlags({
      general: { ...defaultGeneral, keyboardShortcuts: true, executionMode: "kubernetes" },
      experimental: { ...defaultExperimental, enableEnvironments: true, enableCases: true },
      defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(flags.enableEnvironments).toBe(true);
    expect(flags.enableCases).toBe(true);
    expect(flags.keyboardShortcuts).toBe(true);
    expect(flags.executionMode).toBe("kubernetes");
    expect(flags.defaultEnvironmentId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("never leaks non-allowlisted experimental fields", () => {
    const flags = derivePublicFeatureFlags({
      general: defaultGeneral,
      experimental: { ...defaultExperimental, enableWorktreeRunExecution: true },
      defaultEnvironmentId: null,
    });
    expect("enableWorktreeRunExecution" in flags).toBe(false);
    expect("worktreeRunExecutionActivatedAt" in flags).toBe(false);
    expect("enableIssueGraphLivenessAutoRecovery" in flags).toBe(false);
  });

  it("EffectiveStanding type-checks the PR-3 contract shape", () => {
    const standing: EffectiveStanding = {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed",
      actionUrl: "/billing",
    };
    expect(standing.status).toBe("blocked");
  });
});
