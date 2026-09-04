import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
import {
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
  createCodexTaskEnvelope,
} from "../contracts/codex.js";
import {
  CodexAppServerDriver,
  codexSemanticToolSpecs,
} from "../drivers/codex/codex-app-server-driver.js";
import { releaseMaterializedNativeRuntimeSkills } from "../drivers/runtime-context-materializer.js";

import {
  authorizedToolSetForProvider,
  createCapabilityRunnerdCodexTransport,
  createCapabilityRunnerdProviderEnvironment,
  defaultCapabilityRunnerdBinary,
  expandRunnerdCanonicalNotifications,
  rehydrateRunnerdItemNotification,
  rehydrateRunnerdPlanNotification,
  rehydrateRunnerdResultNotification,
  rehydrateRunnerdThreadTokenUsage,
  rehydrateRunnerdTurnNotification,
  rehydrateRunnerdUsageNotification,
  rehydrateRunnerdWorkspaceChangeNotification,
  runnerdLaunchProfileInternals,
  runnerdRecoveryInternals,
  resolveRunnerdAcpxPermissionMode,
  resolveRunnerdSessionIdentity,
  resolveSourceCodexHome,
  trustedRuntimeReadOnlyRoots,
  unwrapRunnerdProviderNotification,
  unwrapRunnerdProviderNotifications,
  withCodexCollaborationRuntimeInstructions,
} from "./runnerd-codex-transport.js";

it("replays the durable run attachment outcome and latest provider identity", () => {
  expect(
    runnerdRecoveryInternals.recoveredRunAttachment({
      commands: [
        { commandId: "prepare", type: "run.prepare", status: "completed" },
        { commandId: "attach", type: "run.attach", status: "failed" },
      ],
      committedEvents: [{ eventType: "session.started" }],
    }),
  ).toEqual({
    commandId: "attach",
    status: "failed",
    providerIdentityEventIndex: -1,
  });

  expect(
    runnerdRecoveryInternals.recoveredRunAttachment({
      commands: [
        { commandId: "attach", type: "run.attach", status: "completed" },
      ],
      committedEvents: [
        { eventType: "runner.reconciled" },
        { eventType: "session.started" },
        { eventType: "runner.diagnostic" },
        { eventType: "session.resumed" },
      ],
    }),
  ).toEqual({
    commandId: "attach",
    status: "completed",
    providerIdentityEventIndex: 3,
  });
});

it("identifies an active provider turn that must stop before suspension", () => {
  expect(
    runnerdRecoveryInternals.providerDrainStateFromSnapshot({
      activeProviderTurnId: "provider-turn-1",
      pendingEvents: [{ eventType: "item.started" }],
      queuedEvents: [{ eventType: "item.completed" }],
    }),
  ).toEqual({
    pendingEventCount: 2,
    activeProviderTurnId: "provider-turn-1",
    providerSettled: false,
  });

  expect(
    runnerdRecoveryInternals.providerDrainStateFromSnapshot({
      activeTurnId: "acpx-turn-1",
      pendingEvents: [],
    }),
  ).toEqual({
    pendingEventCount: 0,
    activeProviderTurnId: "acpx-turn-1",
    providerSettled: false,
  });

  expect(
    runnerdRecoveryInternals.providerDrainStateFromSnapshot({
      activeProviderTurnId: null,
      ambiguousTurnStartPending: false,
      pendingEvents: [],
      queuedEvents: [],
    }),
  ).toEqual({
    pendingEventCount: 0,
    activeProviderTurnId: null,
    providerSettled: true,
  });
});

it("keeps ACPX terminal tools under the reserved runner-owned catalog", () => {
  const tools = [
    {
      name: "get_task_context",
      description: "Read the task context.",
      inputSchema: { type: "object" },
    },
    ...codexSemanticToolSpecs(),
  ];

  expect(authorizedToolSetForProvider("acpx", tools)).toMatchObject({
    operations: [{ operationId: "get_task_context" }],
  });
  expect(authorizedToolSetForProvider("codex", tools)).toMatchObject({
    operations: [
      { operationId: "get_task_context" },
      { operationId: "paperclip_block" },
      { operationId: "paperclip_finish" },
    ],
  });
});

it("defaults runnerd ACPX permissions to approve reads", () => {
  expect(resolveRunnerdAcpxPermissionMode(undefined)).toBe("approve-reads");
  expect(resolveRunnerdAcpxPermissionMode("deny-all")).toBe("deny-all");
});

