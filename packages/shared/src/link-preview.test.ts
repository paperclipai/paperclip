import { describe, expect, it } from "vitest";
import { recognizeLinkPreview } from "./link-preview.js";

describe("link preview recognition", () => {
  it("shares PR identity across casing, diff paths, queries and fragments", () => {
    expect(recognizeLinkPreview("https://WWW.GitHub.com/Acme/Web/pull/42/files?diff=split#review")?.canonicalUrl)
      .toBe("https://github.com/acme/web/pull/42");
    expect(recognizeLinkPreview("https://github.com/Acme/Web/pull/42")?.label).toBe("Acme/Web#42");
  });
  it.each([
    "http://github.com/acme/web/pull/42", "https://github.com.example.com/acme/web/pull/42",
    "https://user:pass@github.com/acme/web/pull/42", "https://github.com:444/acme/web/pull/42",
    "https://github.com/acme/web/issues/42", "https://github.com/acme/web/pull/42oops",
    "https://github.com/acme/web/pull/0", "https://github.com/acme/web/pull/9007199254740992",
    "https://example.com", "/acme/web/pull/42", "not a URL",
  ])("does not resolve an unsupported or unsafe URL: %s", url => {
    expect(recognizeLinkPreview(url)).toBeNull();
  });
});
