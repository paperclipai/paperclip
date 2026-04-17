import { describe, it, expect } from "vitest";
import {
  parseProjectExecutionWorkspacePolicy,
  gateProjectExecutionWorkspacePolicy,
  parseIssueExecutionWorkspaceSettings,
  defaultIssueExecutionWorkspaceSettingsForProject,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";

// ---------------------------------------------------------------------------
// gateProjectExecutionWorkspacePolicy
// ---------------------------------------------------------------------------

describe("gateProjectExecutionWorkspacePolicy", () => {
  const policy = { enabled: true };

  it("returns null when isolatedWorkspacesEnabled is false", () => {
    expect(gateProjectExecutionWorkspacePolicy(policy, false)).toBeNull();
  });

  it("returns the policy when isolatedWorkspacesEnabled is true", () => {
    expect(gateProjectExecutionWorkspacePolicy(policy, true)).toBe(policy);
  });

  it("returns null for a null policy regardless of flag", () => {
    expect(gateProjectExecutionWorkspacePolicy(null, true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// issueExecutionWorkspaceModeForPersistedWorkspace
// ---------------------------------------------------------------------------

describe("issueExecutionWorkspaceModeForPersistedWorkspace", () => {
  it("returns 'agent_default' for null input", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(null)).toBe("agent_default");
  });

  it("returns 'agent_default' for undefined input", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(undefined)).toBe("agent_default");
  });

  it("returns 'isolated_workspace' for 'isolated_workspace'", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("isolated_workspace")).toBe("isolated_workspace");
  });

  it("returns 'operator_branch' for 'operator_branch'", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("operator_branch")).toBe("operator_branch");
  });

  it("returns 'shared_workspace' for 'shared_workspace'", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("shared_workspace")).toBe("shared_workspace");
  });

  it("returns 'agent_default' for 'adapter_managed'", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("adapter_managed")).toBe("agent_default");
  });

  it("returns 'agent_default' for 'cloud_sandbox'", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("cloud_sandbox")).toBe("agent_default");
  });

  it("returns 'shared_workspace' for an unrecognized mode string", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("unknown_mode")).toBe("shared_workspace");
  });
});

// ---------------------------------------------------------------------------
// defaultIssueExecutionWorkspaceSettingsForProject
// ---------------------------------------------------------------------------

describe("defaultIssueExecutionWorkspaceSettingsForProject", () => {
  it("returns null when policy is null", () => {
    expect(defaultIssueExecutionWorkspaceSettingsForProject(null)).toBeNull();
  });

  it("returns null when policy.enabled is false", () => {
    expect(defaultIssueExecutionWorkspaceSettingsForProject({ enabled: false })).toBeNull();
  });

  it("returns 'isolated_workspace' mode when policy defaultMode is 'isolated_workspace'", () => {
    const result = defaultIssueExecutionWorkspaceSettingsForProject({
      enabled: true,
      defaultMode: "isolated_workspace",
    });
    expect(result?.mode).toBe("isolated_workspace");
  });

  it("returns 'operator_branch' mode when policy defaultMode is 'operator_branch'", () => {
    const result = defaultIssueExecutionWorkspaceSettingsForProject({
      enabled: true,
      defaultMode: "operator_branch",
    });
    expect(result?.mode).toBe("operator_branch");
  });

  it("returns 'agent_default' mode when policy defaultMode is 'adapter_default'", () => {
    const result = defaultIssueExecutionWorkspaceSettingsForProject({
      enabled: true,
      defaultMode: "adapter_default",
    });
    expect(result?.mode).toBe("agent_default");
  });

  it("returns 'shared_workspace' mode for 'shared_workspace' defaultMode", () => {
    const result = defaultIssueExecutionWorkspaceSettingsForProject({
      enabled: true,
      defaultMode: "shared_workspace",
    });
    expect(result?.mode).toBe("shared_workspace");
  });

  it("returns 'shared_workspace' mode when policy has no defaultMode", () => {
    const result = defaultIssueExecutionWorkspaceSettingsForProject({ enabled: true });
    expect(result?.mode).toBe("shared_workspace");
  });
});

// ---------------------------------------------------------------------------
// resolveExecutionWorkspaceMode
// ---------------------------------------------------------------------------

