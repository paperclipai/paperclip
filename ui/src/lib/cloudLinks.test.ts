import { describe, expect, it } from "vitest";
import { cloudAppUrl, cloudPortfolioManageUrl, cloudStackCreateUrl, cloudStackInviteUrl, cloudStackEntryUrl, tenantSignInReturnPath } from "./cloudLinks";

describe("cloudLinks", () => {
  it.each(["https://my.paperclip.app", "https://my-staging.paperclip.app", "http://cloud.localhost:3200"])(
    "renews the session through the configured Cloud origin %s", (origin) => {
      const url = new URL(cloudStackEntryUrl(`${origin}/control-plane`, "team", "/TEST/issues/TEST-1?tab=activity#comment")!);
      expect(url.origin).toBe(origin);
      expect(url.pathname).toBe("/v1/stacks/team/entry-redirect");
      expect(url.searchParams.get("returnTo")).toBe("/TEST/issues/TEST-1?tab=activity#comment");
    },
  );

  it.each(["https://evil.test", "//evil.test", "/\\evil.test", "/\n/evil.test", "/auth?next=/auth", "/auth/", "/a/../auth"])(
    "rejects unsafe or recursive return targets: %j", (path) => {
      expect(tenantSignInReturnPath(path)).toBe("/");
    },
  );

  it("requires complete Cloud metadata", () => {
    expect(cloudStackEntryUrl(null, "team", "/")).toBeNull();
    expect(cloudStackEntryUrl("https://my.paperclip.app", null, "/")).toBeNull();
    expect(cloudStackEntryUrl("javascript:alert(1)", "team", "/")).toBeNull();
  });
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
