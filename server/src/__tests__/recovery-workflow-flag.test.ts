import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecoveryWorkflowEnabled, getRecoveryWorkflowMode } from "../services/recovery-workflow-flag.js";

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

describe("getRecoveryWorkflowMode", () => {
  const ACTIVE_KEY = "PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES";
  const SHADOW_KEY = "PAPERCLIP_RECOVERY_WORKFLOW_SHADOW_COMPANIES";

  afterEach(() => {
    delete process.env[ACTIVE_KEY];
    delete process.env[SHADOW_KEY];
  });

  it("returns 'off' when both env vars are undefined", () => {
    expect(getRecoveryWorkflowMode("company-1")).toBe("off");
  });

  it("returns 'off' when both env vars are empty", () => {
    process.env[ACTIVE_KEY] = "";
    process.env[SHADOW_KEY] = "";
    expect(getRecoveryWorkflowMode("company-1")).toBe("off");
  });

  it("returns 'active' for a company in ACTIVE list", () => {
    process.env[ACTIVE_KEY] = "company-1,company-2";
    expect(getRecoveryWorkflowMode("company-1")).toBe("active");
    expect(getRecoveryWorkflowMode("company-2")).toBe("active");
  });

  it("returns 'shadow' for a company in SHADOW list only", () => {
    process.env[SHADOW_KEY] = "company-shadow";
    expect(getRecoveryWorkflowMode("company-shadow")).toBe("shadow");
  });

  it("returns 'off' for a company not in either list", () => {
    process.env[ACTIVE_KEY] = "company-1";
    process.env[SHADOW_KEY] = "company-shadow";
    expect(getRecoveryWorkflowMode("company-other")).toBe("off");
  });

  it("active takes precedence when company appears in both lists", () => {
    process.env[ACTIVE_KEY] = "company-both";
    process.env[SHADOW_KEY] = "company-both";
    expect(getRecoveryWorkflowMode("company-both")).toBe("active");
  });

  it("is tolerant of whitespace in shadow list", () => {
    process.env[SHADOW_KEY] = " company-a , company-b ";
    expect(getRecoveryWorkflowMode("company-a")).toBe("shadow");
    expect(getRecoveryWorkflowMode("company-b")).toBe("shadow");
  });

  it("returns 'off' for empty string companyId", () => {
    process.env[ACTIVE_KEY] = "company-1";
    process.env[SHADOW_KEY] = "company-2";
    expect(getRecoveryWorkflowMode("")).toBe("off");
  });
});
