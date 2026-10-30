import { QUALIFIED_ACPX_PROFILES, resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as codexSecurity from "../drivers/codex/codex-security-config.js";

import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInput } from "../contracts/native-execution.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION, nativeRuntimePromptDigest, canonicalNativeRuntimeContextDigest, composeNativeSystemInstructions } from "../contracts/runtime-context.js";

const contextRoots: string[] = [];
afterEach(() => { for (const root of contextRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function preparedExecution(base: NativeExecutionInput, version: "v5" | "v7" | "v9" = "v5"): NativeExecutionInput {
  const root = mkdtempSync(join(tmpdir(), "paperclip-prepared-backend-"));
  contextRoots.push(root);
  writeFileSync(join(root, "AGENTS.md"), "Keep assigned instructions.");
  const digest = "0".repeat(64);
  const context = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: root, fileCount: 1, totalBytes: 27 } },
    skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null },
  };
  return parseNativeExecutionInput({
    ...base, schema: `paperclip.native-execution-input.${version}`, ...(version === "v5" ? {} : { homeMode: "isolated" }), executionMode: "default", planningContext: null,
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
    completionContract: { ...base.completionContract, contract: { ...base.completionContract.contract, criteria: [{ id: "objective", requirement: "Complete the task." }] } },
  });
}
import {
  FakeCodexTransport,
  WORKSPACE,
} from "../drivers/codex/codex-app-server-driver.test-support.js";
import { createNativeSessionBackend } from "../index.js";
import { createCodexNativeSessionBackend, createRunnerdNativeSessionBackend } from "./codex-native-backend.js";
import { createOpenCodeNativeSessionBackend } from "./opencode-native-backend.js";

