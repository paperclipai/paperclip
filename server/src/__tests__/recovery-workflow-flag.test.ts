import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecoveryWorkflowEnabled } from "../services/recovery-workflow-flag.js";

describe("isRecoveryWorkflowEnabled", () => {
  const ENV_KEY = "PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES";

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("returns false when env is undefined", () => {
    delete process.env[ENV_KEY];
    expect(isRecoveryWorkflowEnabled("company-1")).toBe(false);
  });

  it("returns false when env is empty string", () => {
    process.env[ENV_KEY] = "";
    expect(isRecoveryWorkflowEnabled("company-1")).toBe(false);
  });

  it("returns false when env is only whitespace", () => {
    process.env[ENV_KEY] = "   ";
    expect(isRecoveryWorkflowEnabled("company-1")).toBe(false);
  });

  it("returns true for a listed company id", () => {
    process.env[ENV_KEY] = "company-1,company-2";
    expect(isRecoveryWorkflowEnabled("company-1")).toBe(true);
    expect(isRecoveryWorkflowEnabled("company-2")).toBe(true);
  });

  it("returns false for a company id not in the list", () => {
    process.env[ENV_KEY] = "company-1,company-2";
    expect(isRecoveryWorkflowEnabled("company-3")).toBe(false);
  });

  it("is tolerant of surrounding whitespace in company ids", () => {
    process.env[ENV_KEY] = " company-1 , company-2 ";
    expect(isRecoveryWorkflowEnabled("company-1")).toBe(true);
    expect(isRecoveryWorkflowEnabled("company-2")).toBe(true);
  });

  it("is tolerant of trailing commas", () => {
    process.env[ENV_KEY] = "company-1,company-2,";
    expect(isRecoveryWorkflowEnabled("company-1")).toBe(true);
    expect(isRecoveryWorkflowEnabled("company-2")).toBe(true);
  });

  it("returns false for empty string company id even when env has entries", () => {
    process.env[ENV_KEY] = "company-1";
    expect(isRecoveryWorkflowEnabled("")).toBe(false);
  });

  it("is case-sensitive", () => {
    process.env[ENV_KEY] = "company-1";
    expect(isRecoveryWorkflowEnabled("Company-1")).toBe(false);
    expect(isRecoveryWorkflowEnabled("COMPANY-1")).toBe(false);
  });
});
