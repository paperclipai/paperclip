import { describe, expect, it } from "vitest";
import { buildOpenCodePermissionEnv } from "./execute.js";

describe("buildOpenCodePermissionEnv", () => {
  it("returns null for root directory", () => {
    const result = buildOpenCodePermissionEnv("/");
    expect(result).toBeNull();
  });

  it("returns root for single-level path", () => {
    const result = buildOpenCodePermissionEnv("/a");
    const parsed = JSON.parse(result!);
    expect(parsed.external_directory).toEqual({ "/": "allow" });
  });

  it("returns root and parent for two-level path", () => {
    const result = buildOpenCodePermissionEnv("/a/b");
    const parsed = JSON.parse(result!);
    expect(parsed.external_directory).toEqual({
      "/a/**": "allow",
      "/": "allow",
    });
  });

  it("returns three levels for three-level path", () => {
    const result = buildOpenCodePermissionEnv("/a/b/c");
    const parsed = JSON.parse(result!);
    expect(parsed.external_directory).toEqual({
      "/a/b/**": "allow",
      "/a/**": "allow",
      "/": "allow",
    });
  });

  it("returns three parents for four-level path", () => {
    const result = buildOpenCodePermissionEnv("/a/b/c/d");
    const parsed = JSON.parse(result!);
    expect(parsed.external_directory).toEqual({
      "/a/b/c/**": "allow",
      "/a/b/**": "allow",
      "/a/**": "allow",
    });
  });

  it("returns three parents for five-level path", () => {
    const result = buildOpenCodePermissionEnv("/a/b/c/d/e");
    const parsed = JSON.parse(result!);
    expect(parsed.external_directory).toEqual({
      "/a/b/c/d/**": "allow",
      "/a/b/c/**": "allow",
      "/a/b/**": "allow",
    });
  });

  it("handles deep nested paths like paperclip workspace", () => {
    const result = buildOpenCodePermissionEnv("/home/user/.paperclip/instances/default/workspaces/5a59aa42");
    const parsed = JSON.parse(result!);
    expect(parsed.external_directory).toEqual({
      "/home/user/.paperclip/instances/default/workspaces/**": "allow",
      "/home/user/.paperclip/instances/default/**": "allow",
      "/home/user/.paperclip/instances/**": "allow",
    });
  });

  it("handles typical company agent directory", () => {
    const result = buildOpenCodePermissionEnv("/home/user/Documents/paperclip-company/agents/founding-engineer");
    const parsed = JSON.parse(result!);
    expect(parsed.external_directory).toEqual({
      "/home/user/Documents/paperclip-company/agents/**": "allow",
      "/home/user/Documents/paperclip-company/**": "allow",
      "/home/user/Documents/**": "allow",
    });
  });

  it("returns correct parent paths for three-level absolute path", () => {
    const result = buildOpenCodePermissionEnv("/a/b/c");
    expect(result).toContain("/a/b/**");
    expect(result).toContain("/a/**");
    expect(result).toContain("/**");
  });
});

