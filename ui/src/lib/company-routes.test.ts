import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";

describe("company routes", () => {
  it("treats execution workspace paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
  });

  it("treats deliverables paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/deliverables")).toBe(true);
    expect(extractCompanyPrefixFromPath("/deliverables")).toBeNull();
    expect(applyCompanyPrefix("/deliverables", "TES")).toBe("/TES/deliverables");
    expect(applyCompanyPrefix("/deliverables/deliverable-123", "TES")).toBe(
      "/TES/deliverables/deliverable-123",
    );
    expect(toCompanyRelativePath("/TES/deliverables/deliverable-123")).toBe(
      "/deliverables/deliverable-123",
    );
  });
});
