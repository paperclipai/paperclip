import { describe, expect, it } from "vitest";
import { cloudAppUrl, cloudStackCreateUrl, cloudStackEnterUrl } from "./cloudLinks";

describe("cloudLinks", () => {
  it("resolves stack links against the cloud origin", () => {
    expect(cloudStackEnterUrl("https://app.paperclip.app", "acme")).toBe(
      "https://app.paperclip.app/stacks/acme/enter",
    );
    expect(cloudStackCreateUrl("https://app.paperclip.app")).toBe(
      "https://app.paperclip.app/stacks/new",
    );
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
