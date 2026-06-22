import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { modelPoliciesApi } from "./modelPolicies";
import type { ModelPolicyRule } from "./modelPolicies";

describe("modelPoliciesApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.put.mockReset();
    mockApi.get.mockResolvedValue({ rules: [] });
    mockApi.put.mockResolvedValue({ rules: [] });
  });

  it("GETs the company model policy at the company-scoped path", async () => {
    await modelPoliciesApi.get("company 1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company%201/model-policies");
  });

  it("PUTs the full rules array as { rules }", async () => {
    const rules: ModelPolicyRule[] = [
      { when: { issuePriority: ["high"] }, modelProfile: "deep", reason: "urgent" },
      { when: {}, modelProfile: "cheap" },
    ];
    await modelPoliciesApi.save("c1", rules);
    expect(mockApi.put).toHaveBeenCalledWith("/companies/c1/model-policies", { rules });
  });
});
