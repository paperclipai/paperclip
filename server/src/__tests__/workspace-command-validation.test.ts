import { describe, it, expect } from "vitest";
import { validateWorkspaceCommand } from "../services/workspace-runtime.js";

describe("validateWorkspaceCommand", () => {
  it("allows standard package manager commands", () => {
    expect(() => validateWorkspaceCommand("pnpm install")).not.toThrow();
    expect(() => validateWorkspaceCommand("npm run build")).not.toThrow();
    expect(() => validateWorkspaceCommand("yarn add express")).not.toThrow();
    expect(() => validateWorkspaceCommand("bun install")).not.toThrow();
  });

  it("allows git commands", () => {
    expect(() => validateWorkspaceCommand("git status")).not.toThrow();
    expect(() => validateWorkspaceCommand("git checkout -b feature")).not.toThrow();
  });

  it("allows docker commands", () => {
    expect(() => validateWorkspaceCommand("docker build .")).not.toThrow();
    expect(() => validateWorkspaceCommand("docker-compose up -d")).not.toThrow();
  });

  it("allows runtime commands", () => {
    expect(() => validateWorkspaceCommand("node server.js")).not.toThrow();
    expect(() => validateWorkspaceCommand("python3 script.py")).not.toThrow();
    expect(() => validateWorkspaceCommand("cargo build")).not.toThrow();
    expect(() => validateWorkspaceCommand("go run main.go")).not.toThrow();
  });

  it("allows path-prefixed allowed commands", () => {
    expect(() => validateWorkspaceCommand("/usr/bin/git status")).not.toThrow();
    expect(() => validateWorkspaceCommand("/usr/local/bin/node app.js")).not.toThrow();
    expect(() => validateWorkspaceCommand("/home/user/.nvm/versions/node/v20/bin/npx tsx")).not.toThrow();
  });

  it("rejects disallowed commands", () => {
    expect(() => validateWorkspaceCommand("rm -rf /")).toThrow(/not in the allowed commands list/);
    expect(() => validateWorkspaceCommand("cat /etc/passwd")).toThrow(/not in the allowed commands list/);
    expect(() => validateWorkspaceCommand("nc -l 4444")).toThrow(/not in the allowed commands list/);
    expect(() => validateWorkspaceCommand("chmod 777 /tmp/evil")).toThrow(/not in the allowed commands list/);
  });

  it("rejects empty commands", () => {
    expect(() => validateWorkspaceCommand("")).toThrow(/Empty command/);
    expect(() => validateWorkspaceCommand("   ")).toThrow(/Empty command/);
  });

  it("rejects commands with leading whitespace but disallowed binary", () => {
    expect(() => validateWorkspaceCommand("  rm -rf /")).toThrow(/not in the allowed commands list/);
  });

  it("allows shell commands (sh, bash) as first token", () => {
    expect(() => validateWorkspaceCommand("sh -c 'echo hello'")).not.toThrow();
    expect(() => validateWorkspaceCommand("bash -c 'pnpm install'")).not.toThrow();
  });

  it("allows curl and wget", () => {
    expect(() => validateWorkspaceCommand("curl https://example.com")).not.toThrow();
    expect(() => validateWorkspaceCommand("wget https://example.com/file.tar.gz")).not.toThrow();
  });
});
