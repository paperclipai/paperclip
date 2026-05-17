import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("PAPERCLIP_STRANDED_ISSUE_RECOVERY_ENABLED", () => {
  const key = "PAPERCLIP_STRANDED_ISSUE_RECOVERY_ENABLED";

  afterEach(() => {
    delete process.env[key];
  });

  it("defaults to enabled when unset", () => {
    delete process.env[key];
    expect(loadConfig().strandedIssueRecoveryEnabled).toBe(true);
  });

  it("disables stranded recovery only when set to false", () => {
    process.env[key] = "false";
    expect(loadConfig().strandedIssueRecoveryEnabled).toBe(false);
  });
});
