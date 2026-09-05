import { describe, expect, it } from "bun:test";
import { forbidden } from "../errors.js";
import { createHttpAuthorization } from "./authorization.js";
import type { HttpActor } from "./actor-context.js";

const board: HttpActor = {
  type: "board",
  source: "session",
  companyIds: ["company-a"],
  memberships: [
    { companyId: "company-a", membershipRole: "member", status: "active" },
  ],
};

const viewer: HttpActor = {
  ...board,
  memberships: [
    { companyId: "company-a", membershipRole: "viewer", status: "active" },
  ],
};

describe("HTTP authorization helper", () => {
  it("returns the actor when access is allowed", () => {
    const authorization = createHttpAuthorization(board, "PATCH");

    expect(authorization.requireCompany("company-a")).toBe(board);
  });

  it("throws the stable domain error for a denied company", () => {
    const authorization = createHttpAuthorization(board, "GET");

    expect(() => authorization.requireCompany("company-b")).toThrow(
      "User does not have access to this company",
    );
  });

  it("throws the viewer denial for unsafe operations", () => {
    const authorization = createHttpAuthorization(viewer, "PATCH");

    expect(() => authorization.requireCompany("company-a")).toThrow(
      "Viewer access is read-only",
    );
  });

  it("supports explicit permission checks without swallowing errors", () => {
    const authorization = createHttpAuthorization(board, "POST");

    expect(() => authorization.require(false, forbidden("Missing permission"))).toThrow(
      "Missing permission",
    );
    expect(authorization.require(true, forbidden("must not throw"))).toBeUndefined();
  });
});
