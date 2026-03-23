import { describe, expect, it } from "vitest";
import { isHttpUrl, isGithubUrl } from "../commands/client/company.js";

describe("isHttpUrl", () => {
  it("matches http URLs", () => {
    expect(isHttpUrl("http://example.com/foo")).toBe(true);
  });

  it("matches https URLs", () => {
    expect(isHttpUrl("https://example.com/foo")).toBe(true);
  });

  it("rejects local paths", () => {
    expect(isHttpUrl("/tmp/my-company")).toBe(false);
    expect(isHttpUrl("./relative")).toBe(false);
  });
});

describe("isGithubUrl", () => {
  it("matches GitHub URLs", () => {
    expect(isGithubUrl("https://github.com/org/repo")).toBe(true);
  });

  it("rejects non-GitHub HTTP URLs", () => {
    expect(isGithubUrl("https://example.com/foo")).toBe(false);
  });

  it("rejects local paths", () => {
    expect(isGithubUrl("/tmp/my-company")).toBe(false);
  });
});
