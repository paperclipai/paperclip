import { describe, expect, it } from "vitest";

import type { PaperclipSemanticToolDefinition } from "../../vendor/paperclip-runner/index.js";
import {
  buildNativeRunnerArguments,
  buildNativeRunnerPreparePayload,
} from "./native-codex-runner.js";

describe("buildNativeRunnerArguments", () => {
  it("binds every durable identity without exposing the bootstrap ticket", () => {
    const args = buildNativeRunnerArguments({
      connectUrl: "ws://127.0.0.1:3000/api/runner/v1/connect/run-1",
      stateDirectory: "/tmp/runner-state",
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      maxRuntimeMs: 60_000,
    });
    expect(args).toContain("--connect-url");
    expect(args).toContain("--runner-digest");
    expect(args.join(" ")).not.toContain("bootstrap");
  });
});

const tool: PaperclipSemanticToolDefinition = {
  name: "get_task_context",
  description: "Read the active task context.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  annotations: {
    semanticContract: "paperclip.semantic-action.v1",
    version: 1,
    placement: "always",
    effect: "read",
    requiredClaims: [],
  },
};

describe("buildNativeRunnerPreparePayload", () => {
  it("binds the coordinator tool projection to run.prepare", () => {
    expect(buildNativeRunnerPreparePayload({
      cwd: "/workspace",
      model: "test-model",
      resumeProviderSessionId: "thread-1",
      completionContract: { revision: "1", criterionIds: ["objective"] },
      semanticTools: [tool],
      providerLaunch: {
        command: "/bin/fake-codex",
        args: ["app-server"],
        providerVersion: "fake-1",
      },
    })).toMatchObject({
      provider: {
        kind: "codex",
        provider: "codex",
        driver: "codex_app_server",
        providerSessionId: "thread-1",
      },
      authorizedTools: {
        schema: "paperclip.runner.authorized-tools.v1",
        schemaVersion: 1,
        catalogDigest:
          "sha256:4e0332535c9e2ff1f5e43089517ee1b46654bfc9cb2ed51efbea4be50db21009",
        operations: [{ operationId: "get_task_context", version: 1 }],
      },
    });
  });
});
