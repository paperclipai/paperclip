import { describe, expect, it } from "vitest";

import type { PaperclipSemanticToolDefinition } from "./types.js";
import { createPaperclipRunnerAuthorizedToolSet } from "./runner-authorized-tools.js";

function definition(
  name: "get_task_context" | "get_task_history",
): PaperclipSemanticToolDefinition {
  return {
    name,
    description:
      name === "get_task_context"
        ? "Read the active task context."
        : "Read bounded comments on the active task.",
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
}

describe("runner authorized tool projection", () => {
  it("matches the Rust catalog digest vector", () => {
    const set = createPaperclipRunnerAuthorizedToolSet([
      definition("get_task_context"),
    ]);

    expect(set).toMatchObject({
      schema: "paperclip.runner.authorized-tools.v1",
      schemaVersion: 1,
      catalogDigest:
        "sha256:4e0332535c9e2ff1f5e43089517ee1b46654bfc9cb2ed51efbea4be50db21009",
      operations: [
        {
          operationId: "get_task_context",
          version: 1,
          responseSchema: { type: "object" },
        },
      ],
    });
  });

  it("matches Rust number canonicalization at JavaScript's decimal boundary", () => {
    const base = definition("get_task_context");
    const set = createPaperclipRunnerAuthorizedToolSet([
      {
        ...base,
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", default: 1.0 },
            epsilon: { type: "number", default: 1e-6 },
          },
        },
      },
    ]);

    expect(set.catalogDigest).toBe(
      "sha256:1c93693d9b5b48b46c83cd1c11d1ea329774f1b9b0ae741197cb2b8e992c4b8d",
    );
  });

  it("uses operation identity order and rejects duplicates", () => {
    const reverse = createPaperclipRunnerAuthorizedToolSet([
      definition("get_task_history"),
      definition("get_task_context"),
    ]);
    const ordered = createPaperclipRunnerAuthorizedToolSet([
      definition("get_task_context"),
      definition("get_task_history"),
    ]);

    expect(reverse).toEqual(ordered);
    expect(() =>
      createPaperclipRunnerAuthorizedToolSet([
        definition("get_task_context"),
        definition("get_task_context"),
      ]),
    ).toThrow("paperclip_runner_authorized_tools_invalid");
  });
});
