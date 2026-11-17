import { createHash } from "node:crypto";
import { canonicalNativeRuntimeContextDigest, composeNativeSystemInstructions, NATIVE_RUNTIME_ASSET_SCHEMA } from "../contracts/runtime-context.js";
import { describe, expect, it } from "vitest";
import { bindRunnerLaunchResources, createRunnerProviderLaunch, runnerLaunchPreparationDigest, runnerLaunchRequirementsDigest, runnerLaunchRunDigest, runnerProviderLaunchRequirements,
  validatePreparedRunnerLaunch, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";

const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
  normalizedSessionId: "session", turnId: "turn", itemId: "item" };
const requirements = () => runnerProviderLaunchRequirements({ provider: "codex" }, identity,
  { model: "selected", permissions: "paperclip-runner-workspace-read-only", approvalPolicy: "on-request" }, null, "Core instructions");
const prepare = (request = requirements()) => ({ configurationId: "configuration-1",
  requirementsDigest: runnerLaunchRequirementsDigest(request),
  provider: createRunnerProviderLaunch(request, { options: { codexArgs: ["app-server"] },
    root: "/guest/state", cwd: "/guest/workspace", codexHome: "/guest/home/.codex",
    providerNodeCommand: "/guest/node", codexCommand: "/guest/codex",
    opencodeProxyPath: "/guest/opencode.cjs", acpxSidecarPath: "/guest/acpx.cjs" }),
});

describe("environment-owned launch contract", () => {
  it("does not send process callbacks, host secrets, or executable choices in the requirements", () => {
    const request = runnerProviderLaunchRequirements({ provider: "codex", environment: { OPENAI_API_KEY: "fixture-credential" },
      codexCommand: "/controller/executable", runnerProcessLauncher: () => { throw new Error("unused"); } },
    identity, { model: "selected" }, null, "Core instructions");
    expect(JSON.stringify(request)).not.toContain("fixture-credential");
    expect(JSON.stringify(request)).not.toContain("/controller/executable");
    expect(request.settings).not.toHaveProperty("runnerProcessLauncher");
  });

  it("accepts a descriptor with execution-host paths and the exact Core policy", () => {
    const request = requirements();
    expect(() => validatePreparedRunnerLaunch(request, prepare(request))).not.toThrow();
  });

  it("hashes equivalent JSON independently of property order", () => {
    const request = requirements();
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as unknown as RunnerProviderLaunchRequirements;
    expect(runnerLaunchRequirementsDigest(reordered)).toBe(runnerLaunchRequirementsDigest(request));
    expect(runnerLaunchRequirementsDigest({ ...request, identity: { ...identity, runId: "other" } }))
      .not.toBe(runnerLaunchRequirementsDigest(request));
  });

  it.each([
    ["request binding", { requirementsDigest: `sha256:${"a".repeat(64)}` }],
    ["provider", { provider: { ...prepare().provider, kind: "acpx" } }],
    ["unassigned runtime context", { provider: { ...prepare().provider, runtimeContext: {} } }],
    ["model", { provider: { ...prepare().provider, model: "other" } }],
    ["read-only policy", { provider: { ...prepare().provider, readOnly: false } }],
    ["approval policy", { provider: { ...prepare().provider, approvalPolicy: "never" } }],
  ])("rejects a changed %s", (_name, update) => {
    expect(() => validatePreparedRunnerLaunch(requirements(), { ...prepare(), ...update }))
      .toThrow("runner_prepared_launch_requirements_mismatch");
  });

  it("binds only registered resource framing and preserves literal instruction content", () => {
    const zero = "0".repeat(64);
    const value = {
      prompt: { revision: "fixture", text: "Core policy", digest: createHash("sha256").update("Core policy").digest("hex") },
      instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        rootPath: "/controller/instructions", digest: zero, manifestDigest: zero, fileCount: 1, totalBytes: 1 } },
      skills: [{ key: "assigned", runtimeName: "assigned", versionId: "v1", bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA, rootPath: "/controller/skill", digest: zero, manifestDigest: zero, fileCount: 1, totalBytes: 1 } }],
      mcp: { assignmentSetId: "assigned", digest: zero, bindingId: "current-binding" },
    };
    const context = { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
    const request = { ...requirements(), runtimeContext: context,
      instructions: composeNativeSystemInstructions(context, "A historical example: /controller/instructions") };
    const target = structuredClone(context);
    target.instructions.bundle.rootPath = "/guest/.agents";
    target.skills[0]!.bundle.rootPath = "/guest/.agents/skills/assigned";
    const bound = bindRunnerLaunchResources(request, target);
    expect(bound.instructions).toContain("Read-only instruction sibling root: /guest/.agents");
    expect(bound.instructions).toContain("A historical example: /controller/instructions");
    expect(bound.runtimeContext?.skills[0]?.bundle.rootPath).toBe("/guest/.agents/skills/assigned");
    const prepared = { ...prepare(bound), requirementsDigest: runnerLaunchRequirementsDigest(request) };
    expect(() => validatePreparedRunnerLaunch(request, prepared)).not.toThrow();
    expect(() => validatePreparedRunnerLaunch(request, { ...prepared,
      provider: { ...prepared.provider, instructions: "Core policy" } })).toThrow();
    const changed = structuredClone(target); changed.mcp.bindingId = "other-binding";
    expect(() => bindRunnerLaunchResources(request, changed)).toThrow("assignment_changed");
    expect(() => validatePreparedRunnerLaunch(request, { ...prepared,
      provider: { ...prepared.provider, runtimeContext: changed } })).toThrow();
    const unassigned = structuredClone(target); unassigned.skills[0]!.key = "unassigned";
    unassigned.aggregateDigest = canonicalNativeRuntimeContextDigest(unassigned);
    expect(() => bindRunnerLaunchResources(request, unassigned)).toThrow("assignment_changed");
  });

  it("checks ACPX identity and read-only policy as part of the same contract", () => {
    const request = { ...requirements(), provider: "acpx" as const,
      settings: { acpxAgent: "claude" as const, acpxPermissionMode: "deny-all" as const } };
    const prepared = prepare(request);
    expect(() => validatePreparedRunnerLaunch(request, prepared)).not.toThrow();
    for (const update of [{ runId: "other" }, { normalizedSessionId: "other" }, { permissionMode: "approve-all" },
      { providerPolicy: { readOnly: false } }, { agent: "pi" }]) {
      expect(() => validatePreparedRunnerLaunch(request, { ...prepared, provider: { ...prepared.provider, ...update } }))
        .toThrow("runner_prepared_launch_requirements_mismatch");
    }
  });
});

