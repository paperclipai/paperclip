import { describe, it, expect } from "vitest";
import { parseGitHubSourceUrl } from "./company-portability.js";

// ---------------------------------------------------------------------------
// parseGitHubSourceUrl
// ---------------------------------------------------------------------------

describe("parseGitHubSourceUrl", () => {
  it("parses a simple owner/repo GitHub URL", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/my-repo");
    expect(result.owner).toBe("acme");
    expect(result.repo).toBe("my-repo");
    expect(result.ref).toBe("main");
    expect(result.basePath).toBe("");
    expect(result.companyPath).toBe("COMPANY.md");
  });

  it("strips .git suffix from repo name", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/my-repo.git");
    expect(result.repo).toBe("my-repo");
  });

  it("throws for a non-HTTPS URL", () => {
    expect(() => parseGitHubSourceUrl("http://github.com/acme/repo")).toThrow();
  });

  it("throws for a URL with fewer than 2 path segments", () => {
    expect(() => parseGitHubSourceUrl("https://github.com/acme")).toThrow();
  });

  it("parses a tree URL with ref and nested path", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/repo/tree/dev/packages/myapp");
    expect(result.ref).toBe("dev");
    expect(result.basePath).toBe("packages/myapp");
    expect(result.companyPath).toBe("COMPANY.md");
  });

  it("parses a tree URL with just a ref (no extra path)", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/repo/tree/v1.0.0");
    expect(result.ref).toBe("v1.0.0");
    expect(result.basePath).toBe("");
  });

  it("parses a blob URL pointing to a COMPANY.md file", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/repo/blob/main/apps/myapp/COMPANY.md");
    expect(result.ref).toBe("main");
    expect(result.companyPath).toBe("apps/myapp/COMPANY.md");
    expect(result.basePath).toBe("apps/myapp");
  });

  it("uses ?ref query param when present", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/repo?ref=feature/x");
    expect(result.ref).toBe("feature/x");
  });

  it("uses ?path query param to set basePath and companyPath", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/repo?path=packages/agent");
    expect(result.basePath).toBe("packages/agent");
    expect(result.companyPath).toBe("packages/agent/COMPANY.md");
  });

  it("uses ?companyPath query param for an explicit companyPath", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/repo?companyPath=custom/COMPANY.md");
    expect(result.companyPath).toBe("custom/COMPANY.md");
  });

  it("uses 'main' as the default ref when ?ref is not present and no tree/blob path exists", () => {
    const result = parseGitHubSourceUrl("https://github.com/acme/repo");
    expect(result.ref).toBe("main");
  });

  it("preserves the hostname for non-github.com hosts", () => {
    const result = parseGitHubSourceUrl("https://github.example.com/acme/repo");
    expect(result.hostname).toBe("github.example.com");
  });
});
