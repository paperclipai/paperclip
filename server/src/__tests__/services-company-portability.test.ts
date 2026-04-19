import { describe, expect, it } from "vitest";
import {
  companyPortabilityService,
  parseGitHubSourceUrl,
} from "../services/company-portability.js";

describe("services/company-portability.ts", () => {
  it("parses tree GitHub URLs into owner/repo/ref/base path", () => {
    expect(
      parseGitHubSourceUrl("https://github.com/paperclipai/paperclip/tree/main/examples/company"),
    ).toEqual({
      hostname: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      ref: "main",
      basePath: "examples/company",
      companyPath: "COMPANY.md",
    });
  });

  it("parses blob GitHub URLs into explicit companyPath", () => {
    expect(
      parseGitHubSourceUrl("https://github.com/paperclipai/paperclip/blob/main/examples/company/COMPANY.md"),
    ).toEqual({
      hostname: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      ref: "main",
      basePath: "examples/company",
      companyPath: "examples/company/COMPANY.md",
    });
  });

  it("supports query-based GitHub source overrides", () => {
    expect(
      parseGitHubSourceUrl(
        "https://github.com/paperclipai/paperclip?ref=feat%2Fportable&path=packages/company&companyPath=packages/company/COMPANY.md",
      ),
    ).toEqual({
      hostname: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      ref: "feat/portable",
      basePath: "packages/company",
      companyPath: "packages/company/COMPANY.md",
    });
  });

  it("rejects non-https GitHub URLs", () => {
    expect(() => parseGitHubSourceUrl("http://github.com/paperclipai/paperclip")).toThrow(
      "GitHub source URL must use HTTPS",
    );
  });

  it("exposes portability service methods", () => {
    const service = companyPortabilityService({} as any);
    expect(service).toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
      previewExport: expect.any(Function),
      previewImport: expect.any(Function),
    });
  });
});

