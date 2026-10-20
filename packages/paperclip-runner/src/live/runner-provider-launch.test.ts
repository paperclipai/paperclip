import { describe, expect, it } from "vitest";
import { createRunnerProviderLaunch, type RunnerProviderLaunchEnvironment, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";

const requirements: RunnerProviderLaunchRequirements = {
  schema: "paperclip.runner.launch-requirements.v1",
  identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
    normalizedSessionId: "session", turnId: "turn", itemId: "item" },
  provider: "codex", model: "selected-model", approvalPolicy: "on-request",
  instructions: "Follow the assigned instructions.", runtimeContext: null,
  readOnly: true, preparedConversation: false, includeCollaborationModeInstructions: false,
  settings: {},
};
const environment: RunnerProviderLaunchEnvironment = {
  options: { codexArgs: ["app-server"] }, root: "/execution/state", cwd: "/execution/workspace",
  codexHome: "/execution/home/.codex", providerNodeCommand: "/runtime/node",
  codexCommand: "/runtime/codex", opencodeProxyPath: "/runtime/opencode-proxy.cjs",
  acpxSidecarPath: "/runtime/acpx-sidecar.cjs",
};

describe("built-in provider launch preparation", () => {
  it("keeps Core's selection and policy when the execution environment changes", () => {
    const before = structuredClone(requirements);
    const local = createRunnerProviderLaunch(requirements, environment);
    const remote = createRunnerProviderLaunch(requirements, { ...environment,
      cwd: "/guest/project", codexCommand: "/guest/bin/codex" });
    expect(local).toMatchObject({ model: "selected-model", approvalPolicy: "on-request",
      readOnly: true, collaborationMode: "plan", instructions: requirements.instructions });
    expect(remote).toEqual({ ...local, cwd: "/guest/project", command: "/guest/bin/codex" });
    expect(requirements).toEqual(before);
  });

  it("preserves the ACPX profile, run identity, and permission policy", () => {
    const launch = createRunnerProviderLaunch({ ...requirements, provider: "acpx",
      model: "claude-selected", settings: { acpxAgent: "claude", acpxPermissionMode: "deny-all" } }, environment);
    expect(launch).toMatchObject({ kind: "acpx", agent: "claude", model: "claude-selected",
      sidecarCommand: "/runtime/node", sidecarArgs: ["/runtime/acpx-sidecar.cjs"],
      runId: "run", normalizedSessionId: "session", permissionMode: "deny-all",
      permissionModePinned: true, providerPolicy: { readOnly: true },
      instructions: requirements.instructions });
    expect(launch.commandDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("keeps the OpenCode facade shape and prepared conversation mode", () => {
    expect(createRunnerProviderLaunch({ ...requirements, provider: "opencode", preparedConversation: true }, environment))
      .toMatchObject({ kind: "opencode", driver: "opencode_server", command: "/runtime/node",
        args: ["/runtime/opencode-proxy.cjs"], conversationMode: "prepared", collaborationMode: "plan" });
    expect(createRunnerProviderLaunch({ ...requirements, provider: "opencode" }, environment))
      .not.toHaveProperty("readOnly");
  });

  it("uses the existing permission builder when the environment supplies no argument override", () => {
    const launch = createRunnerProviderLaunch(requirements, { ...environment,
      options: { environment: { HOME: "/execution/home" } } });
    expect(launch.args).toEqual(expect.arrayContaining(["app-server"]));
    expect(JSON.stringify(launch.args)).toContain("paperclip-runner-workspace-read-only");
  });

  it("rejects missing managed profiles before provider launch", () => {
    expect(() => createRunnerProviderLaunch({ ...requirements, provider: "claude_managed" }, environment))
      .toThrow("requires a qualified managed profile");
    expect(() => createRunnerProviderLaunch({ ...requirements, provider: "aws_agentcore" }, environment))
      .toThrow("requires a qualified AgentCore profile");
  });
});
