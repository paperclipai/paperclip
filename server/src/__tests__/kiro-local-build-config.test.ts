import { describe, expect, it } from "vitest";
import { buildAdapterConfig } from "@paperclipai/adapter-kiro-local/ui";

describe("buildAdapterConfig", () => {
  describe("command", () => {
    it("persists trimmed command", () => {
      const cfg = buildAdapterConfig({ command: "  kiro-cli  " });
      expect(cfg.command).toBe("kiro-cli");
    });

    it("omits command when empty", () => {
      const cfg = buildAdapterConfig({ command: "" });
      expect(cfg.command).toBeUndefined();
    });

    it("omits command when whitespace-only", () => {
      const cfg = buildAdapterConfig({ command: "   " });
      expect(cfg.command).toBeUndefined();
    });
  });

  describe("model", () => {
    it("persists trimmed model", () => {
      const cfg = buildAdapterConfig({ model: "  claude-sonnet-4.5  " });
      expect(cfg.model).toBe("claude-sonnet-4.5");
    });

    it("omits model when empty", () => {
      const cfg = buildAdapterConfig({ model: "" });
      expect(cfg.model).toBeUndefined();
    });
  });

  describe("workspace strategy: cwd", () => {
    it("persists trimmed cwd", () => {
      const cfg = buildAdapterConfig({ cwd: "  /workspace/project  " });
      expect(cfg.cwd).toBe("/workspace/project");
    });

    it("omits cwd when empty", () => {
      const cfg = buildAdapterConfig({ cwd: "" });
      expect(cfg.cwd).toBeUndefined();
    });
  });

  describe("instructionsFilePath", () => {
    it("persists trimmed instructionsFilePath", () => {
      const cfg = buildAdapterConfig({ instructionsFilePath: "  /agents/AGENTS.md  " });
      expect(cfg.instructionsFilePath).toBe("/agents/AGENTS.md");
    });

    it("omits instructionsFilePath when empty", () => {
      const cfg = buildAdapterConfig({ instructionsFilePath: "" });
      expect(cfg.instructionsFilePath).toBeUndefined();
    });
  });

  describe("timeoutSec (always 0)", () => {
    it("always sets timeoutSec to 0", () => {
      const cfg = buildAdapterConfig({});
      expect(cfg.timeoutSec).toBe(0);
    });

    it("does not persist effort or maxTurnsPerRun (dead fields)", () => {
      const cfg = buildAdapterConfig({ thinkingEffort: "high", maxTurnsPerRun: 10 } as Record<string, unknown>);
      expect(cfg.effort).toBeUndefined();
      expect(cfg.maxTurnsPerRun).toBeUndefined();
    });
  });

  describe("graceSec", () => {
    it("always sets graceSec to 15", () => {
      const cfg = buildAdapterConfig({});
      expect(cfg.graceSec).toBe(15);
    });

    it("sets graceSec to 15 even when other fields are provided", () => {
      const cfg = buildAdapterConfig({ command: "kiro-cli", model: "auto" });
      expect(cfg.graceSec).toBe(15);
    });
  });

  describe("extraArgs (comma-split)", () => {
    it("splits extraArgs on commas", () => {
      const cfg = buildAdapterConfig({ extraArgs: "--verbose,--debug" });
      expect(cfg.extraArgs).toEqual(["--verbose", "--debug"]);
    });

    it("trims whitespace around comma-separated args", () => {
      const cfg = buildAdapterConfig({ extraArgs: "--flag1 , --flag2" });
      expect(cfg.extraArgs).toEqual(["--flag1", "--flag2"]);
    });

    it("omits extraArgs when empty", () => {
      const cfg = buildAdapterConfig({ extraArgs: "" });
      expect(cfg.extraArgs).toBeUndefined();
    });

    it("omits extraArgs when whitespace-only", () => {
      const cfg = buildAdapterConfig({ extraArgs: "   " });
      expect(cfg.extraArgs).toBeUndefined();
    });

    it("handles single arg (no comma needed)", () => {
      const cfg = buildAdapterConfig({ extraArgs: "--trust-all-tools" });
      expect(cfg.extraArgs).toEqual(["--trust-all-tools"]);
    });
  });

  describe("env bindings (envVars)", () => {
    it("parses KEY=VALUE pairs as plain-typed env objects", () => {
      const cfg = buildAdapterConfig({ envVars: "FOO=bar\nBAZ=qux" });
      expect(cfg.env).toEqual({
        FOO: { type: "plain", value: "bar" },
        BAZ: { type: "plain", value: "qux" },
      });
    });

    it("parses env var with value containing equals sign", () => {
      const cfg = buildAdapterConfig({ envVars: "TOKEN=abc=def" });
      expect(cfg.env).toEqual({ TOKEN: { type: "plain", value: "abc=def" } });
    });

    it("parses env var with empty value", () => {
      const cfg = buildAdapterConfig({ envVars: "EMPTY=" });
      expect(cfg.env).toEqual({ EMPTY: { type: "plain", value: "" } });
    });

    it("skips lines that are not KEY=VALUE format", () => {
      const cfg = buildAdapterConfig({ envVars: "VALID=yes\nnot-valid-no-equals\nALSO=ok" });
      expect(cfg.env).toEqual({
        VALID: { type: "plain", value: "yes" },
        ALSO: { type: "plain", value: "ok" },
      });
    });

    it("omits env when envVars is empty", () => {
      const cfg = buildAdapterConfig({ envVars: "" });
      expect(cfg.env).toBeUndefined();
    });

    it("omits env when envVars is whitespace-only", () => {
      const cfg = buildAdapterConfig({ envVars: "   " });
      expect(cfg.env).toBeUndefined();
    });
  });

  describe("full config round-trip", () => {
    it("builds complete config with all fields set", () => {
      const cfg = buildAdapterConfig({
        command: "kiro-cli",
        model: "claude-sonnet-4.5",
        cwd: "/project",
        instructionsFilePath: "/project/AGENTS.md",
        extraArgs: "--verbose",
        envVars: "API_KEY=secret\nDEBUG=true",
      });

      expect(cfg).toMatchObject({
        command: "kiro-cli",
        model: "claude-sonnet-4.5",
        cwd: "/project",
        instructionsFilePath: "/project/AGENTS.md",
        timeoutSec: 0,
        graceSec: 15,
        extraArgs: ["--verbose"],
        env: {
          API_KEY: { type: "plain", value: "secret" },
          DEBUG: { type: "plain", value: "true" },
        },
      });
      // Dead fields must not be persisted
      expect(cfg.maxTurnsPerRun).toBeUndefined();
      expect(cfg.effort).toBeUndefined();
    });

    it("returns minimal config when all optional fields are absent", () => {
      const cfg = buildAdapterConfig({});
      expect(cfg).toEqual({ timeoutSec: 0, graceSec: 15 });
    });
  });
});