describe("resolveExecutionWorkspaceMode", () => {
  it("returns 'shared_workspace' when no policy, no issue settings, and no legacy flag", () => {
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: null,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });
    expect(result).toBe("shared_workspace");
  });

  it("uses issue mode when it is an explicit non-inherit value", () => {
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: null,
      issueSettings: { mode: "isolated_workspace" },
      legacyUseProjectWorkspace: null,
    });
    expect(result).toBe("isolated_workspace");
  });

  it("falls through issue mode 'inherit' to project policy", () => {
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "operator_branch" },
      issueSettings: { mode: "inherit" },
      legacyUseProjectWorkspace: null,
    });
    expect(result).toBe("operator_branch");
  });

  it("uses project policy defaultMode when issue settings have no mode", () => {
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });
    expect(result).toBe("isolated_workspace");
  });

  it("returns 'shared_workspace' from enabled project policy with 'shared_workspace' defaultMode", () => {
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });
    expect(result).toBe("shared_workspace");
  });

  it("returns 'agent_default' from enabled project policy with 'adapter_default' defaultMode", () => {
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "adapter_default" },
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });
    expect(result).toBe("agent_default");
  });

  it("returns 'agent_default' when legacy flag is false and no policy or settings", () => {
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: null,
      issueSettings: null,
      legacyUseProjectWorkspace: false,
    });
    expect(result).toBe("agent_default");
  });

  it("project policy overrides the legacy flag", () => {
    // Policy enabled → policy wins over legacyUseProjectWorkspace=false
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
      issueSettings: null,
      legacyUseProjectWorkspace: false,
    });
    expect(result).toBe("shared_workspace");
  });

  it("ignores a disabled project policy (falls through to legacy flag)", () => {
    const result = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: false, defaultMode: "isolated_workspace" },
      issueSettings: null,
      legacyUseProjectWorkspace: false,
    });
    expect(result).toBe("agent_default");
  });
});

// ---------------------------------------------------------------------------
// parseProjectExecutionWorkspacePolicy
// ---------------------------------------------------------------------------

describe("parseProjectExecutionWorkspacePolicy", () => {
  it("returns null for null input", () => {
    expect(parseProjectExecutionWorkspacePolicy(null)).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(parseProjectExecutionWorkspacePolicy({})).toBeNull();
  });

  it("returns a policy with enabled=false by default when only other fields are present", () => {
    const result = parseProjectExecutionWorkspacePolicy({ defaultMode: "shared_workspace" });
    expect(result?.enabled).toBe(false);
  });

  it("parses enabled=true correctly", () => {
    const result = parseProjectExecutionWorkspacePolicy({ enabled: true });
    expect(result?.enabled).toBe(true);
  });

  it("normalizes legacy 'project_primary' defaultMode to 'shared_workspace'", () => {
    const result = parseProjectExecutionWorkspacePolicy({ enabled: true, defaultMode: "project_primary" });
    expect(result?.defaultMode).toBe("shared_workspace");
  });

  it("normalizes legacy 'isolated' defaultMode to 'isolated_workspace'", () => {
    const result = parseProjectExecutionWorkspacePolicy({ enabled: true, defaultMode: "isolated" });
    expect(result?.defaultMode).toBe("isolated_workspace");
  });

  it("passes through 'shared_workspace' defaultMode unchanged", () => {
    const result = parseProjectExecutionWorkspacePolicy({ enabled: true, defaultMode: "shared_workspace" });
    expect(result?.defaultMode).toBe("shared_workspace");
  });

  it("parses allowIssueOverride boolean", () => {
    const result = parseProjectExecutionWorkspacePolicy({ enabled: true, allowIssueOverride: true });
    expect(result?.allowIssueOverride).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseIssueExecutionWorkspaceSettings
// ---------------------------------------------------------------------------

describe("parseIssueExecutionWorkspaceSettings", () => {
  it("returns null for null input", () => {
    expect(parseIssueExecutionWorkspaceSettings(null)).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(parseIssueExecutionWorkspaceSettings({})).toBeNull();
  });

  it("parses 'isolated_workspace' mode", () => {
    const result = parseIssueExecutionWorkspaceSettings({ mode: "isolated_workspace" });
    expect(result?.mode).toBe("isolated_workspace");
  });

  it("normalizes legacy 'isolated' to 'isolated_workspace'", () => {
    const result = parseIssueExecutionWorkspaceSettings({ mode: "isolated" });
    expect(result?.mode).toBe("isolated_workspace");
  });

  it("normalizes legacy 'project_primary' to 'shared_workspace'", () => {
    const result = parseIssueExecutionWorkspaceSettings({ mode: "project_primary" });
    expect(result?.mode).toBe("shared_workspace");
  });

  it("omits mode when input mode is unrecognized", () => {
    const result = parseIssueExecutionWorkspaceSettings({ mode: "unknown_mode" });
    expect(result).not.toHaveProperty("mode");
  });

  it("parses 'inherit' mode", () => {
    const result = parseIssueExecutionWorkspaceSettings({ mode: "inherit" });
    expect(result?.mode).toBe("inherit");
  });
});
