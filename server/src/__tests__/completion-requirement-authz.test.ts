import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  assertNoAgentCompletionRequirementChange,
  assertNoAgentCompletionRequirementSupply,
} from "../routes/completion-requirement-authz.js";

function reqAs(type: "board" | "agent"): Request {
  return { actor: { type, agentId: type === "agent" ? "agent-1" : undefined, userId: type === "board" ? "board-1" : undefined } } as unknown as Request;
}

describe("completion requirement agent guard", () => {
  it("refuses an agent-supplied value on create", () => {
    expect(() =>
      assertNoAgentCompletionRequirementSupply(reqAs("agent"), "workspace_delivery", "the completion requirement"),
    ).toThrow(/cannot set the completion requirement/);
  });

  it("allows an agent to omit the field on create", () => {
    expect(() =>
      assertNoAgentCompletionRequirementSupply(reqAs("agent"), undefined, "the completion requirement"),
    ).not.toThrow();
  });

  it("refuses an agent clearing the field on update", () => {
    expect(() =>
      assertNoAgentCompletionRequirementChange(reqAs("agent"), { defaultCompletionRequirement: null }, "defaultCompletionRequirement", "the workspace default completion requirement"),
    ).toThrow(/cannot set the workspace default completion requirement/);
  });

  it("allows an agent update that does not mention the field", () => {
    expect(() =>
      assertNoAgentCompletionRequirementChange(reqAs("agent"), { cwd: "/tmp/ws" }, "defaultCompletionRequirement", "the workspace default completion requirement"),
    ).not.toThrow();
  });

  it("lets board callers set and clear the field", () => {
    expect(() =>
      assertNoAgentCompletionRequirementSupply(reqAs("board"), "workspace_delivery", "the completion requirement"),
    ).not.toThrow();
    expect(() =>
      assertNoAgentCompletionRequirementChange(reqAs("board"), { defaultCompletionRequirement: null }, "defaultCompletionRequirement", "the workspace default completion requirement"),
    ).not.toThrow();
  });
});
