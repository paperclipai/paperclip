import { describe, expect, it } from "vitest";
import { cloudAppUrl, cloudPortfolioManageUrl, cloudStackCreateUrl, cloudStackInviteUrl } from "./cloudLinks";

describe("cloudLinks", () => {
  it("resolves stack links against the cloud origin", () => {
    expect(cloudStackCreateUrl("https://app.paperclip.app")).toBe(
      "https://app.paperclip.app/stacks/new",
    );
    expect(cloudPortfolioManageUrl("https://app.paperclip.app")).toBe(
      "https://app.paperclip.app/orgs?manage=1",
    );
    expect(cloudPortfolioManageUrl(null)).toBeNull();
  });

  it("opens Cloud People settings on the configured origin with an escaped stack slug", () => {
    expect(cloudStackInviteUrl("https://cloud.example.test/control-plane", "team/with?query")).toBe(
      "https://cloud.example.test/workspaces/team%2Fwith%3Fquery/settings?section=people",
    );
    expect(cloudStackInviteUrl(null, "team")).toBeNull();
    expect(cloudStackInviteUrl("https://cloud.example.test", " ")).toBeNull();
    expect(cloudStackInviteUrl("javascript:alert(1)", "team")).toBeNull();
  });

  it("returns null without a usable base", () => {
    expect(cloudStackCreateUrl(undefined)).toBeNull();
  });

  it("refuses non-web schemes", () => {
    expect(cloudAppUrl("javascript:alert(1)", "/stacks/new")).toBeNull();
    expect(cloudAppUrl("file:///etc", "/stacks/new")).toBeNull();
  });
});
