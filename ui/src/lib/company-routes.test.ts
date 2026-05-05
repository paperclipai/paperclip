import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  isLocalFilePath,
  toCompanyRelativePath,
} from "./company-routes";

describe("company routes", () => {
  it("treats execution workspace paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123")).toBe(true);
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123/routines")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123",
    );
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123/routines", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123/routines",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123/routines")).toBe(
      "/execution-workspaces/workspace-123/routines",
    );
  });
});

describe("isLocalFilePath", () => {
  it("detects unix filesystem paths", () => {
    expect(isLocalFilePath("/Users/lmorrow/dev/code/docs/branch-and-commit-conventions.md")).toBe(true);
    expect(isLocalFilePath("/home/user/projects/readme.txt")).toBe(true);
    expect(isLocalFilePath("/var/log/app.log")).toBe(true);
    expect(isLocalFilePath("/etc/nginx/nginx.conf")).toBe(true);
    expect(isLocalFilePath("/opt/app/config.yaml")).toBe(true);
    expect(isLocalFilePath("/Volumes/External/file.txt")).toBe(true);
    expect(isLocalFilePath("/tmp/cache/session.json")).toBe(true);
  });

  it("does not flag valid company prefix paths", () => {
    expect(isLocalFilePath("/PAP/issues")).toBe(false);
    expect(isLocalFilePath("/ACME/projects/123")).toBe(false);
    expect(isLocalFilePath("/")).toBe(false);
  });

  it("does not flag short ambiguous roots with only 2 segments as file paths", () => {
    expect(isLocalFilePath("/dev/issues")).toBe(false);
    expect(isLocalFilePath("/tmp/output.log")).toBe(false);
    expect(isLocalFilePath("/var/projects")).toBe(false);
    expect(isLocalFilePath("/sys/agents")).toBe(false);
  });

  it("does not flag paths with extensions in app routes", () => {
    expect(isLocalFilePath("/ACME/docs/changelog.md")).toBe(false);
  });
});

describe("extractCompanyPrefixFromPath rejects filesystem paths", () => {
  it("returns null for local file paths", () => {
    expect(extractCompanyPrefixFromPath("/Users/lmorrow/dev/code/docs/file.md")).toBeNull();
    expect(extractCompanyPrefixFromPath("/home/user/project/README.md")).toBeNull();
    expect(extractCompanyPrefixFromPath("/var/log/app/output.log")).toBeNull();
  });

  it("still extracts valid company prefixes", () => {
    expect(extractCompanyPrefixFromPath("/PAP/issues")).toBe("PAP");
    expect(extractCompanyPrefixFromPath("/acme/projects")).toBe("ACME");
  });
});
