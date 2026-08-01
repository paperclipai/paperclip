import { describe, expect, it } from "vitest";
import {
  buildCompanyScopedDeleteOrder,
  type RestrictiveForeignKeyEdge,
} from "../services/companies.js";

function edge(
  childTable: string,
  parentTable: string,
  overrides: Partial<RestrictiveForeignKeyEdge> = {},
): RestrictiveForeignKeyEdge {
  return {
    childSchema: "public",
    childTable,
    parentSchema: "public",
    parentTable,
    constraintName: `${childTable}_${parentTable}_fk`,
    ...overrides,
  };
}

describe("buildCompanyScopedDeleteOrder", () => {
  it("orders restrictive children before their parents", () => {
    expect(buildCompanyScopedDeleteOrder(
      ["agents", "issues", "issue_thread_interactions"],
      [edge("issue_thread_interactions", "issues"), edge("issues", "agents")],
    )).toEqual(["issue_thread_interactions", "issues", "agents"]);
  });

  it("refuses restrictive references from outside the company-scoped set", () => {
    expect(() => buildCompanyScopedDeleteOrder(
      ["issues"],
      [edge("global_audit", "issues")],
    )).toThrow(/restrictive external FK/);
  });

  it("refuses restrictive cycles", () => {
    expect(() => buildCompanyScopedDeleteOrder(
      ["left_table", "right_table"],
      [edge("left_table", "right_table"), edge("right_table", "left_table")],
    )).toThrow(/restrictive FK cycle/);
  });

  it("refuses unsafe table identifiers", () => {
    expect(() => buildCompanyScopedDeleteOrder(["safe", "bad;drop table companies"], []))
      .toThrow(/unsafe table identifier/);
  });
});