it("rejects caller-selected local ACPX artifacts even when they are self-hashed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paperclip-acpx-authority-"));
  const command = join(directory, "node");
  const sidecar = join(directory, "sidecar.js");
  await writeFile(command, "caller-selected command", { mode: 0o700 });
  await writeFile(sidecar, "caller-selected sidecar", { mode: 0o600 });
  const digest = (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  try {
    expect(() =>
      runnerdLaunchProfileInternals.acpxRunnerLaunchProfile(
        {
          providerNodeCommand: command,
          providerNodeCommandSha256: digest("caller-selected command"),
          acpxSidecarPath: sidecar,
          acpxSidecarSha256: digest("caller-selected sidecar"),
        },
        command,
        sidecar,
      ),
    ).toThrow("ACPX local launch must use build-owned artifacts");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["acpx-runtime-sidecar.cjs", "opencode-app-server-proxy.cjs"] as const)(
  "resolves the %s local provider artifact from verified build-owned output",
  async (artifact) => {
    const directory = await mkdtemp(
      join(tmpdir(), "paperclip-provider-artifact-"),
    );
    const sourceAdjacent = join(directory, "src", "cli", artifact);
    const buildOwned = join(directory, "dist", "cli", artifact);
    await mkdir(join(directory, "dist", "cli"), { recursive: true });
    await writeFile(buildOwned, "build-owned provider artifact", {
      mode: 0o600,
    });
    try {
      expect(
        runnerdLaunchProfileInternals.resolveBuildOwnedCliArtifact(artifact, [
          sourceAdjacent,
          buildOwned,
        ]),
      ).toBe(buildOwned);
      await rm(buildOwned);
      expect(() =>
        runnerdLaunchProfileInternals.resolveBuildOwnedCliArtifact(artifact, [
          sourceAdjacent,
          buildOwned,
        ]),
      ).toThrow(`runner_local_provider_artifact_missing: ${artifact}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("derives the ACPX package authority only from the verified dist/cli layout", () => {
  const runnerPackageRoot = fileURLToPath(new URL("../..", import.meta.url));
  expect(
    runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
      resolve(runnerPackageRoot, "dist/cli/acpx-runtime-sidecar.cjs"),
    ),
  ).toEqual({
    root: resolve(runnerPackageRoot, "../.."),
    manifest: resolve(runnerPackageRoot, "package.json"),
  });
  expect(
    runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
      "/provider-pack/dist/cli/acpx-runtime-sidecar.cjs",
    ),
  ).toEqual({
    root: "/provider-pack",
    manifest: "/provider-pack/package.json",
  });
  expect(() =>
    runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
      "/unverified/acpx-runtime-sidecar.cjs",
    ),
  ).toThrow("ACPX sidecar must use the provider package dist/cli layout");
});

it("requires a provider-pack authority for remote ACPX artifact hashes", () => {
  expect(() =>
    runnerdLaunchProfileInternals.acpxRunnerLaunchProfile(
      {
        runnerFilesystemRoot: "/runner",
        providerNodeCommand: "/provider-pack/node",
        providerNodeCommandSha256: `sha256:${"a".repeat(64)}`,
        acpxSidecarPath: "/provider-pack/acpx-sidecar.js",
        acpxSidecarSha256: `sha256:${"b".repeat(64)}`,
      },
      "/provider-pack/node",
      "/provider-pack/acpx-sidecar.js",
    ),
  ).toThrow("omitted its provider-pack authority");
});

it("adds Codex-style turn updates only when collaboration instructions are enabled", () => {
  const base = "Base Paperclip instructions.";
  const enabled = withCodexCollaborationRuntimeInstructions(base, true);
  expect(enabled).toContain(base);
  expect(enabled).toContain("Before the first tool call in a turn");
  expect(enabled).toContain(
    "Do not call it merely to create a completion comment",
  );
  expect(enabled).toContain("semantic completion tool exactly once before");
  expect(enabled).toContain("After it succeeds");
  expect(enabled).not.toContain("Before semantic finalization");
  expect(withCodexCollaborationRuntimeInstructions(base, false)).toBe(base);
});

it("resolves the ordinary ~/.codex credential home when CODEX_HOME is unset", () => {
  expect(resolveSourceCodexHome({ HOME: "/Users/tester" })).toBe(
    "/Users/tester/.codex",
  );
  expect(
    resolveSourceCodexHome({
      HOME: "/Users/tester",
      CODEX_HOME: "/managed/codex",
    }),
  ).toBe("/managed/codex");
});

it("preserves OpenCode runtime bindings when a durable runner is respawned", () => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "opencode",
    options: {
      provider: "opencode",
      stateDirectory: "/isolated/session",
      opencodePermissionMode: "deny",
      environment: {
        PATH: "/bin",
        OPENROUTER_API_KEY: "test-provider-key",
        HOME: "/host/home",
        CODEX_HOME: "/host/codex-home",
        DATABASE_URL: "must-not-reach-runnerd",
        PAPERCLIP_API_KEY: "must-not-reach-runnerd",
        NODE_OPTIONS: "--require=/untrusted/bootstrap.cjs",
      },
      opencodeCommand: "/provider-pack/opencode",
      opencodeRuntimeDirectory: "/isolated/session/opencode",
    },
    identity: {
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    codexHome: "/isolated/codex-home",
    runtimeContextPath: "/isolated/runtime-context.json",
    hasRuntimeContext: true,
  });
  expect(environment).toMatchObject({
    PAPERCLIP_OPENCODE_PERMISSION_MODE: "deny",
    PAPERCLIP_OPENCODE_RUNTIME_DIR: "/isolated/session/opencode",
    PAPERCLIP_RUNNER_INSTANCE_ID: "runner-1",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_NORMALIZED_SESSION_ID: "session-1",
    PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH: "/isolated/runtime-context.json",
    OPENROUTER_API_KEY: "test-provider-key",
  });
  expect(environment.HOME).toBeUndefined();
  expect(environment.CODEX_HOME).toBeUndefined();
  expect(environment.DATABASE_URL).toBeUndefined();
  expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
  expect(environment.NODE_OPTIONS).toBeUndefined();
  expect(environment.PAPERCLIP_OPENCODE_COMMAND).toBeUndefined();

  const defaultPermissionEnvironment =
    createCapabilityRunnerdProviderEnvironment({
      provider: "opencode",
      options: {
        provider: "opencode",
        stateDirectory: "/isolated/session",
        environment: { PATH: "/bin" },
      },
      identity: {
        runnerInstanceId: "runner-1",
        environmentLeaseId: "lease-1",
        runId: "run-1",
        normalizedSessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      codexHome: "/isolated/codex-home",
      runtimeContextPath: "/isolated/runtime-context.json",
      hasRuntimeContext: false,
    });
  expect(defaultPermissionEnvironment.PAPERCLIP_OPENCODE_PERMISSION_MODE).toBe(
    "ask",
  );
});

it("passes the configured Codex API key only through the provider process environment", () => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "codex",
    options: {
      provider: "codex",
      environment: {
        PATH: "/bin",
        OPENAI_API_KEY: "configured-provider-key",
        CODEX_API_KEY: "configured-automation-key",
        PAPERCLIP_API_KEY: "must-not-reach-provider",
      },
    },
    identity: {
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    codexHome: "/isolated/codex-home",
    runtimeContextPath: "/isolated/runtime-context.json",
    hasRuntimeContext: false,
  });
  expect(environment).toMatchObject({
    PATH: "/bin",
    HOME: "/isolated/codex-home",
    CODEX_HOME: "/isolated/codex-home",
    OPENAI_API_KEY: "configured-provider-key",
    CODEX_API_KEY: "configured-automation-key",
  });
  expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
});

it("passes only the Anthropic credential to Claude Managed runnerd", () => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "claude_managed",
    options: {
      provider: "claude_managed",
      environment: {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "anthropic-canary",
        PAPERCLIP_NATIVE_MCP_NAME: "paperclip",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
        PAPERCLIP_NATIVE_MCP_TOKEN: "must-not-reach-provider",
        PAPERCLIP_API_KEY: "must-not-reach-provider",
        DATABASE_URL: "must-not-reach-provider",
      },
    },
    identity: {
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    codexHome: "/isolated/codex-home",
    runtimeContextPath: "/isolated/runtime-context.json",
    hasRuntimeContext: true,
  });
  expect(environment).toMatchObject({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "anthropic-canary",
    PAPERCLIP_RUNNER_INSTANCE_ID: "runner-1",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_NORMALIZED_SESSION_ID: "session-1",
  });
  expect(environment.PAPERCLIP_NATIVE_MCP_NAME).toBeUndefined();
  expect(environment.PAPERCLIP_NATIVE_MCP_URL).toBeUndefined();
  expect(environment.PAPERCLIP_NATIVE_MCP_TOKEN).toBeUndefined();
  expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
  expect(environment.DATABASE_URL).toBeUndefined();
});

it("uses file-backed AWS workload identity without forwarding access keys or Paperclip tokens", () => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "aws_agentcore",
    options: {
      provider: "aws_agentcore",
      environment: {
        PATH: "/bin",
        HOME: "/host/home",
        AWS_PROFILE: "host-profile",
        AWS_CONFIG_FILE: "/host/home/.aws/config",
        AWS_SHARED_CREDENTIALS_FILE: "/host/home/.aws/credentials",
        AWS_REGION: "us-east-1",
        AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/runner",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/identity/token",
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/identity/container-token",
        AWS_ACCESS_KEY_ID: "must-not-reach-provider",
        AWS_SECRET_ACCESS_KEY: "must-not-reach-provider",
        AWS_SESSION_TOKEN: "must-not-reach-provider",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
        PAPERCLIP_NATIVE_MCP_TOKEN: "must-not-reach-provider",
      },
    },
    identity: {
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    codexHome: "/isolated/codex-home",
    runtimeContextPath: "/isolated/runtime-context.json",
    hasRuntimeContext: false,
  });
  expect(environment).toMatchObject({
    HOME: "/isolated/codex-home",
    AWS_REGION: "us-east-1",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/runner",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/identity/token",
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/identity/container-token",
  });
  expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(environment.AWS_SESSION_TOKEN).toBeUndefined();
  expect(environment.AWS_PROFILE).toBeUndefined();
  expect(environment.AWS_CONFIG_FILE).toBeUndefined();
  expect(environment.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
  expect(environment.PAPERCLIP_NATIVE_MCP_URL).toBeUndefined();
  expect(environment.PAPERCLIP_NATIVE_MCP_TOKEN).toBeUndefined();
});

it.each([
  {
    agent: "pi" as const,
    allowed: ["OPENROUTER_API_KEY"],
    denied: [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
    ],
  },
  {
    agent: "claude" as const,
    allowed: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    denied: [
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
    ],
  },
  {
    agent: "codex" as const,
    allowed: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    denied: [
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
    ],
  },
])(
  "passes only $agent ACPX credentials and the durable runtime binding",
  ({ agent, allowed, denied }) => {
    const credentialEnvironment: Record<string, string> = {
      OPENROUTER_API_KEY: "openrouter-canary",
      ANTHROPIC_API_KEY: "anthropic-canary",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-canary",
      OPENAI_API_KEY: "openai-canary",
      CODEX_API_KEY: "codex-canary",
      PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "managed-codex-canary",
    };
    const environment = createCapabilityRunnerdProviderEnvironment({
      provider: "acpx",
      options: {
        provider: "acpx",
        stateDirectory: "/isolated/session",
        acpxAgent: agent,
        environment: {
          PATH: "/bin",
          ...credentialEnvironment,
          PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: "/attacker/package-root",
          PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST:
            "/attacker/package-root/package.json",
          PAPERCLIP_API_KEY: "must-not-reach-provider",
          DATABASE_URL: "must-not-reach-provider",
        },
      },
      identity: {
        runnerInstanceId: "runner-1",
        environmentLeaseId: "lease-1",
        runId: "run-1",
        normalizedSessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      codexHome: "/isolated/codex-home",
      runtimeContextPath: "/isolated/runtime-context.json",
      hasRuntimeContext: true,
      acpxSidecarPath:
        "/verified/provider-pack/dist/cli/acpx-runtime-sidecar.cjs",
    });

    expect(environment).toMatchObject({
      PATH: "/bin",
      PAPERCLIP_RUNNER_INSTANCE_ID: "runner-1",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_NORMALIZED_SESSION_ID: "session-1",
      PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH: "/isolated/runtime-context.json",
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: "/verified/provider-pack",
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST:
        "/verified/provider-pack/package.json",
    });
    for (const key of allowed)
      expect(environment[key]).toBe(credentialEnvironment[key]);
    for (const key of denied) expect(environment[key]).toBeUndefined();
    expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
  },
);

it.each(["opencode", "acpx"] as const)(
  "advertises runner-managed planning through the %s provider boundary",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runner-plan-mode-"));
    const { transport } = createCapabilityRunnerdCodexTransport({
      provider,
      stateDirectory: root,
      ...(provider === "acpx" ? { acpxAgent: "codex" as const } : {}),
    });
    try {
      await expect(
        transport.request("collaborationMode/list", {}),
      ).resolves.toMatchObject({
        data: [{ mode: "plan", model: "runner-managed" }],
      });
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("allows trusted package-manager runtime roots without exposing HOME paths", () => {
  expect(
    trustedRuntimeReadOnlyRoots({
      HOME: "/Users/tester",
      PATH: "/Users/tester/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    }),
  ).toEqual(["/opt/homebrew", "/usr/local"]);
});

it("rejects remote OpenCode before spawn when provider-pack paths are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-runner-remote-pack-"));
  const { transport } = createCapabilityRunnerdCodexTransport({
    provider: "opencode",
    stateDirectory: root,
    runnerFilesystemRoot: "/workspaces/task/.paperclip-runtime/session",
  });
  try {
    await expect(
      transport.request("thread/start", {
        cwd: "/workspaces/task",
        model: "openrouter/model",
        baseInstructions: "Complete the task.",
        dynamicTools: [],
      }),
    ).rejects.toThrow("runner_remote_provider_artifact_incompatible");
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rehydrates normalized usage with the opened driver binding", () => {
  expect(
    rehydrateRunnerdUsageNotification(
      {
        providerSessionId: "backend-session-1",
        threadId: "provider-thread-1",
        turnId: "durable-turn-1",
        cumulative: { inputTokens: 10 },
        runDelta: { inputTokens: 3 },
        runDeltaAvailable: true,
      },
      "opened-thread-1",
      "active-turn-1",
    ),
  ).toMatchObject({
    providerSessionId: "backend-session-1",
    threadId: "opened-thread-1",
    turnId: "active-turn-1",
    runDeltaAvailable: true,
    tokenUsage: {
      total: { inputTokens: 10 },
      runDelta: { inputTokens: 3 },
    },
  });
});

it("rehydrates durable cumulative usage for a cold thread read", () => {
  expect(
    rehydrateRunnerdThreadTokenUsage({ inputTokens: 12, outputTokens: 3 }),
  ).toEqual({
    total: { inputTokens: 12, outputTokens: 3 },
  });
  expect(rehydrateRunnerdThreadTokenUsage(null)).toBeNull();
});

it("binds a durable semantic result to the active provider turn", () => {
  expect(
    rehydrateRunnerdResultNotification(
      { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done" },
      "opened-thread-1",
      "provider-turn-1",
      "finish-1",
    ),
  ).toEqual({
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    itemId: "finish-1",
    result: {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "done",
    },
  });
});

it("rehydrates a canonical agent item for the strict Codex facade", () => {
  expect(
    rehydrateRunnerdItemNotification(
      {
        itemId: "message-1",
        kind: "agentMessage",
        status: "completed",
        channel: "final",
        providerPhase: "final_answer",
        text: "Durable final reply",
      },
      "opened-thread-1",
      "provider-turn-1",
    ),
  ).toEqual({
    itemId: "message-1",
    kind: "agentMessage",
    status: "completed",
    channel: "final",
    providerPhase: "final_answer",
    text: "Durable final reply",
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    item: {
      id: "message-1",
      type: "agentMessage",
      status: "completed",
      text: "Durable final reply",
      phase: "final_answer",
      channel: "final",
    },
  });
});

it.each([
  ["progress", "commentary"],
  ["final", "final_answer"],
] as const)(
  "rehydrates the %s assistant channel when provider phase is absent",
  (channel, phase) => {
    expect(
      rehydrateRunnerdItemNotification(
        {
          itemId: `message-${channel}`,
          kind: "agentMessage",
          status: "completed",
          channel,
          text: `${channel} reply`,
        },
        "opened-thread-1",
        "provider-turn-1",
      ),
    ).toMatchObject({
      item: { channel, phase },
    });
  },
);

it("binds a canonical runnerd terminal to the active provider turn", () => {
  expect(
    rehydrateRunnerdTurnNotification(
      {
        turnId: "durable-turn-1",
        turn: { id: "durable-turn-1", status: "completed", items: [] },
      },
      "opened-thread-1",
      "provider-turn-1",
      "turn/completed",
    ),
  ).toEqual({
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    turn: { id: "provider-turn-1", status: "completed", items: [] },
  });
});

it("rehydrates a canonical runnerd terminal error into the Codex turn", () => {
  expect(
    rehydrateRunnerdTurnNotification(
      {
        providerTurnId: "provider-turn-1",
        status: "failed",
        error: {
          code: "provider_failed",
          message: "provider rejected the turn",
        },
      },
      "opened-thread-1",
      "provider-turn-1",
      "turn/completed",
    ),
  ).toMatchObject({
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    turn: {
      id: "provider-turn-1",
      status: "failed",
      error: { code: "provider_failed", message: "provider rejected the turn" },
    },
  });
});

it("preserves the provider identity on a late canonical terminal", () => {
  expect(
    rehydrateRunnerdTurnNotification(
      {
        providerTurnId: "provider-turn-settled",
        status: "interrupted",
      },
      "opened-thread-1",
      "provider-turn-active",
      "turn/completed",
    ),
  ).toMatchObject({
    threadId: "opened-thread-1",
    turnId: "provider-turn-settled",
    turn: { id: "provider-turn-settled", status: "interrupted" },
  });
});

it("preserves the provider turn assigned by a canonical runnerd start", () => {
  expect(
    rehydrateRunnerdTurnNotification(
      { provider: "codex", providerTurnId: "provider-turn-1" },
      "opened-thread-1",
      "temporary-transport-turn",
      "turn/started",
    ),
  ).toEqual({
    provider: "codex",
    providerTurnId: "provider-turn-1",
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    turn: { id: "provider-turn-1" },
  });
});

it("rehydrates normalized plans into the Codex notification contract", () => {
  expect(
    rehydrateRunnerdPlanNotification(
      {
        explanation: "Ship in small steps",
        steps: [
          { stepId: "step-1", body: "Inspect", status: "completed" },
          { stepId: "step-2", body: "Implement", status: "in_progress" },
        ],
      },
      "thread-1",
      "turn-1",
    ),
  ).toMatchObject({
    threadId: "thread-1",
    turnId: "turn-1",
    explanation: "Ship in small steps",
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
    ],
  });
});

it("rehydrates canonical workspace changes without reconstructing the diff", () => {
  const workspaceChange = {
    schema: "paperclip.workspace.diff.v1",
    changeSetId: "turn-1:workspace",
    revision: 1,
    source: "harness_reported",
    complete: false,
    files: [
      {
        path: "src/index.ts",
        operation: "modify",
        previousPath: null,
        additions: 2,
        deletions: 1,
        binary: false,
        diff: "diff --git a/src/index.ts b/src/index.ts\n",
      },
    ],
    totals: { files: 1, additions: 2, deletions: 1 },
    patchArtifactRef: null,
  };
  expect(
    rehydrateRunnerdWorkspaceChangeNotification(
      workspaceChange,
      "thread-1",
      "turn-1",
    ),
  ).toEqual({
    threadId: "thread-1",
    turnId: "turn-1",
    workspaceChange,
  });
});

it("resolves canonical and legacy durable session identities", () => {
  expect(
    resolveRunnerdSessionIdentity({
      provider: "codex",
      providerSessionId: "provider-thread-1",
      providerAccountSessionId: "provider-account-1",
      processId: 4242,
    }),
  ).toEqual({
    processId: 4242,
    threadId: "provider-thread-1",
    sessionId: "provider-account-1",
  });
  expect(
    resolveRunnerdSessionIdentity({
      threadId: "legacy-thread-1",
      sessionId: "legacy-session-1",
      runtimeIdentity: { process_id: 4343 },
    }),
  ).toEqual({
    processId: 4343,
    threadId: "legacy-thread-1",
    sessionId: "legacy-session-1",
  });
});

const fakeCodex = resolve(
  import.meta.dirname,
  "../../runner/target/debug/fake-codex-app-server",
);

function fakeCodexArgs(stateDirectory: string, ...args: string[]): string[] {
  return [
    "--state-file",
    join(stateDirectory, "fake-codex-state.json"),
    ...args,
  ];
}

function assignedRuntimeContext(
  skillRoot: string,
  instructionRoot: string,
): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: instructionRoot,
        fileCount: 1,
        totalBytes: 1,
      },
    },
    skills: [
      {
        key: "company/assigned",
        runtimeName: "assigned",
        versionId: "version-1",
        bundle: {
          schema: NATIVE_RUNTIME_ASSET_SCHEMA,
          digest,
          manifestDigest: digest,
          rootPath: skillRoot,
          fileCount: 1,
          totalBytes: 1,
        },
      },
    ],
    mcp: { assignmentSetId: "assigned", digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return {
    ...value,
    aggregateDigest: canonicalNativeRuntimeContextDigest(value),
  };
}

it("unwraps a coalesced provider notification without losing its turn identity", () => {
  expect(
    unwrapRunnerdProviderNotification({
      coalescedCount: 2,
      latest: {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "provider-turn-1" } },
      },
    }),
  ).toEqual({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "provider-turn-1" } },
  });
});

it("replays every provider notification from a durable coalesced batch", () => {
  expect(
    unwrapRunnerdProviderNotifications({
      coalescedCount: 3,
      events: [
        { method: "item/started", params: { item: { id: "reasoning-1" } } },
        {
          method: "item/reasoning/summaryTextDelta",
          params: { delta: "Checking the task" },
        },
        { method: "item/completed", params: { item: { id: "reasoning-1" } } },
      ],
    }),
  ).toEqual([
    expect.objectContaining({ method: "item/started" }),
    expect.objectContaining({ method: "item/reasoning/summaryTextDelta" }),
    expect.objectContaining({ method: "item/completed" }),
  ]);
});

it("expands coalesced canonical items without dropping strict bindings", () => {
  expect(
    expandRunnerdCanonicalNotifications("item/started", {
      coalescedCount: 2,
      events: [
        { threadId: "thread-1", turnId: "turn-1", item: { id: "reasoning-1" } },
        { threadId: "thread-1", turnId: "turn-1", item: { id: "reasoning-2" } },
      ],
    }),
  ).toEqual([
    {
      method: "item/started",
      params: expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    },
    {
      method: "item/started",
      params: expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    },
  ]);
});

it("runs the lab provider boundary through authenticated durable PRP", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-lab-provider-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async (request) => ({
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({
          ok: true,
          result: { task: { title: "PRP lab task" } },
        }),
      },
    ],
  }));
  try {
    await bundle.transport.request("initialize", {});
    const opened = await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    expect(opened.thread).toMatchObject({ modelProvider: "openai" });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Read the task." }],
    });
    const methods: string[] = [];
    let terminalParams: Record<string, unknown> | null = null;
    for await (const notification of bundle.transport.notifications()) {
      methods.push(notification.method);
      if (notification.method === "turn/completed") {
        terminalParams = notification.params;
        break;
      }
    }
    expect(methods).toContain("turn/completed");
    expect(terminalParams).toMatchObject({
      threadId: opened.thread.id,
      turnId: "provider-turn-1",
    });
    expect(bundle.evidence().diagnostics).toContain(
      "runnerd authenticated to the durable PRP control plane",
    );
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
  expect(bundle.evidence()).toMatchObject({
    runnerExited: true,
    runnerExitCode: 0,
  });
}, 30_000);

it("binds an immediately failed durable turn before exposing its terminal", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-fast-terminal-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--fail-turn-immediately"),
    stateDirectory,
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: createCodexTaskEnvelope({
      objective: "Exercise an immediate provider failure.",
    }),
    environment: {
      PATH: process.env.PATH,
      HOME: join(tmpdir(), "runnerd-fast-terminal-host-home"),
      PAPERCLIP_WORKSPACE_CWD: stateDirectory,
    },
    approvalPolicy: "never",
    transportFactory: () => bundle.transport,
  });
  const session = await driver.openSession({
    runId: "run-fast-terminal",
    normalizedSessionId: "session-fast-terminal",
    workingDirectory: stateDirectory,
  });
  try {
    const accepted = await session.startTurn({
      message: { role: "user", text: "Fail this test turn." },
    });
    expect(accepted.turnId).toBe("provider-turn-1");
    const events = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.eventType === "turn.failed") break;
    }
    const eventTypes = events.map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining(["turn.started", "turn.accepted", "turn.failed"]),
    );
    expect(eventTypes.indexOf("turn.started")).toBeLessThan(
      eventTypes.indexOf("turn.accepted"),
    );
    expect(eventTypes.indexOf("turn.accepted")).toBeLessThan(
      eventTypes.indexOf("turn.failed"),
    );
    expect(
      events.find((event) => event.eventType === "session.failed"),
    ).toBeUndefined();
    expect(await session.snapshot()).toMatchObject({
      activeTurnId: null,
      terminalTurns: [
        { turnId: "provider-turn-1", fingerprint: expect.any(String) },
      ],
    });
  } finally {
    await session.close();
    await rm(stateDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
  }
}, 30_000);

it("bridges a runnerd-native question into the server request handler and resolves it canonically", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-runtime-question-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--runtime-question"),
    stateDirectory,
  });
  let bridgedRequest: {
    method: string;
    params: Record<string, unknown>;
  } | null = null;
  bundle.transport.setServerRequestHandler(async (request) => {
    if (request.method !== "item/tool/requestUserInput") {
      return { success: true, contentItems: [] };
    }
    bridgedRequest = { method: request.method, params: request.params };
    await bundle.transport.resolveRuntimeRequest?.({
      requestId: String(request.id),
      turnId: String(request.params.turnId),
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            environment: { selectedOptionIds: ["option-1"] },
            regions: { selectedOptionIds: ["option-1"] },
            notes: { text: "Ship during the maintenance window." },
          },
        },
      },
    });
    return { answers: {} };
  });
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Ask the deployment questions." }],
    });
    const methods: string[] = [];
    for await (const notification of bundle.transport.notifications()) {
      methods.push(notification.method);
      if (notification.method === "turn/completed") break;
    }
    expect(bridgedRequest).toMatchObject({
      method: "item/tool/requestUserInput",
      params: {
        threadId: "codex-thread-1",
        questions: [
          expect.objectContaining({ id: "environment", isOther: true }),
          expect.objectContaining({ id: "regions", required: true }),
          expect.objectContaining({ id: "notes", required: true }),
        ],
      },
    });
    expect(methods).toContain("turn/completed");
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("fails closed for runnerd-native form elicitation until the Rust bridge preserves typed provider content", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-runtime-elicitation-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--runtime-elicitation"),
    stateDirectory,
  });
  let bridgedRequest: {
    method: string;
    params: Record<string, unknown>;
  } | null = null;
  bundle.transport.setServerRequestHandler(async (request) => {
    bridgedRequest = { method: request.method, params: request.params };
    return { success: true, contentItems: [] };
  });
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Request typed deployment settings." }],
    });
    const methods: string[] = [];
    for await (const notification of bundle.transport.notifications()) {
      methods.push(notification.method);
      if (notification.method === "turn/completed") break;
    }
    expect(bridgedRequest).toBeNull();
    expect(methods).toContain("turn/completed");
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("captures exact provider frames and correlates Rust and TypeScript interpretation stages", async () => {
  const traceDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-provider-trace-"),
  );
  const hostHome = await mkdtemp(
    join(tmpdir(), "runnerd-provider-trace-home-"),
  );
  const tracePath = join(traceDirectory, "trace.ndjson");
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(traceDirectory, "--structured-activity"),
    stateDirectory: join(traceDirectory, "state"),
    environment: {
      PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
      PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(64 * 1024 * 1024),
    },
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: createCodexTaskEnvelope({
      objective: "Exercise every structured provider boundary.",
    }),
    environment: {
      PATH: process.env.PATH,
      HOME: hostHome,
      PAPERCLIP_WORKSPACE_CWD: traceDirectory,
    },
    approvalPolicy: "never",
    transportFactory: () => bundle.transport,
  });
  const session = await driver.openSession({
    runId: "run-provider-trace",
    normalizedSessionId: "session-provider-trace",
    workingDirectory: traceDirectory,
  });
  const canonicalEvents = new Map<string, string>();
  const canonicalEventIds = new Set<string>();
  try {
    await session.startTurn({
      message: { role: "user", text: "Return a structured response." },
    });
    for await (const event of session.events()) {
      canonicalEvents.set(event.sourceEventId, event.eventType);
      canonicalEventIds.add(event.sourceEventId);
      if (event.eventType === "turn.completed") break;
    }
  } finally {
    await session.close();
  }
  const snapshot = await session.snapshot();
  for (
    let sourceSeq = 1;
    sourceSeq <= snapshot.lastSourceSequence;
    sourceSeq += 1
  ) {
    canonicalEventIds.add(`runner-codex:run-provider-trace:${sourceSeq}`);
  }

  await expect
    .poll(async () => {
      const [nativeTrace, rehydrationTrace] = await Promise.all([
        readFile(tracePath, "utf8"),
        readFile(`${tracePath}.rehydration`, "utf8"),
      ]);
      return [nativeTrace, rehydrationTrace].map((contents) =>
        JSON.parse(contents.trim().split("\n").at(-1) ?? "{}"),
      );
    })
    .toEqual([
      expect.objectContaining({ status: "complete" }),
      expect.objectContaining({ status: "complete" }),
    ]);

  const nativeEntries = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const rehydratedEntries = (await readFile(`${tracePath}.rehydration`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const frames = nativeEntries.filter((entry) => entry.kind === "frame");
  expect(frames.map((entry) => entry.frameId)).toEqual(
    frames.map((_, index) => index + 1),
  );
  expect(frames.map((entry) => entry.direction)).toEqual(
    expect.arrayContaining(["client_to_provider", "provider_to_client"]),
  );
  for (const frame of frames) {
    const raw = Buffer.from(String(frame.rawBase64), "base64");
    expect(raw.byteLength).toBe(frame.byteLength);
    expect(`sha256:${createHash("sha256").update(raw).digest("hex")}`).toBe(
      frame.digest,
    );
  }
  const decodedFrames = frames.map((frame) =>
    JSON.parse(Buffer.from(String(frame.rawBase64), "base64").toString("utf8")),
  ) as Array<Record<string, unknown>>;
  expect(
    decodedFrames.find((frame) => frame.method === "thread/start"),
  ).toMatchObject({
    params: {
      baseInstructions: withCodexCollaborationRuntimeInstructions(
        CODEX_SKILLLESS_BASE_INSTRUCTIONS,
      ),
    },
  });
  const stages = new Set(
    [...nativeEntries, ...rehydratedEntries]
      .filter((entry) => entry.kind === "interpretation")
      .map((entry) => entry.stage),
  );
  expect([...stages]).toEqual(
    expect.arrayContaining([
      "rust_native_transport",
      "rust_jsonrpc_parse",
      "rust_durable_normalization",
      "typescript_runnerd_rehydration",
      "typescript_codex_driver_normalization",
    ]),
  );
  expect(
    rehydratedEntries.find(
      (entry) => entry.ruleId === "runnerd.rehydrate.plan.updated",
    ),
  ).toMatchObject({
    stage: "typescript_runnerd_rehydration",
    disposition: "mapped",
  });
  const rustInterpretations = nativeEntries.filter(
    (entry) => entry.stage === "rust_durable_normalization",
  );
  const rehydrationInterpretations = rehydratedEntries.filter(
    (entry) => entry.stage === "typescript_runnerd_rehydration",
  );
  const driverInterpretations = rehydratedEntries.filter(
    (entry) => entry.stage === "typescript_codex_driver_normalization",
  );
  expect(rustInterpretations.length).toBeGreaterThan(0);
  expect(rehydrationInterpretations.length).toBeGreaterThan(0);
  expect(driverInterpretations.length).toBeGreaterThan(0);
  for (const rustEntry of rustInterpretations) {
    expect(rustEntry.disposition).toMatch(/^(mapped|ignored|rejected)$/);
    expect(rustEntry.reason).toEqual(expect.any(String));
    const emittedEventIds = Array.isArray(rustEntry.emittedEventIds)
      ? rustEntry.emittedEventIds.map(String)
      : [];
    if (rustEntry.disposition === "mapped") {
      expect(emittedEventIds.length).toBeGreaterThan(0);
    }
    for (const sourceEventId of emittedEventIds) {
      const rehydrated = rehydrationInterpretations.filter(
        (entry) => entry.sourceEventId === sourceEventId,
      );
      expect(
        rehydrated,
        `missing TypeScript rehydration for ${sourceEventId}`,
      ).toHaveLength(1);
      expect(rehydrated[0]).toMatchObject({
        sourceEventType: expect.any(String),
        disposition: expect.stringMatching(/^(mapped|ignored)$/),
      });
      if (rehydrated[0]?.disposition === "mapped") {
        const interpreted = driverInterpretations.filter(
          (entry) => entry.sourceEventId === sourceEventId,
        );
        expect(
          interpreted,
          `missing driver interpretation for ${sourceEventId}`,
        ).not.toHaveLength(0);
        for (const driverEntry of interpreted) {
          expect(driverEntry.disposition).not.toBe("rejected");
          expect(driverEntry.sourceEventType).toBe(
            rehydrated[0]?.sourceEventType,
          );
          const driverEventIds = Array.isArray(driverEntry.emittedEventIds)
            ? driverEntry.emittedEventIds.map(String)
            : [];
          if (driverEntry.disposition === "mapped") {
            expect(driverEventIds.length).toBeGreaterThan(0);
          } else {
            expect(driverEntry.reason).toEqual(expect.any(String));
            expect(String(driverEntry.reason).length).toBeGreaterThan(0);
            expect(driverEventIds).toHaveLength(0);
          }
          for (const eventId of driverEventIds) {
            expect(
              canonicalEventIds.has(eventId),
              `unknown canonical event ${eventId}`,
            ).toBe(true);
          }
        }
      }
    }
  }
  const planRehydration = rehydrationInterpretations.find(
    (entry) => entry.ruleId === "runnerd.rehydrate.plan.updated",
  );
  expect(planRehydration).toMatchObject({
    sourceEventId: expect.any(String),
    sourceEventType: "plan.updated",
    disposition: "mapped",
  });
  const planDriverInterpretations = driverInterpretations.filter(
    (entry) =>
      entry.sourceEventId === planRehydration?.sourceEventId &&
      entry.sourceEventType === planRehydration?.sourceEventType,
  );
  expect(planDriverInterpretations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        disposition: "mapped",
        emittedEventIds: expect.any(Array),
      }),
    ]),
  );
  const planEventIds = planDriverInterpretations.flatMap((entry) =>
    Array.isArray(entry.emittedEventIds)
      ? entry.emittedEventIds.map(String)
      : [],
  );
  expect(planEventIds.length).toBeGreaterThan(0);
  expect(
    new Set(planEventIds.map((eventId) => canonicalEvents.get(eventId))),
  ).toEqual(new Set(["plan.updated", "item.delta"]));
  for (const channel of ["rust_native", "typescript_runnerd_rehydration"]) {
    const channelEntries = [...nativeEntries, ...rehydratedEntries].filter(
      (entry) => entry.debugChannel === channel,
    );
    expect(channelEntries.map((entry) => entry.debugSequence)).toEqual(
      channelEntries.map((_, index) => index + 1),
    );
    const status = channelEntries.at(-1);
    expect(status).toMatchObject({
      kind: "trace_status",
      status: "complete",
      acknowledgedDebugSequence: channelEntries.length - 1,
    });
  }

  await rm(traceDirectory, { recursive: true, force: true });
  await rm(hostHome, { recursive: true, force: true });
}, 30_000);

it("steers the active provider turn through the durable PRP command path", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-steering-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--linger-after-turn-start"),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Work until I steer you." }],
    });

    await expect(
      bundle.transport.request("turn/steer", {
        input: [{ type: "text", text: "Prioritize the mobile queue layout." }],
        correlationId: "queued-comment-1",
      }),
    ).resolves.toEqual({});
    await expect(
      bundle.transport.request("turn/steer", {
        input: [{ type: "text", text: "Prioritize the mobile queue layout." }],
        correlationId: "queued-comment-1",
      }),
    ).resolves.toEqual({});
    await expect(
      bundle.transport.request("turn/steer", {
        expectedTurnId: "stale-logical-turn",
        input: [{ type: "text", text: "This must not dispatch." }],
      }),
    ).rejects.toThrow("stale turn");

    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    const methods: string[] = [];
    let acknowledged = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !acknowledged) {
      const next = await Promise.race([
        notifications.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("steering notification timeout")),
            1_000,
          ),
        ),
      ]);
      if (!next.value) break;
      methods.push(next.value.method);
      acknowledged =
        next.value.method === "item/completed" &&
        (next.value.params?.kind === "steering_acknowledgement" ||
          next.value.params?.item?.kind === "steering_acknowledgement");
    }
    expect(methods).toContain("turn/started");
    expect(acknowledged).toBe(true);
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("does not expose cross-run attachment before PRP authority can rotate atomically", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-warm-attach-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    const runnerPid = bundle.evidence().runnerPid;
    const providerPid = bundle.evidence().codexPid;
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    const waitForCompletion = async (label: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const next = await Promise.race([
          notifications.next(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${label} notification timeout`)),
              1_000,
            ),
          ),
        ]);
        if (next.value?.method === "turn/completed") return;
      }
      throw new Error(`${label} completion timeout`);
    };
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "first run" }],
    });
    await waitForCompletion("first run");

    expect(bundle.transport.attachRun).toBeUndefined();

    expect(bundle.evidence()).toMatchObject({
      runnerPid,
      codexPid: providerPid,
      runnerExited: false,
    });
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it.each([
  {
    binding: "runner instance",
    priorRunnerInstanceId: "runner-other",
    priorEnvironmentLeaseId: "lease-current",
  },
  {
    binding: "environment lease",
    priorRunnerInstanceId: "runner-current",
    priorEnvironmentLeaseId: "lease-other",
  },
])(
  "quarantines a mismatched $binding instead of reusing its provider session",
  async ({ priorRunnerInstanceId, priorEnvironmentLeaseId }) => {
    const container = await mkdtemp(
      join(tmpdir(), "runnerd-mismatched-authority-"),
    );
    const stateDirectory = join(container, "state");
    await mkdir(join(stateDirectory, "control-plane"), { recursive: true });
    await writeFile(
      join(stateDirectory, "control-plane", "control-plane-state.json"),
      JSON.stringify({
        identity: {
          runnerInstanceId: priorRunnerInstanceId,
          environmentLeaseId: priorEnvironmentLeaseId,
          runId: "run-old",
          normalizedSessionId: "session-current",
          turnId: "turn-old",
          itemId: "item-old",
        },
      }),
      { mode: 0o600 },
    );
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      stateDirectory,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: {
        runnerInstanceId: "runner-current",
        environmentLeaseId: "lease-current",
        runId: "run-new",
        normalizedSessionId: "session-current",
        turnId: "turn-new",
        itemId: "item-new",
      },
    });
    try {
      await expect(bundle.transport.request("thread/read", {})).rejects.toThrow(
        "native_runner_state_quarantined",
      );
      expect(await readdir(stateDirectory)).toEqual([]);
      expect(
        (await readdir(container)).some((entry) =>
          entry.startsWith("state.quarantine-"),
        ),
      ).toBe(true);
    } finally {
      await bundle.transport.close();
      await rm(container, { recursive: true, force: true });
    }
  },
);

