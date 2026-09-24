import { describe, expect, it } from "vitest";
import { cloudAppUrl, cloudPortfolioManageUrl, cloudStackCreateUrl, cloudStackEnterUrl, cloudStackInviteUrl } from "./cloudLinks";

describe("cloudLinks", () => {
  it("resolves stack links against the cloud origin", () => {
    expect(cloudStackEnterUrl("https://app.paperclip.app", "acme")).toBe(
      "https://app.paperclip.app/stacks/acme/enter",
    );
    expect(cloudStackCreateUrl("https://app.paperclip.app")).toBe(
      "https://app.paperclip.app/stacks/new",
    );
    expect(cloudPortfolioManageUrl("https://app.paperclip.app")).toBe(
      "https://app.paperclip.app/orgs?manage=1",
    );
    expect(cloudPortfolioManageUrl(null)).toBeNull();
  });

  it("drops a control-plane path suffix on the configured origin", () => {
    expect(cloudStackEnterUrl("https://cloud.example.test/control-plane", "acme")).toBe(
      "https://cloud.example.test/stacks/acme/enter",
    );
  });

  it("escapes slugs so a crafted portfolio entry cannot climb the path", () => {
    expect(cloudStackEnterUrl("https://app.paperclip.app", "../../evil")).toBe(
      "https://app.paperclip.app/stacks/..%2F..%2Fevil/enter",
    );
  });

  it("opens Cloud People settings on the configured origin with an escaped stack slug", () => {
    expect(cloudStackInviteUrl("https://cloud.example.test/control-plane", "team/with?query")).toBe(
      "https://cloud.example.test/workspaces/team%2Fwith%3Fquery/settings?section=people",
    );
    expect(cloudStackInviteUrl(null, "team")).toBeNull();
    expect(cloudStackInviteUrl("https://cloud.example.test", " ")).toBeNull();
    expect(cloudStackInviteUrl("javascript:alert(1)", "team")).toBeNull();
  });

  it("returns null without a usable base or slug", () => {
    expect(cloudStackEnterUrl(null, "acme")).toBeNull();
    expect(cloudStackEnterUrl("   ", "acme")).toBeNull();
    expect(cloudStackEnterUrl("https://app.paperclip.app", "  ")).toBeNull();
    expect(cloudStackEnterUrl("not a url", "acme")).toBeNull();
    expect(cloudStackCreateUrl(undefined)).toBeNull();
  });

  it("refuses non-web schemes", () => {
    expect(cloudAppUrl("javascript:alert(1)", "/stacks/new")).toBeNull();
    expect(cloudAppUrl("file:///etc", "/stacks/new")).toBeNull();
  });
});
