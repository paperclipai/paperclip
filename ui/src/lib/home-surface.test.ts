import { describe, expect, it } from "vitest";
import {
  loadLastHomeSurface,
  resolveCompanyHomePath,
  saveLastHomeSurface,
} from "./home-surface";

describe("home-surface", () => {
  it("remembers and restores the last surface per company", () => {
    saveLastHomeSurface("company-1", "channels");
    expect(loadLastHomeSurface("company-1")).toBe("channels");
    expect(loadLastHomeSurface("company-2")).toBeNull();
  });

  it("defaults new channel-enabled companies to Channels", () => {
    expect(resolveCompanyHomePath({
      companyId: "fresh",
      issuePrefix: "PAP",
      channelsEnabled: true,
      hasProject: true,
    })).toBe("/PAP/channels");
  });

  it("falls back to dashboard when channels are off", () => {
    expect(resolveCompanyHomePath({
      companyId: "legacy",
      issuePrefix: "PAP",
      channelsEnabled: false,
      hasProject: true,
    })).toBe("/PAP/dashboard");
  });
});
