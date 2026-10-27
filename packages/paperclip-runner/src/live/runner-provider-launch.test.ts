import { describe, expect, it } from "vitest";
import { createRunnerProviderLaunch, preparedRunnerLaunchWorkingDirectory, runnerLaunchRequirementsDigest, validatePreparedRunnerLaunch,
  runnerProviderLaunchRequirements, type RunnerProviderLaunchEnvironment, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";

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
  it("binds disabled hosted search to the prepared launch and overrides execution-host arguments", () => {
    const disabled = runnerProviderLaunchRequirements({ provider: "codex", disableCodexWebSearch: true },
      requirements.identity, { model: requirements.model }, null, "");
    expect(disabled.settings).toHaveProperty("disableCodexWebSearch", true);
    expect(runnerLaunchRequirementsDigest(disabled)).not.toBe(runnerLaunchRequirementsDigest({ ...disabled, settings: {} }));
    const launch = createRunnerProviderLaunch(disabled, { ...environment,
      options: { codexArgs: ["-c", 'web_search="live"', "app-server"] } });
    expect(launch.args).toEqual(["-c", 'web_search="live"', "-c", 'web_search="disabled"', "app-server"]);
    const prepared = { configurationId: "search-policy", requirementsDigest: runnerLaunchRequirementsDigest(disabled), provider: launch };
    expect(() => validatePreparedRunnerLaunch(disabled, prepared)).not.toThrow();
    expect(() => validatePreparedRunnerLaunch(disabled, { ...prepared,
      provider: { ...launch, args: ["app-server"] } })).toThrow("runner_prepared_launch_requirements_mismatch");
    for (const leading of ["--", "--search", "--search=true"]) {
      expect(() => createRunnerProviderLaunch(disabled, { ...environment,
        options: { codexArgs: [leading, "app-server"] } })).toThrow("runner_codex_web_search_policy_override");
      expect(() => validatePreparedRunnerLaunch(disabled, { ...prepared,
        provider: { ...launch, args: [leading, ...launch.args as string[]] } })).toThrow("runner_prepared_launch_requirements_mismatch");
    }
    expect(() => validatePreparedRunnerLaunch(disabled, { ...prepared,
      provider: { ...launch, args: ["--", ...launch.args as string[]] } })).toThrow("runner_prepared_launch_requirements_mismatch");
    for (const tail of [["-c", 'web_search="live"'], ['-cweb_search="live"'], ["--search"], ['--config=web_search="live"'], ["--"]]) {
      expect(() => createRunnerProviderLaunch(disabled, { ...environment,
        options: { codexArgs: ["app-server", ...tail] } })).toThrow("runner_codex_web_search_policy_override");
      expect(() => validatePreparedRunnerLaunch(disabled, { ...prepared,
        provider: { ...launch, args: [...launch.args as string[], ...tail] } })).toThrow("runner_prepared_launch_requirements_mismatch");
    }

  });

  it.each([undefined, false])("preserves default hosted search when disable is %s", disableCodexWebSearch => {
    const request = runnerProviderLaunchRequirements({ provider: "codex", disableCodexWebSearch },
      requirements.identity, { model: requirements.model }, null, "");
    const launch = createRunnerProviderLaunch(request, environment);
    expect(launch.args).toEqual(["app-server"]);
  });

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

  it("preserves exact Copilot requirements and launch descriptors when Codex search disabling is absent or false", () => {
    const selected = { provider: "acpx" as const, acpxAgent: "copilot" as const, acpxPermissionMode: "deny-all" as const };
    const params = { model: "gpt-5.6-luna", approvalPolicy: "never", permissions: "paperclip-runner-workspace-read-only" };
    const baseline = runnerProviderLaunchRequirements(selected, requirements.identity, params, null, "Copilot policy");
    const scopedProbe = runnerProviderLaunchRequirements({ ...selected, disableCodexWebSearch: false },
      requirements.identity, params, null, "Copilot policy");
    expect(scopedProbe).toEqual(baseline);
    expect(runnerLaunchRequirementsDigest(scopedProbe)).toBe(runnerLaunchRequirementsDigest(baseline));
    expect(createRunnerProviderLaunch(scopedProbe, environment)).toEqual(createRunnerProviderLaunch(baseline, environment));
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

  it.each(["codex", "opencode", "acpx"] as const)("accepts only a normalized absolute %s prepared cwd", provider => {
    const selected = provider === "acpx"
      ? { ...requirements, provider, model: "claude-selected", settings: { acpxAgent: "claude" as const } }
      : { ...requirements, provider };
    const prepared = (cwd: unknown) => ({ configurationId: "prepared", requirementsDigest: runnerLaunchRequirementsDigest(selected),
      provider: { ...createRunnerProviderLaunch(selected, environment), cwd } });
    for (const cwd of ["/home/agent", "/projects/repository/worktrees/workspace"]) {
      expect(() => validatePreparedRunnerLaunch(selected, prepared(cwd))).not.toThrow();
      expect(preparedRunnerLaunchWorkingDirectory(prepared(cwd))).toBe(cwd);
    }
    for (const cwd of [undefined, "", "home/agent", "/", "/home/agent/../root", "/home/\0agent"]) {
      expect(() => validatePreparedRunnerLaunch(selected, prepared(cwd)))
        .toThrow("runner_prepared_launch_working_directory_invalid");
    }
  });
});
