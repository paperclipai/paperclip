import { describe, expect, it } from "vitest";
import manifest from "./manifest.js";
import { buildShellCommand, parseNovitaDriverConfig } from "./plugin.js";

describe("Novita sandbox provider plugin", () => {
  it("declares a sandbox provider environment driver", () => {
    expect(manifest.capabilities).toContain("environment.drivers.register");
    expect(manifest.environmentDrivers).toHaveLength(1);
    expect(manifest.environmentDrivers?.[0]).toMatchObject({
      driverKey: "novita",
      kind: "sandbox_provider",
      displayName: "Novita Agent Sandbox",
    });
  });

  it("parses defaults", () => {
    expect(parseNovitaDriverConfig({})).toMatchObject({
      apiKey: null,
      domain: null,
      template: null,
      requestedCwd: "/home/user/paperclip-workspace",
      timeoutMs: 300_000,
      requestTimeoutMs: 30_000,
      secure: null,
      autoPause: false,
      reuseLease: false,
    });
  });

  it("parses configured values", () => {
    expect(parseNovitaDriverConfig({
      apiKey: "sk-test",
      domain: "https://sandbox.example.test",
      template: "paperclip-template",
      requestedCwd: "/workspace",
      timeoutMs: 600000,
      requestTimeoutMs: 45000,
      secure: true,
      autoPause: true,
      reuseLease: true,
    })).toMatchObject({
      apiKey: "sk-test",
      domain: "https://sandbox.example.test",
      template: "paperclip-template",
      requestedCwd: "/workspace",
      timeoutMs: 600_000,
      requestTimeoutMs: 45_000,
      secure: true,
      autoPause: true,
      reuseLease: true,
    });
  });

  it("builds a quoted shell command with cwd, env, args, and stdin", () => {
    const command = buildShellCommand({
      command: "node",
      args: ["-e", "console.log(process.env.MESSAGE)"],
      cwd: "/workspace/project",
      env: { MESSAGE: "hello world" },
      stdin: "input body",
    });

    expect(command).toContain("cd '/workspace/project'");
    expect(command).toContain("export MESSAGE='hello world';");
    expect(command).toContain("'node' '-e' 'console.log(process.env.MESSAGE)'");
    expect(command).toContain("PAPERCLIP_STDIN_");
    expect(command).toContain("< /tmp/.paperclip-stdin");
  });

  it("does not use the fixed stdin heredoc delimiter", () => {
    const command = buildShellCommand({
      command: "cat",
      stdin: "before\nPAPERCLIP_STDIN\nafter",
    });

    expect(command).toContain("before\nPAPERCLIP_STDIN\nafter");
    expect(command).toMatch(/<<'PAPERCLIP_STDIN_[A-Z0-9]+'/);
    expect(command).not.toContain("<<'PAPERCLIP_STDIN'\n");
  });

  it("rejects unsafe environment variable keys", () => {
    expect(() => buildShellCommand({
      command: "env",
      env: { "BAD-KEY": "value" },
    })).toThrow("Invalid sandbox environment variable key");
  });
});