describe("launch preparation and run digests", () => {
  const nextRun = { ...identity, runId: "next-run", turnId: "next-turn", itemId: "next-item" };
  const withIdentity = (value: typeof identity) => ({ ...requirements(), identity: value });

  it("keeps the preparation digest across runs of one Runner and changes the run digest", () => {
    const first = runnerLaunchPreparationDigest(requirements());
    expect(runnerLaunchPreparationDigest(withIdentity(nextRun))).toBe(first);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toBe(runnerLaunchRequirementsDigest(requirements()));
    const run = runnerLaunchRunDigest(first, withIdentity(identity));
    expect(run).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runnerLaunchRunDigest(first, withIdentity(nextRun))).not.toBe(run);
    expect(runnerLaunchRunDigest(first, withIdentity({ ...identity, itemId: "other-item" }))).not.toBe(run);
    expect(runnerLaunchRunDigest(first, withIdentity(identity))).toBe(run);
  });

  const zero = "0".repeat(64);
  const one = "1".repeat(64);
  type Context = NonNullable<RunnerProviderLaunchRequirements["runtimeContext"]>;
  const baseContext = (): Omit<Context, "aggregateDigest"> => ({
    prompt: { revision: "fixture", text: "Core policy", digest: createHash("sha256").update("Core policy").digest("hex") },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA,
      rootPath: "/controller/instructions", digest: zero, manifestDigest: zero, fileCount: 1, totalBytes: 1 } },
    skills: [{ key: "assigned", runtimeName: "assigned", versionId: "v1", bundle: {
      schema: NATIVE_RUNTIME_ASSET_SCHEMA, rootPath: "/controller/skill", digest: zero, manifestDigest: zero, fileCount: 1, totalBytes: 1 } }],
    mcp: { assignmentSetId: "assigned", digest: zero, bindingId: "native-mcp:run" },
  });
  const withContext = (value: typeof identity, change: (context: Omit<Context, "aggregateDigest">) => void = () => {}): RunnerProviderLaunchRequirements => {
    const context = baseContext();
    change(context);
    return { ...requirements(), identity: value, runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) } };
  };

  // MCP reaches the Runner through Core's tool authority on every run attachment, never through files the environment
  // publishes, and Core keeps a warm session across an MCP-only change. So MCP belongs to the run digest only.
  it("keeps the preparation digest across warm runs whose runtime context changes only in MCP", () => {
    const first = withContext(identity);
    const digest = runnerLaunchPreparationDigest(first);
    const mcpChanges: Array<[string, RunnerProviderLaunchRequirements]> = [
      ["the run's binding", withContext(nextRun, context => { context.mcp.bindingId = "native-mcp:next-run"; })],
      ["no binding", withContext(nextRun, context => { context.mcp.bindingId = null; })],
      ["the assigned access set", withContext(nextRun, context => { context.mcp = { assignmentSetId: "other-set", digest: one, bindingId: "native-mcp:next-run" }; })],
    ];
    for (const [label, next] of mcpChanges) {
      expect(runnerLaunchPreparationDigest(next), label).toBe(digest);
      expect(runnerLaunchRunDigest(digest, next), label).not.toBe(runnerLaunchRunDigest(digest, first));
    }
    // Within one run, an MCP change still changes the run digest.
    const sameRun = withContext(identity, context => { context.mcp.assignmentSetId = "other-set"; });
    expect(runnerLaunchRunDigest(digest, sameRun)).not.toBe(runnerLaunchRunDigest(digest, first));
  });

  it.each([
    ["instruction bundle", (context: Omit<Context, "aggregateDigest">) => { context.instructions.bundle.digest = one; }],
    ["instruction entry", (context: Omit<Context, "aggregateDigest">) => { context.instructions.entryPath = "CLAUDE.md"; }],
    ["skill bundle", (context: Omit<Context, "aggregateDigest">) => { context.skills[0]!.bundle.digest = one; }],
    ["skill set", (context: Omit<Context, "aggregateDigest">) => { context.skills = []; }],
    ["instruction working copy", (context: Omit<Context, "aggregateDigest">) => {
      context.instructions.workingCopy = { rootPath: "/workspace/.paperclip-runtime/agent-files/agent/run", entryPath: "AGENTS.md", kind: "agent_files" }; }],
    ["connection instructions", (context: Omit<Context, "aggregateDigest">) => { context.connectionInstructions = { text: "Use the connector.", digest: one }; }],
  ])("changes the preparation digest when the %s changes", (_label, change) => {
    expect(runnerLaunchPreparationDigest(withContext(identity, change))).not.toBe(runnerLaunchPreparationDigest(withContext(identity)));
  });

  it.each([
    ["runner instance", withIdentity({ ...identity, runnerInstanceId: "other-runner" })],
    ["environment lease", withIdentity({ ...identity, environmentLeaseId: "other-lease" })],
    ["session", withIdentity({ ...identity, normalizedSessionId: "other-session" })],
    ["instructions", { ...requirements(), instructions: "Changed instructions" }],
    ["model", { ...requirements(), model: "other-model" }],
    ["approval policy", { ...requirements(), approvalPolicy: "never" as const }],
    ["settings", { ...requirements(), settings: { ...requirements().settings, disableCodexWebSearch: true } }],
  ])("changes the preparation digest when the %s changes", (_label, changed) => {
    const before = runnerLaunchPreparationDigest(requirements());
    const after = runnerLaunchPreparationDigest(changed as RunnerProviderLaunchRequirements);
    expect(after).not.toBe(before);
    expect(runnerLaunchRunDigest(after, withIdentity(identity))).not.toBe(runnerLaunchRunDigest(before, withIdentity(identity)));
  });
});
