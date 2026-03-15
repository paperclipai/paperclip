import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveManagedProjectWorkspaceDir,
  resolvePaperclipInstanceRoot,
} from "../home-paths.js";

const ORIGINAL_ENV = { ...process.env };

describe("resolveManagedProjectWorkspaceDir", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("resolves to instance-root/project-workspaces/<projectId>/<workspaceId>", () => {
    const projectId = "abc-123";
    const workspaceId = "ws-456";
    const result = resolveManagedProjectWorkspaceDir(projectId, workspaceId);
    const expected = path.resolve(
      resolvePaperclipInstanceRoot(),
      "project-workspaces",
      projectId,
      workspaceId,
    );
    expect(result).toBe(expected);
  });

  it("rejects invalid project id characters", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir("bad/project", "ws-1"),
    ).toThrow(/Invalid project id/);
  });

  it("rejects invalid workspace id characters", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir("project-1", "bad/ws"),
    ).toThrow(/Invalid workspace id/);
  });

  it("rejects empty project id", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir("", "ws-1"),
    ).toThrow(/Invalid project id/);
  });

  it("rejects empty workspace id", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir("project-1", ""),
    ).toThrow(/Invalid workspace id/);
  });

  it("accepts UUIDs without hyphens issue (UUID segments are alphanumeric+hyphen)", () => {
    // UUIDs like "e2ff27d5-2e09-4779-8316-e1da466b7f4c" use hyphens which are allowed
    const result = resolveManagedProjectWorkspaceDir(
      "e2ff27d5-2e09-4779-8316-e1da466b7f4c",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(result).toContain("project-workspaces");
    expect(result).toContain("e2ff27d5-2e09-4779-8316-e1da466b7f4c");
  });
});
