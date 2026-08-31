import { describe, expect, it } from "vitest";

import type { NativeExecutionInput } from "../contracts/native-execution.js";
import { createNativeSessionBackend } from "../index.js";
import { createCodexNativeSessionBackend } from "./codex-native-backend.js";

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
      model:
        agent === "codex"
          ? "gpt-5.6-sol"
          : agent === "pi"
            ? "openrouter/deepseek/deepseek-v4-flash-0731"
            : "claude-sonnet-5",
      permissionPolicy: "interactive",
      profile: {
        driverKind: "acpx_runtime",
        protocolVersion: 1,
        acpxVersion: "0.13.1",
        agent,
        agentProfileVersion: 1,
        agentServerPackage:
          agent === "codex"
            ? "@agentclientprotocol/codex-acp"
            : agent === "pi"
              ? "pi-acp"
              : "@agentclientprotocol/claude-agent-acp",
        agentServerVersion:
          agent === "codex" ? "1.6.2" : agent === "pi" ? "0.0.33" : "0.70.0",
        agentRuntimePackage:
          agent === "pi" ? "@earendil-works/pi-coding-agent" : null,
        agentRuntimeVersion: agent === "pi" ? "0.84.2" : null,
        commandDigest:
          agent === "codex"
            ? "sha256:94049b3e3c3aee87de62703786e4fa81d031d7bd979f99bdf516d84f28791a79"
            : agent === "pi"
              ? "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f"
              : "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
      },
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

describe("native backend factory", () => {
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

  it("requires an explicit runtime root for OpenCode", () => {
    expect(() =>
      createNativeSessionBackend(opencodeExecution()),
    ).toThrow("OpenCode native backend requires an instance runtime directory");
  });

  it("constructs the OpenCode backend without starting its process", async () => {
    const backend = createNativeSessionBackend(opencodeExecution(), {
      opencodeRuntimeDirectory: "/runtime",
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "opencode_server",
      version: "1.18.17",
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

  it("requires an explicit runtime root", () => {
    expect(() => createNativeSessionBackend(acpxExecution())).toThrow(
      "requires an instance runtime directory",
    );
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

  it("rejects Pi before constructing an ACPX backend", () => {
    expect(() =>
      createNativeSessionBackend(acpxExecution("pi"), {
        acpxRuntimeDirectory: "/runtime",
      }),
    ).toThrow("descriptor-confined verified launch");
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
});
