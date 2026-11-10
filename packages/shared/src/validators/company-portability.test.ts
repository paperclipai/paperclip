import { describe, expect, it } from "vitest";
import { portabilitySourceSchema } from "./company-portability.js";

const companyId = "550e8400-e29b-41d4-a716-446655440000";
const workspaceId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

describe("portabilitySourceSchema", () => {
  it("accepts project repository sources with optional safe refs", () => {
    expect(portabilitySourceSchema.parse({
      type: "project_repository",
      companyId,
      workspaceId,
    })).toEqual({ type: "project_repository", companyId, workspaceId });

    expect(portabilitySourceSchema.parse({
      type: "project_repository",
      companyId,
      workspaceId,
      ref: "feature/import-contract",
    })).toEqual({ type: "project_repository", companyId, workspaceId, ref: "feature/import-contract" });
  });

  it("requires UUID company and workspace ids", () => {
    expect(portabilitySourceSchema.safeParse({
      type: "project_repository",
      companyId: "company-1",
      workspaceId,
    }).success).toBe(false);
    expect(portabilitySourceSchema.safeParse({
      type: "project_repository",
      companyId,
      workspaceId: "workspace-1",
    }).success).toBe(false);
  });

  it.each(["", "-option", "../secret", "feature//branch", "branch..name", "branch.lock", "branch/"])(
    "rejects unsafe repository refs: %s",
    (ref) => {
      expect(portabilitySourceSchema.safeParse({
        type: "project_repository",
        companyId,
        workspaceId,
        ref,
      }).success).toBe(false);
    },
  );

  it("continues accepting existing inline and GitHub sources", () => {
    expect(portabilitySourceSchema.safeParse({ type: "inline", files: {} }).success).toBe(true);
    expect(portabilitySourceSchema.safeParse({ type: "github", url: "https://github.com/acme/repo" }).success).toBe(true);
  });
});