function execution(
  provider: NativeExecutionInput["provider"] = {
    kind: "codex",
    model: null,
    approvalPolicy: "never",
  },
): NativeExecutionInput {
  return {
    schema: "paperclip.native-execution-input.v1",
    binding: {
      companyId: "company",
      runId: "run",
      issueId: "issue",
      agentId: "agent",
      executionWorkspaceId: "workspace",
    },
    task: {
      identifier: "PAP-1",
      title: "Exercise Codex native routing",
      description: null,
      prompt: "Complete the task.",
      workMode: "standard",
    },
    workspace: {
      cwd: "/workspace",
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId: "session",
      driverKind: "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider,
    completionContract: {
      id: "contract",
      sha256: "sha256",
      schemaVersion: "1",
      contract: {
        revision: "revision",
        objective: "Complete the task.",
        criteria: [],
      },
    },
    interactionResponses: [],
    credentialBindings: [],
  };
}

function acpxExecution(
  agent: "codex" | "pi" | "claude" = "codex",
): NativeExecutionInput {
  return {
    ...execution(),
    session: {
      normalizedSessionId: "session",
      driverKind: "acpx_runtime",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: {
      kind: "acpx",
      agent,
      model: "explicit-test-model",
      permissionPolicy: "interactive",
      profile: resolveQualifiedAcpxProfile(agent, "explicit-test-model"),
    },
  };
}

function opencodeExecution(): NativeExecutionInput {
  return {
    ...execution(),
    session: {
      normalizedSessionId: "session",
      driverKind: "opencode_server",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: {
      kind: "opencode",
      model: "openrouter/model",
      permissionMode: "allow",
    },
  };
}

function planningExecution(input: NativeExecutionInput): NativeExecutionInput {
  return {
    ...input,
    schema: "paperclip.native-execution-input.v2",
    task: { ...input.task, workMode: "planning" },
    executionMode: "plan",
    planningContext: {
      documentId: null,
      baseRevisionId: null,
      baseRevisionNumber: 0,
      markdown: "",
      sha256: "empty-plan",
      reviewContext: {},
    },
  };
}

function managedExecution(
  kind: "claude_managed" | "aws_agentcore",
): NativeExecutionInput {
  if (kind === "claude_managed") {
    return {
      ...execution(),
      session: {
        normalizedSessionId: "session",
        driverKind: "claude_managed_agents_api",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      provider: {
        kind,
        model: "claude-sonnet-5",
        maxSessionListCostUsd: 1,
        managedProfile: {
          profileId: "profile",
          anthropicAgentId: "agent",
          agentVersion: "1",
          environmentId: "environment",
          betaVersion: "managed-agents-2026-04-01",
        },
      },
    };
  }
  return {
    ...execution(),
    session: {
      normalizedSessionId: "session",
      driverKind: "aws_agentcore_harness_api",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: {
      kind,
      model: "global.anthropic.claude-sonnet-4-6",
      maxEstimatedSessionCostUsd: 1,
      invocationLimits: {
        maxIterations: 8,
        maxOutputTokens: 4096,
        timeoutSeconds: 300,
      },
      agentCoreProfile: {
        profileId: "profile",
        region: "us-east-1",
        accountId: "123456789012",
        harnessArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/test",
        harnessVersion: "1",
        endpointArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/test",
        endpointQualifier: "1",
        agentRuntimeArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
        memoryArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test",
        memoryId: "memory",
        invocationRoleArn: "arn:aws:iam::123456789012:role/runner",
        contextBucket: "context-bucket",
        contextPrefix: "companies/company/profiles/profile",
        contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
        qualificationRevision: "aws-agentcore-harness-context-v2",
        eventExpiryDays: 90,
      },
    },
  };
}

describe("native backend factory", () => {
  it.each([undefined, "disabled"] as const)("honors saved webSearch=%s with the default process transport", async webSearch => {
    const input = preparedExecution(execution());
    if (input.provider.kind !== "codex") throw new Error("Codex fixture required");
    if (webSearch) Object.assign(input.provider, { webSearch });
    const buildArgs = codexSecurity.createIsolatedCodexAppServerArgs;
    let generated: string[] | undefined;
    const spy = vi.spyOn(codexSecurity, "createIsolatedCodexAppServerArgs").mockImplementation((...args) => {
      generated = buildArgs(...args);
      throw new Error("offline-stop-before-process-spawn");
    });
    try {
      const backend = createNativeSessionBackend(input, { environment: {} });
      await expect(backend.openSession({ identity: { runId: "run", sessionId: "session", companyId: "company", agentId: "agent" },
        workingDirectory: WORKSPACE })).rejects.toThrow("offline-stop-before-process-spawn");
      expect(generated).toBeDefined();
      if (webSearch) expect(generated?.slice(-3)).toEqual(["-c", 'web_search="disabled"', "app-server"]);
      else expect(generated).not.toContain('web_search="disabled"');
    } finally { spy.mockRestore(); }
  });

  it("constructs the Codex backend without starting its transport", async () => {
    const backend = createNativeSessionBackend(execution(), {
      codexTransportFactory: () => {
        throw new Error("descriptor must not launch the transport");
      },
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "codex_app_server",
      version: "codex-v2",
      capabilities: {
        collaborationModes: ["default", "plan"],
      },
    });
  });

  it.each(["on-request", "untrusted"] as const)(
    "rejects the unqualified native Codex %s approval mode",
    (approvalPolicy) => {
      expect(() =>
        createNativeSessionBackend(
          execution({ kind: "codex", model: null, approvalPolicy }),
          {
            codexTransportFactory: () => {
              throw new Error("transport must not launch");
            },
          },
        ),
      ).toThrow("set codexPermissionMode to never");
    },
  );

  it("requires an explicit runtime root for OpenCode", () => {
    expect(() => createNativeSessionBackend(opencodeExecution())).toThrow(
      "OpenCode native backend requires an instance runtime directory",
    );
  });

  it("routes OpenCode through runnerd when a durable transport is supplied", async () => {
    const backend = createNativeSessionBackend(opencodeExecution(), {
      codexTransportFactory: () => {
        throw new Error("descriptor must not launch the transport");
      },
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "opencode_server",
      version: "1.18.34",
      capabilities: {
        steering: false,
        resume: true,
        interruption: true,
        dynamicTools: true,
        toolRefreshOnResume: true,
        collaborationModes: ["default", "plan"],
      },
    });
  });

  it("defers remote ACPX workspace admission to the runner filesystem", async () => {
    const remoteWorkspace = "/home/daytona/paperclip-workspace";
    const transport = new FakeCodexTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params) => {
      const response = await request(method, params);
      if (method !== "thread/start" && method !== "thread/resume") {
        return response;
      }
      return {
        ...response,
        cwd: remoteWorkspace,
        thread: {
          ...(response.thread as Record<string, unknown>),
          cwd: remoteWorkspace,
        },
      };
    };
    const backend = createNativeSessionBackend(acpxExecution("claude"), {
      codexTransportFactory: () => transport,
      workingDirectoryAuthority: "remote_runner",
      environment: {
        HOME: remoteWorkspace,
        CODEX_HOME: `${remoteWorkspace}/.codex`,
        PAPERCLIP_WORKSPACE_CWD: remoteWorkspace,
      },
    });

    const session = await backend.openSession({
      identity: {
        runId: "run",
        sessionId: "session",
        companyId: "company",
        issueId: "issue",
        agentId: "agent",
      },
      workingDirectory: remoteWorkspace,
    });

    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({ cwd: remoteWorkspace });
    await session.close({ reason: "test complete" });
  });

  it("supplies freshly composed instructions before the transport can read a recovered thread", async () => {
    const prepared = preparedExecution(execution());
    if (!("runtimeContext" in prepared)) throw new Error("fixture requires runtime context");
    const input = { ...acpxExecution("codex"), runtimeContext: prepared.runtimeContext };
    writeFileSync(join(input.runtimeContext.instructions.bundle.rootPath, "AGENTS.md"), "Updated custom entry.");
    const transport = new FakeCodexTransport();
    let captured: string | undefined;
    const backend = createNativeSessionBackend(input, {
      codexTransportFactory: (context) => {
        expect(transport.calls).toHaveLength(0);
        captured = context?.baseInstructions;
        return transport;
      },
      environment: { ...process.env, PAPERCLIP_WORKSPACE_CWD: WORKSPACE },
    });
    const session = await backend.openSession({
      identity: { runId: "run", sessionId: "session", companyId: "company", issueId: "issue", agentId: "agent" },
      workingDirectory: WORKSPACE,
    });
    expect(captured).toBe(composeNativeSystemInstructions(input.runtimeContext, "Updated custom entry."));
    await session.close({ reason: "test complete" });
  });

  describe("runner-prepared launch working directory", () => {
    // The transport reports the prepared directory; it exists only on the VM.
    class PreparedLaunchTransport extends FakeCodexTransport {
      constructor(readonly preparedCwd: unknown) { super(); }
      override async request(method: string, params: Record<string, unknown>) {
        const response = await super.request(method, params);
        if (method === "thread/start" || method === "thread/resume") {
          const { cwd: _cwd, ...rest } = response;
          return this.preparedCwd === undefined ? rest : { ...rest, cwd: this.preparedCwd };
        }
        return response;
      }
    }
    const identity = { runId: "run", sessionId: "session", companyId: "company", agentId: "agent" };
    const providers = [
      ["Codex", execution()],
      ["OpenCode", opencodeExecution()],
      ["ACPX Claude", acpxExecution("claude")],
    ] as const;

    it.each(providers.flatMap(([label, input]) => [
      [label, input, "/home/agent"],
      [label, input, "/projects/0b0e7a4e-8c8e-4b8a-9f3e-0e5d2a6c1f00/worktrees/ws-1"],
    ] as const))("records the %s prepared cwd %s without a Core workspace", async (_label, input, cwd) => {
      const transport = new PreparedLaunchTransport(cwd);
      const backend = createNativeSessionBackend(input, {
        codexTransportFactory: () => transport, workingDirectoryAuthority: "runner_prepared_launch", environment: {},
      });
      const session = await backend.openSession({ identity, workingDirectory: "/controller/caller-choice" });
      const start = transport.calls.find(call => call.method === "thread/start")!.params;
      expect(start).not.toHaveProperty("cwd");
      expect(start).not.toHaveProperty("runtimeWorkspaceRoots");
      const snapshot = await session.snapshot();
      expect(snapshot.workingDirectory).toBe(cwd);
      await session.startTurn({ message: { role: "user", text: "Begin." } });
      expect(transport.calls.find(call => call.method === "turn/start")?.params).toMatchObject({ cwd });
      await session.close({ reason: "test complete" });

      const resumed = new PreparedLaunchTransport(cwd);
      resumed.readResponse = { thread: { id: resumed.threadId, sessionId: resumed.providerSessionId, cwd, turns: [] } };
      const recovered = await createNativeSessionBackend(input, {
        codexTransportFactory: () => resumed, workingDirectoryAuthority: "runner_prepared_launch", environment: {},
      }).recoverSession!({ ...snapshot, activeTurnId: null }, { signal: new AbortController().signal });
      expect(recovered).toMatchObject({ recovered: true });
      if (recovered.recovered) {
        expect((await recovered.session.snapshot()).workingDirectory).toBe(cwd);
        await recovered.session.close({ reason: "test complete" });
      }
    });

    it.each([
      ["missing", undefined, "did not report its provider working directory"],
      ["relative", "home/agent", "normalized absolute path"],
      ["root", "/", "filesystem root"],
      ["unnormalized", "/home/agent/../root", "normalized absolute path"],
    ])("rejects a %s prepared cwd", async (_label, cwd, message) => {
      const transport = new PreparedLaunchTransport(cwd);
      const backend = createNativeSessionBackend(execution(), {
        codexTransportFactory: () => transport, workingDirectoryAuthority: "runner_prepared_launch", environment: {},
      });
      await expect(backend.openSession({ identity, workingDirectory: "/home/agent" })).rejects.toThrow(message);
      expect(transport.calls.some(call => call.method === "turn/start")).toBe(false);
    });

    it.each([
      ["thread read", { read: "/projects/other", resume: "/home/agent", reason: "provider read a different working directory" }],
      ["thread resume", { read: "/home/agent", resume: "/projects/other", reason: "Error: Codex thread response changed the assigned working directory" }],
    ])("does not recover when the %s reports another cwd", async (_label, cwds) => {
      const transport = new PreparedLaunchTransport(cwds.resume);
      transport.readResponse = { thread: { id: transport.threadId, sessionId: transport.providerSessionId, cwd: cwds.read, turns: [] } };
      const backend = createNativeSessionBackend(execution(), {
        codexTransportFactory: () => transport, workingDirectoryAuthority: "runner_prepared_launch", environment: {},
      });
      await expect(backend.recoverSession!({
        schema: "paperclip.native-session.v1", backendKind: "codex_app_server", driverKind: "codex_app_server",
        sessionId: transport.threadId, providerSessionId: transport.providerSessionId, workingDirectory: "/home/agent",
        identity: { ...identity, issueId: "issue" }, activeTurnId: null, terminalTurns: [], lastCursor: null,
      } as never, { signal: new AbortController().signal })).resolves.toEqual({ recovered: false, reason: cwds.reason });
    });

    it("keeps Core-assigned remote directories pinned outside prepared launches", async () => {
      const backend = createNativeSessionBackend(execution(), {
        codexTransportFactory: () => new PreparedLaunchTransport("/home/agent"), workingDirectoryAuthority: "remote_runner", environment: {},
      });
      await expect(backend.openSession({ identity, workingDirectory: "/home/agent" }))
        .rejects.toThrow("Remote Codex working directory requires an assigned workspace");
    });

    it("does not allow prepared launch authority without runnerd", () => {
      expect(() => createNativeSessionBackend(execution(), { workingDirectoryAuthority: "runner_prepared_launch", environment: {} }))
        .toThrow("requires a runnerd transport");
    });
  });

  it("does not allow remote workspace authority without runnerd", () => {
    expect(() =>
      createNativeSessionBackend(execution(), {
        workingDirectoryAuthority: "remote_runner",
        environment: {
          PAPERCLIP_WORKSPACE_CWD: "/home/daytona/paperclip-workspace",
        },
      }),
    ).toThrow("requires a runnerd transport");
  });

  it.each([
    ["OpenCode", opencodeExecution()],
    ["ACPX Codex", acpxExecution("codex")],
    ["ACPX Claude", acpxExecution("claude")],
  ])(
    "opens %s planning runs through the runner-managed plan contract",
    async (_label, input) => {
      const transport = new FakeCodexTransport();
      const backend = createNativeSessionBackend(planningExecution(input), {
        codexTransportFactory: () => transport,
        environment: {
          ...process.env,
          PAPERCLIP_WORKSPACE_CWD: WORKSPACE,
        },
      });

      await expect(backend.descriptor()).resolves.toMatchObject({
        capabilities: { collaborationModes: ["default", "plan"] },
      });
      const session = await backend.openSession({
        identity: {
          runId: "run",
          sessionId: "session",
          companyId: "company",
          issueId: "issue",
          agentId: "agent",
        },
        workingDirectory: WORKSPACE,
      });

      await expect(
        session.startTurn({
          message: { role: "user", text: "Author a plan." },
          requestedCollaborationMode: "plan",
        }),
      ).resolves.toMatchObject({ effectiveCollaborationMode: "plan" });
      expect(
        transport.calls.find((call) => call.method === "thread/start")?.params,
      ).toMatchObject({ permissions: "paperclip-runner-workspace-read-only" });
      expect(
        transport.calls.find((call) => call.method === "turn/start")?.params,
      ).toMatchObject({ collaborationMode: { mode: "plan" } });
      await session.close({ reason: "test complete" });
    },
  );

  it.each([
    [
      "claude_managed" as const,
      "claude_managed_agents_api",
      "managed-agents-2026-04-01",
    ],
    [
      "aws_agentcore" as const,
      "aws_agentcore_harness_api",
      "aws-agentcore-harness-context-v2",
    ],
  ])("routes %s through runnerd", async (kind, name, version) => {
    const backend = createNativeSessionBackend(managedExecution(kind), {
      codexTransportFactory: () => {
        throw new Error("descriptor must not launch the transport");
      },
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name,
      version,
      capabilities: {
        steering: false,
        resume: true,
        interruption: true,
        dynamicTools: true,
      },
    });
  });

  it("constructs the OpenCode backend without starting its process", async () => {
    const backend = createNativeSessionBackend(opencodeExecution(), {
      opencodeRuntimeDirectory: "/runtime",
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "opencode_server",
      version: "1.18.34",
      capabilities: {
        resume: true,
        interruption: true,
        dynamicTools: true,
      },
    });
  });

  it("constructs the qualified Codex ACPX backend without starting ACPX", async () => {
    const backend = createNativeSessionBackend(acpxExecution(), {
      acpxRuntimeDirectory: "/runtime",
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "acpx_runtime",
      version: "0.13.1",
      capabilities: {
        resume: true,
        interruption: true,
        dynamicTools: true,
      },
    });
  });

  it.each(["codex" as const, "claude" as const, "grok" as const])(
    "routes qualified %s ACPX through runnerd",
    async (agent) => {
      const input = acpxExecution();
      if (input.provider.kind !== "acpx") throw new Error("Invalid ACPX fixture");
      const model = "explicit-test-model";
      Object.assign(input.provider, { agent, model, profile: resolveQualifiedAcpxProfile(agent, model) });
      const backend = createNativeSessionBackend(input, {
        codexTransportFactory: () => {
          throw new Error("descriptor must not launch the transport");
        },
      });

      await expect(backend.descriptor()).resolves.toMatchObject({
        name: "acpx_runtime",
        version: "0.13.1",
        capabilities: {
          steering: false,
          resume: true,
          interruption: true,
          dynamicTools: true,
          collaborationModes: ["default", "plan"],
          toolRefreshOnResume: true,
        },
      });
    },
  );

  it("requires an explicit runtime root", () => {
    expect(() => createNativeSessionBackend(acpxExecution())).toThrow(
      "requires an instance runtime directory",
    );
  });
  it.each(["pi", "cursor", "copilot"] as const)("constructs %s identity on the supplied runnerd transport without starting a provider", async agent => {
    const input = acpxExecution();
    if (input.provider.kind !== "acpx") throw new Error("invalid fixture");
    const model = "explicit-fixture-model";
    Object.assign(input.provider, { agent, model, profile: resolveQualifiedAcpxProfile(agent, model) });
    const backend = createNativeSessionBackend(input, {
      codexTransportFactory: () => { throw new Error("descriptor must not launch the transport"); },
    });
    await expect(backend.descriptor()).resolves.toMatchObject({ name: "acpx_runtime", version: "0.13.1" });
  });

  it.each(["claude" as const])(
    "constructs the qualified %s ACPX backend",
    async (agent) => {
      const backend = createNativeSessionBackend(acpxExecution(agent), {
        acpxRuntimeDirectory: "/runtime",
      });

      await expect(backend.descriptor()).resolves.toMatchObject({
        name: "acpx_runtime",
        version: "0.13.1",
      });
    },
  );

  it("constructs the qualified Pi backend without a diagnostic opt-in or provider launch", async () => {
    const input = acpxExecution();
    if (input.provider.kind !== "acpx") throw new Error("invalid fixture");
    const profile = resolveQualifiedAcpxProfile("pi", "custom/explicit-test-model");
    Object.assign(input.provider, { agent: "pi", model: profile.qualificationModel, piThinkingLevel: "low", profile });
    const backend = createNativeSessionBackend(input, { acpxRuntimeDirectory: "/runtime" });
    await expect(backend.descriptor()).resolves.toMatchObject({ name: "acpx_runtime", version: "0.13.1" });
  });

  it.each(["copilot"] as const)("rejects unqualified %s direct execution even with an exact persisted profile", agent => {
    const input = acpxExecution();
    if (input.provider.kind !== "acpx") throw new Error("invalid fixture");
    const model = "explicit-fixture-model";
    const profile = resolveQualifiedAcpxProfile(agent, model);
    Object.assign(input.provider, { agent, model, profile });
    expect(() => createNativeSessionBackend(input, { acpxRuntimeDirectory: "/runtime",
      acpxEnvironment: { COPILOT_GITHUB_TOKEN: "explicit-fixture", CURSOR_API_KEY: "explicit-fixture", OPENROUTER_API_KEY: "explicit-fixture" },
    })).toThrow("ACPX candidate direct execution requires completed qualification");
  });

  it.each([
    ["cursor", "../../test/fixtures/cursor-acp/profile-v7-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v74-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v75-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v76-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v77-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v78-identity.json"],
    ["pi", "../../test-fixtures/pi-acp/profile-v32-identity.json"],
    ["grok", "../../test/fixtures/grok-profile-v10-identity.json"],
    ["cursor", "../../test/fixtures/cursor-acp/profile-v10-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v14-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v60-identity.json"],
    ["pi", "../../test-fixtures/pi-acp/profile-v13-identity.json"],
    ["pi", "../../test-fixtures/pi-acp/profile-v14-identity.json"],
    ["pi", "../../test-fixtures/pi-acp/profile-v18-identity.json"],
    ["cursor", "../../test/fixtures/cursor-acp/profile-v9-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v7-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v9-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v10-identity.json"],
    ["copilot", "../../test/fixtures/copilot-profile-v11-identity.json"],
    ["pi", "../../test-fixtures/pi-acp/profile-v9-identity.json"],
  ] as const)("rejects the exact historical %s identity before runtime startup", (agent, path) => {
    const historical = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    const input = acpxExecution();
    if (input.provider.kind !== "acpx") throw new Error("invalid fixture");
    const current = resolveQualifiedAcpxProfile(agent, agent === "pi" ? "custom/explicit-test-model" : "explicit-fixture-model");
    Object.assign(input.provider, { agent, model: current.qualificationModel, profile: { ...current,
      agentProfileVersion: historical.declaration.agentProfileVersion, commandDigest: historical.commandDigest } });
    expect(() => createNativeSessionBackend(input, { acpxRuntimeDirectory: "/runtime" }))
      .toThrow("does not match the qualified agentProfileVersion");
    input.provider.profile.agentProfileVersion = current.agentProfileVersion;
    expect(() => createNativeSessionBackend(input, { acpxRuntimeDirectory: "/runtime" }))
      .toThrow("does not match the qualified commandDigest");
  });

  it.each([1, 2] as const)("rejects a Pi version %s warm snapshot after the rich ACP upgrade", version => {
    const input = acpxExecution("pi");
    if (input.provider.kind !== "acpx") throw new Error("invalid fixture");
    input.provider.profile.agentProfileVersion = version;
    expect(() => createNativeSessionBackend(input, { acpxRuntimeDirectory: "/runtime" }))
      .toThrow("does not match the qualified agentProfileVersion");
  });

  it("rejects a Codex ACPX snapshot that drifts from its qualified profile", () => {
    const input = acpxExecution();
    if (input.provider.kind !== "acpx") throw new Error("invalid fixture");
    input.provider.profile.commandDigest = `sha256:${"a".repeat(64)}`;

    expect(() =>
      createNativeSessionBackend(input, {
        acpxRuntimeDirectory: "/runtime",
      }),
    ).toThrow("does not match the qualified commandDigest");
  });

  it("guards the provider-specific constructor as a second boundary", () => {
    expect(() =>
      createCodexNativeSessionBackend(
        execution({
          kind: "opencode",
          model: "openrouter/model",
        }),
      ),
    ).toThrow("Codex native backend requires provider kind codex");
  });

  it.each(["v5", "v7", "v9"] as const)("selects prepared transport for %s native input and retains prepared constraints", async version => {
    const input = preparedExecution(execution(), version);
    const transport = new FakeCodexTransport();
    let currentInstructions: string | undefined;
    const backend = createCodexNativeSessionBackend(input, {
      transportFactory: (context) => { currentInstructions = context?.baseInstructions; return transport; },
      workingDirectoryAuthority: "remote_runner",
      environment: { PAPERCLIP_WORKSPACE_CWD: WORKSPACE },
    });

    await backend.openSession({
      identity: {
        companyId: "company",
        agentId: "agent",
        runId: "run",
        sessionId: "session",
      },
      workingDirectory: WORKSPACE,
    });

    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({ conversationMode: "prepared" });
    expect(currentInstructions).toContain("Keep assigned instructions.");
    expect(currentInstructions).toBe(transport.calls.find((call) => call.method === "thread/start")?.params.developerInstructions);
    expect(backend.preparedTaskConstraints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Obtain one accepted result"),
      ]),
    );
  });

  it("allows a completion-only turn after v9 Claude work without wrapping prepared input", async () => {
    const { qualificationModel: _model, reportedModelId: _reported, permissionPolicy: _policy, ...profile } = resolveQualifiedAcpxProfile("claude", "claude-opus-5-5");
    const input = preparedExecution({ ...acpxExecution("claude"), provider: {
      kind: "acpx", agent: "claude", model: "claude-opus-5-5", permissionMode: "approve-all", profile,
    } }, "v9");
    if (input.schema !== "paperclip.native-execution-input.v9" || input.provider.kind !== "acpx") throw new Error("invalid fixture");
    input.provider.claudeEffort = "high";
    const transport = new FakeCodexTransport("thread-1", "provider-session-1", {
      kind: "acpx", normalizedSessionId: "session", acpxRecordId: "fixture-record",
      backendSessionId: "fixture-backend", agentSessionId: "fixture-agent",
      profileDigest: `sha256:${"a".repeat(64)}`, workspaceDigest: `sha256:${"b".repeat(64)}`,
      requestedModel: input.provider.model, effectiveModel: input.provider.model, permissionMode: "approve-all",
      providerLifetimeFenceCandidates: [60001, 60002, 60003],
    });
    const backend = createRunnerdNativeSessionBackend(input, {
      transportFactory: () => transport,
      environment: { PAPERCLIP_WORKSPACE_CWD: WORKSPACE },
    });
    const session = await backend.openSession({
      identity: { companyId: "company", agentId: "agent", runId: "run", sessionId: "session" },
      workingDirectory: WORKSPACE,
    });
    const first = JSON.stringify(buildNativeModelEnvelope(input));
    const completion = "Call paperclip_finish with the result of the work already completed.";
    try {
      for (const [index, text] of [first, completion].entries()) {
        transport.turnStartResponse = Promise.resolve({ turn: { id: `turn-${index + 1}`, status: "inProgress", items: [] } });
        const turn = await session.startTurn({ message: { role: "user", text } });
        transport.push("turn/completed", { threadId: "thread-1", turn: { id: turn.turnId, status: "completed", items: [] } });
        for await (const event of session.events()) {
          if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.eventType)) break;
        }
      }
      const turns = transport.calls.filter(call => call.method === "turn/start");
      expect(turns.map(call => call.params.input)).toEqual([first, completion].map(text => [{ type: "text", text, text_elements: [] }]));
      expect(backend.preparedTaskConstraints).toEqual(expect.arrayContaining([expect.stringContaining("Obtain one accepted result")]));
    } finally {
      await session.close({ reason: "test-completed" });
    }
  });

  it.each(["v5", "v7", "v9"] as const)("projects %s OpenCode constraints to the prepared runtime boundary", version => {
    const input = preparedExecution(opencodeExecution(), version);
    const backend = createOpenCodeNativeSessionBackend(input, {
      runtimeDirectory: "/tmp/paperclip-opencode-prepared-factory",
    });
    expect(backend.preparedTaskConstraints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Obtain one accepted result"),
      ]),
    );
  });
});