it("cold-restores a suspended provider session under its durable run binding", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-cold-attach-"));
  const tracePath = join(stateDirectory, "provider-trace.ndjson");
  const skillRoot = join(stateDirectory, "runtime-skill");
  const instructionRoot = join(stateDirectory, "runtime-instructions");
  await Promise.all([mkdir(skillRoot), mkdir(instructionRoot)]);
  await writeFile(join(skillRoot, "SKILL.md"), "# Assigned runtime skill\n");
  await writeFile(join(instructionRoot, "AGENTS.md"), "Runtime instructions\n");
  const baseIdentity = {
    runnerInstanceId: "runner-cold-attach",
    environmentLeaseId: "lease-cold-attach",
    runId: "run-cold-first",
    normalizedSessionId: "session-cold-attach",
    turnId: "turn-cold-first",
    itemId: "item-cold-first",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(
      stateDirectory,
      "--include-skill-instructions",
      "--durable-turn-ids",
    ),
    stateDirectory,
    environment: {
      PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
      PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(64 * 1024 * 1024),
    },
    lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
    runtimeContext: assignedRuntimeContext(skillRoot, instructionRoot),
  };
  const dynamicTools = [
    {
      name: "get_task_context",
      description: "Read the active task.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  const first = createCapabilityRunnerdCodexTransport({
    ...options,
    prpIdentity: baseIdentity,
  });
  first.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  let firstProviderThread: { id: string; sessionId: string } | null = null;
  try {
    const started = await first.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [...dynamicTools, ...codexSemanticToolSpecs()],
      completionContract: {
        revision: "contract-first",
        criterionIds: ["criterion-first"],
      },
    });
    const startedThread = started.thread as Record<string, unknown>;
    firstProviderThread = {
      id: String(startedThread.id),
      sessionId: String(startedThread.sessionId),
    };
    expect(
      (await stat(join(stateDirectory, "codex-home", "skills", "assigned")))
        .mode & 0o222,
    ).toBe(0);
    expect(
      (
        await stat(
          join(stateDirectory, "codex-home", "skills", "assigned", "SKILL.md"),
        )
      ).mode & 0o222,
    ).toBe(0);
    await first.transport.request("turn/start", {
      input: [{ type: "text", text: "first process" }],
    });
    for await (const event of first.transport.notifications()) {
      if (event.method === "turn/completed") break;
    }
  } finally {
    await first.transport.close();
  }
  if (!firstProviderThread) {
    throw new Error("cold attach fixture did not return a provider thread");
  }

  const secondIdentity = {
    ...baseIdentity,
    runId: "run-cold-second",
    turnId: "turn-cold-second",
    itemId: "item-cold-second",
  };
  const rotated = createCapabilityRunnerdCodexTransport({
    ...options,
    resumeDynamicTools: dynamicTools,
    resumeCompletionContract: {
      revision: "contract-second",
      criterionIds: ["criterion-second"],
    },
    prpIdentity: secondIdentity,
  });
  rotated.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    const read = await rotated.transport.request("thread/read", {});
    expect(read.thread).toMatchObject({
      id: firstProviderThread.id,
      sessionId: firstProviderThread.sessionId,
      cwd: tmpdir(),
    });
    await rotated.transport.request("turn/start", {
      input: [{ type: "text", text: "second authority epoch" }],
    });
    for await (const event of rotated.transport.notifications()) {
      if (event.method === "paperclip/runResult") break;
    }
    expect(rotated.evidence().diagnostics).toContain(
      "runnerd attached the durable provider session to a fresh PRP run authority",
    );
    expect(await stat(join(stateDirectory, "authority-epochs"))).toBeDefined();
  } finally {
    await rotated.transport.close();
  }
  const resumeFrames = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (entry) =>
        entry.kind === "frame" && entry.direction === "client_to_provider",
    )
    .map(
      (entry) =>
        JSON.parse(
          Buffer.from(String(entry.rawBase64), "base64").toString("utf8"),
        ) as Record<string, unknown>,
    )
    .filter((frame) => frame.method === "thread/resume");
  expect(resumeFrames.length).toBeGreaterThanOrEqual(1);
  for (const frame of resumeFrames) {
    expect(frame).toEqual(
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({ threadId: firstProviderThread.id }),
      }),
    );
  }

  // A remote process owner keeps runner-state outside the controller's local
  // session root. Resume must defer to its explicit state reader instead of
  // rejecting recovery before the remote checkpoint can be made available.
  const externallyOwnedRunnerStateDirectory = join(
    stateDirectory,
    "externally-owned-runner",
  );
  await rename(
    join(stateDirectory, "runner"),
    externallyOwnedRunnerStateDirectory,
  );
  const readRunnerState = async () =>
    JSON.parse(
      await readFile(
        join(externallyOwnedRunnerStateDirectory, "runner-state.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
  const mismatched = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    resumeDynamicTools: dynamicTools,
    prpIdentity: {
      ...secondIdentity,
      runId: "run-cold-other",
      turnId: "turn-cold-other",
      itemId: "item-cold-other",
    },
  });
  await expect(mismatched.transport.request("thread/read", {})).rejects.toThrow(
    "native_runner_prp_run_rotation_unavailable",
  );
  await mismatched.transport.close();

  const restored = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    resumeDynamicTools: dynamicTools,
    prpIdentity: secondIdentity,
  });
  restored.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    const read = await restored.transport.request("thread/read", {});
    expect(read.thread).toMatchObject({
      id: "codex-thread-1",
      cwd: tmpdir(),
    });
    expect(
      (await stat(join(stateDirectory, "codex-home", "skills", "assigned")))
        .mode & 0o222,
    ).toBe(0);
    expect(
      (
        await stat(
          join(stateDirectory, "codex-home", "skills", "assigned", "SKILL.md"),
        )
      ).mode & 0o222,
    ).toBe(0);
    const providerState = JSON.parse(
      await readFile(
        join(externallyOwnedRunnerStateDirectory, "codex-provider-state.json"),
        "utf8",
      ),
    ) as { toolBridge?: { authorized?: Record<string, unknown> } };
    expect(Object.keys(providerState.toolBridge?.authorized ?? {})).toEqual([
      "get_task_context",
      "paperclip_block",
      "paperclip_finish",
    ]);
    await restored.transport.request("turn/start", {
      input: [{ type: "text", text: "restored process" }],
    });
    for await (const event of restored.transport.notifications()) {
      if (event.method === "turn/completed") break;
    }
    expect(restored.evidence()).toMatchObject({
      runnerExited: false,
      codexPid: expect.any(Number),
    });
  } finally {
    await restored.transport.close();
    await releaseMaterializedNativeRuntimeSkills(
      join(stateDirectory, "codex-home", "skills"),
    );
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("adopts a live runner on the same durable authority without spawning a duplicate", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-live-adopt-"));
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  server.on("upgrade", (request, socket, head) => {
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected adoption test listener");
  const registration = async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      release: async () => {
        if (authority === next) authority = null;
      },
    };
  };
  const identity = {
    runnerInstanceId: "runner-live-adopt",
    environmentLeaseId: "lease-live-adopt",
    runId: "run-live-adopt",
    normalizedSessionId: "session-live-adopt",
    turnId: "turn-live-adopt",
    itemId: "item-live-adopt",
  };
  const sharedOptions = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    prpIdentity: identity,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    controlPlaneRegistration: registration,
  };
  const first = createCapabilityRunnerdCodexTransport(sharedOptions);
  let runnerPid: number | null = null;
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | null =
    null;
  try {
    try {
      await first.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: codexSemanticToolSpecs(),
      });
    } catch (error) {
      const stderr = await readFile(
        join(stateDirectory, "diagnostics", "runnerd.stderr.log"),
        "utf8",
      ).catch(() => "");
      throw new Error(
        `${String(error)}\n${JSON.stringify(first.evidence())}${stderr ? `\n${stderr}` : ""}`,
      );
    }
    runnerPid = first.evidence().runnerPid;
    expect(runnerPid).toEqual(expect.any(Number));

    await first.detachControllerForRestart();
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();

    const duplicateLauncher = vi.fn(() => {
      throw new Error("duplicate runner spawn attempted");
    });
    adopted = createCapabilityRunnerdCodexTransport({
      ...sharedOptions,
      resumeDynamicTools: [],
      runnerProcessLauncher: duplicateLauncher,
      adoptExistingRunner: {
        pid: runnerPid!,
        processGroupId: runnerPid,
        startedAt: new Date().toISOString(),
        isAlive: () => {
          try {
            process.kill(runnerPid!, 0);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
    await expect(adopted.transport.request("thread/read", {})).resolves.toEqual(
      expect.objectContaining({
        thread: expect.objectContaining({ id: "codex-thread-1" }),
      }),
    );
    expect(adopted.evidence().runnerPid).toBe(runnerPid);
    expect(duplicateLauncher).not.toHaveBeenCalled();
    expect(adopted.evidence().diagnostics).toContain(
      `adopted runner ${runnerPid} authenticated to its durable PRP authority`,
    );
  } finally {
    await adopted?.transport.close().catch(() => undefined);
    if (runnerPid) {
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        // The adopted runner normally exits after its durable suspend command.
      }
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("surfaces a runner exit while provider-ingress readiness is still pending", async () => {
  const neverReady = new Promise<void>(() => undefined);
  const bundle = createCapabilityRunnerdCodexTransport({
    // The external process launcher owns execution in this test. Point the
    // artifact identity at stable local bytes so the authority still hashes a
    // real file instead of accepting caller-supplied digest metadata.
    runnerBinary: resolve(import.meta.dirname, "../../package.json"),
    runnerProcessLauncher: () => ({
      child: {
        pid: 42,
        exitCode: 1,
        signalCode: null,
        kill: () => true,
      },
      completion: Promise.resolve({
        code: 1,
        signal: null,
        stdout: "",
        stderr: "restored runner could not start",
      }),
    }),
    controlPlaneRegistration: async () => ({
      connection: {
        mode: "listen",
        listenAddress: "0.0.0.0",
        listenPort: 43_127,
        listenPath: "/api/runner/v1/connect/run-ingress-exit",
      },
      ready: () => neverReady,
      startupFailureCode: "runner_ingress_unavailable",
      release: () => undefined,
    }),
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await expect(
      bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
      }),
    ).rejects.toThrow(
      "runner_ingress_unavailable: runnerd exited unexpectedly with code 1: restored runner could not start",
    );
  } finally {
    await bundle.transport.close();
  }
});

it("rejects the notification stream promptly when runnerd exits after accepting a turn", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-exit-stream-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--linger-after-turn-start"),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Wait for another instruction." }],
    });
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    expect((await notifications.next()).value?.method).toBe("turn/started");
    const runnerPid = bundle.evidence().runnerPid;
    expect(runnerPid).not.toBeNull();
    process.kill(runnerPid!, "SIGKILL");
    await expect(
      Promise.race([
        notifications.next(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("notification stream hung")),
            2_000,
          ),
        ),
      ]),
    ).rejects.toThrow("native_runner_process_exited");
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("persists an active provider as settled before bounded suspension", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-active-suspension-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--linger-after-turn-start"),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Wait for another instruction." }],
    });
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    await expect(notifications.next()).resolves.toMatchObject({
      value: { method: "turn/started" },
    });
    await bundle.transport.close();

    const providerState = JSON.parse(
      await readFile(
        join(stateDirectory, "runner", "codex-provider-state.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(providerState).toMatchObject({
      lifecycle: "prepared",
      activeProviderTurnId: null,
    });
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);
