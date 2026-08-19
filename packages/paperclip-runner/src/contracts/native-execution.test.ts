import { describe, expect, it } from "vitest";

import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInputV1 } from "./native-execution.js";

const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: {
    companyId: "company-1",
    runId: "run-1",
    issueId: "issue-1",
    agentId: "agent-1",
    executionWorkspaceId: "workspace-1",
  },
  task: { identifier: "PAP-1", title: "Safe task", description: null, workMode: "standard" },
  workspace: { cwd: "/safe/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: { normalizedSessionId: null, driverKind: "codex_app_server", protocolVersion: 1 },
  completionContract: {
    id: "contract-1",
    sha256: "abc123",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Complete the safe task.",
      criteria: [{ id: "objective", requirement: "The task is complete." }],
    },
  },
  interactionResponses: [],
  credentialBindings: [{
    bindingId: "opaque-binding",
    service: "github",
    destination: "github.com",
    expiresAt: null,
    displayName: "GitHub",
  }],
};

describe("NativeExecutionInputV1", () => {
  it("builds a model envelope without authority or credential bindings", () => {
    const parsed = parseNativeExecutionInput(input);
    const model = buildNativeModelEnvelope(parsed);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("company-1");
    expect(serialized).not.toContain("run-1");
    expect(serialized).not.toContain("opaque-binding");
    expect(model.task.title).toBe("Safe task");
  });

  it("rejects unknown context or environment escape hatches", () => {
    expect(() => parseNativeExecutionInput({ ...input, context: { secret: "canary" } })).toThrow(
      "unknown field context",
    );
    expect(() => parseNativeExecutionInput({
      ...input,
      workspace: { ...input.workspace, env: { PAPERCLIP_API_KEY: "canary" } },
    })).toThrow("unknown field env");
  });
});
