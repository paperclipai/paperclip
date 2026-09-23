import { describe, expect, it } from "vitest";
import { assertKnownIssueAssigneeAdapterModel } from "../services/issue-assignee-adapter-overrides.js";

describe("issue assignee adapter model overrides", () => {
  it("rejects a model that the assignee adapter does not advertise", () => {
    expect(() =>
      assertKnownIssueAssigneeAdapterModel(
        "opencode_local",
        { adapterConfig: { model: "openai/gpt-5.4-mini" } },
        [{ id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" }],
      ),
    ).toThrowError(
      expect.objectContaining({
        status: 422,
        details: expect.objectContaining({
          code: "issue_assignee_adapter_model_unknown",
          adapterType: "opencode_local",
          model: "openai/gpt-5.4-mini",
        }),
      }),
    );
  });

  it("allows an override when the adapter has no model catalog", () => {
    expect(() =>
      assertKnownIssueAssigneeAdapterModel(
        "external_adapter",
        { adapterConfig: { model: "provider/model" } },
        [],
      ),
    ).not.toThrow();
  });

  it("rejects a non-string model instead of persisting an unusable override", () => {
    expect(() =>
      assertKnownIssueAssigneeAdapterModel(
        "opencode_local",
        { adapterConfig: { model: null } },
        [{ id: "provider/model", label: "Provider model" }],
      ),
    ).toThrowError(
      expect.objectContaining({
        status: 422,
        details: expect.objectContaining({
          code: "issue_assignee_adapter_model_invalid",
          adapterType: "opencode_local",
        }),
      }),
    );
  });
});
