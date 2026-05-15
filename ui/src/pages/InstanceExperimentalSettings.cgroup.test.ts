import { describe, expect, it } from "vitest";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";

function deriveCgroupActive(data: InstanceExperimentalSettings | undefined): boolean {
  return data?.pluginCgroupActive === true;
}

describe("InstanceExperimentalSettings — pluginCgroupActive derivation", () => {
  it("returns false when data is undefined", () => {
    expect(deriveCgroupActive(undefined)).toBe(false);
  });

  it("returns false when pluginCgroupActive is absent", () => {
    const data = {
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
      pluginCgroupDefaults: {},
      pluginCgroupOverrides: {},
    } satisfies InstanceExperimentalSettings;
    expect(deriveCgroupActive(data)).toBe(false);
  });

  it("returns false when pluginCgroupActive is false", () => {
    const data = {
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
      pluginCgroupDefaults: {},
      pluginCgroupOverrides: {},
      pluginCgroupActive: false,
    } satisfies InstanceExperimentalSettings;
    expect(deriveCgroupActive(data)).toBe(false);
  });

  it("returns true when pluginCgroupActive is true", () => {
    const data = {
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
      pluginCgroupDefaults: {},
      pluginCgroupOverrides: {},
      pluginCgroupActive: true,
    } satisfies InstanceExperimentalSettings;
    expect(deriveCgroupActive(data)).toBe(true);
  });
});
