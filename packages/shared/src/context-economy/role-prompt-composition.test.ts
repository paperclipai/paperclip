import { describe, expect, it } from "vitest";
import {
  ENGINEER_BASELINE_CHAR_BUDGET,
  HEARTBEAT_CHAR_BUDGET,
  selectHeartbeatSections,
  selectInstructionSections,
} from "./role-prompt-composition.js";

describe("role-prompt-composition", () => {
  it("Engineer technical run keeps only mandatory contract sections", () => {
    const sections = selectInstructionSections({
      role: "engineer",
      taskCategory: "technical",
    });
    expect(sections).toContain("workspace-fail-closed");
    expect(sections).toContain("dod-disposition");
    expect(sections).toContain("windows-safety");
    expect(sections).toContain("anti-churn");
    expect(sections).not.toContain("product-ui-api-branding");
  });

  it("Engineer UI run lazy-loads product/UI/branding sections", () => {
    const sections = selectInstructionSections({ role: "engineer", taskCategory: "ui" });
    expect(sections).toContain("product-ui-api-branding");
  });

  it("non-engineer roles still get the mandatory contract", () => {
    const sections = selectInstructionSections({ role: "cto" });
    expect(sections).toContain("security");
    expect(sections).toContain("run-scoped-mutation");
  });

  it("heartbeat keeps mandatory sections, defers interaction/plan/recovery", () => {
    const base = selectHeartbeatSections({ taskCategory: "technical" });
    expect(base).toContain("execution-contract");
    expect(base).toContain("final-disposition");
    expect(base).toContain("control-plane-write-retry");
    expect(base).toContain("security-workspace-rules");
    expect(base).not.toContain("interaction-api-howto");
    expect(base).not.toContain("recovery");
  });

  it("heartbeat adds recovery only on recovery path", () => {
    expect(selectHeartbeatSections({ recovery: true })).toContain("recovery");
    expect(selectHeartbeatSections({})).not.toContain("recovery");
  });

  it("exposes char budgets", () => {
    expect(ENGINEER_BASELINE_CHAR_BUDGET).toBe(6000);
    expect(HEARTBEAT_CHAR_BUDGET).toBe(2000);
  });
});
