import { describe, expect, it } from "vitest";
import { ApiError } from "../api/api-error";
import { modelStillUnavailableToast } from "./model-retry-refusal";

const agent = { id: "agent-1", name: "Morgan", urlKey: "morgan" };
const refusal = (setting: string) => new ApiError('The provider rejected the model "bad/model", and it is still selected.', 409, {
  error: 'The provider rejected the model "bad/model", and it is still selected.',
  details: { code: "native_provider_model_still_unavailable", setting, rejectedModel: "bad/model", agentId: "agent-1" },
});

describe("modelStillUnavailableToast", () => {
  it("names the setting and links to the agent's model settings", () => {
    expect(modelStillUnavailableToast(refusal("agent_model"), agent)).toMatchObject({
      title: "Model still unavailable", tone: "error",
      body: expect.stringContaining("still selected"),
      action: { label: "Open Morgan model settings", href: "/agents/morgan/runtime" },
    });
  });

  it("explains a task override without linking away from the task", () => {
    const toast = modelStillUnavailableToast(refusal("task_model_override"), agent);
    expect(toast?.title).toBe("Model still unavailable");
    expect(toast?.action).toBeUndefined();
  });

  it("leaves other retry failures to the generic message", () => {
    expect(modelStillUnavailableToast(new ApiError("Conflict", 409, { error: "Conflict" }), agent)).toBeNull();
    expect(modelStillUnavailableToast(new Error("network"), agent)).toBeNull();
  });
});
