import { describe, expect, it } from "vitest";
import { sanitizeWorkspaceRuntimeControlTarget } from "./workspace-runtime-control";

describe("sanitizeWorkspaceRuntimeControlTarget", () => {
  it("drops unexpected keys while preserving the selected runtime target", () => {
    const sanitized = sanitizeWorkspaceRuntimeControlTarget({
      workspaceCommandId: "web",
      runtimeServiceId: "service-1",
      serviceIndex: 2,
      ...( { action: "start" } as Record<string, unknown> ),
    });

    expect(sanitized).toEqual({
      workspaceCommandId: "web",
      runtimeServiceId: "service-1",
      serviceIndex: 2,
    });
    expect("action" in sanitized).toBe(false);
  });

  it("normalizes an omitted target to nullable fields", () => {
    expect(sanitizeWorkspaceRuntimeControlTarget()).toEqual({
      workspaceCommandId: null,
      runtimeServiceId: null,
      serviceIndex: null,
    });
  });
});
