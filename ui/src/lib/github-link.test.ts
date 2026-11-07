import { describe, expect, it } from "vitest";
import { parseGitHubLink } from "./github-link";

describe("GitHub inline link presentation", () => {
  it.each([
    ["https://github.com/github/docs", "repository", "github/docs"],
    ["https://github.com/paperclipai/paperclip", "repository", "paperclipai/paperclip"],
    ["https://github.com/paperclipai/paperclip/", "repository", "paperclipai/paperclip"],
    ["https://github.com/acme/web/pull/241", "pull_request", "acme/web#241"],
    ["HTTPS://WWW.GITHUB.COM/Acme/Web/pull/241/files?diff=split#diff-a", "pull_request", "Acme/Web#241"],
    ["https://github.com/acme/web/issues/42#issuecomment-123", "issue", "acme/web#42"],
    ["https://github.com/acme/web/issues/42/?q=test", "issue", "acme/web#42"],
  ])("classifies %s", (href, kind, label) => {
    expect(parseGitHubLink(href)).toMatchObject({ kind, label });
  });

  it.each([
    "https://github.com", "https://github.com/paperclipai",
    "https://github.com/acme/web/tree/main", "https://github.com/acme/web/pull/nope",
    "https://github.com/acme/web/issues/0", "https://github.com/settings/profile",
    "https://github.com/features/actions", "https://github.com/orgs/acme",
    "https://github.com/stars/torvalds", "https://github.com/education/teachers",
    "https://github.com/enterprises/acme",
    "https://github.com/acme/web/pulls", "https://github.com/acme/web/issues",
  ])("keeps GitHub pages without a resource match as branded links: %s", (href) => {
    expect(parseGitHubLink(href)).toEqual({ kind: "github", label: null, description: "GitHub" });
  });

  it.each([
    undefined, "", "/acme/web/pull/241", "//github.com/acme/web/pull/241",
    "https://example.com/acme/web/pull/241", "https://github.com.example.com/acme/web/pull/241",
    "https://github.example.com/acme/web/pull/241", "https://github.com@evil.example/acme/web",
    "https://someone@github.com/acme/web", "https://github.com:8443/acme/web",
    "http://github.com/acme/web", "javascript:alert(1)", "not a URL",
  ])("does not apply GitHub presentation to %s", (href) => {
    expect(parseGitHubLink(href)).toBeNull();
  });
});
