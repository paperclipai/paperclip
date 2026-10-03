import { describe, expect, it } from "vitest";
import { buildRunArgs, resolveRunAutoApprove } from "./args.js";

describe("resolveRunAutoApprove", () => {
  it("auto-approves when both opt-outs are unset (defaults)", () => {
    expect(resolveRunAutoApprove({})).toBe(true);
    expect(resolveRunAutoApprove({ autoApprove: true, dangerouslySkipPermissions: true })).toBe(true);
  });

  it("suppresses --auto when dangerouslySkipPermissions is explicitly false", () => {
    expect(resolveRunAutoApprove({ dangerouslySkipPermissions: false })).toBe(false);
    expect(resolveRunAutoApprove({ autoApprove: true, dangerouslySkipPermissions: false })).toBe(false);
  });

  it("suppresses --auto when autoApprove is explicitly false", () => {
    expect(resolveRunAutoApprove({ autoApprove: false })).toBe(false);
    expect(resolveRunAutoApprove({ autoApprove: false, dangerouslySkipPermissions: true })).toBe(false);
  });

  it("suppresses --auto when both opt-outs are set", () => {
    expect(resolveRunAutoApprove({ autoApprove: false, dangerouslySkipPermissions: false })).toBe(false);
  });
});

describe("buildRunArgs", () => {
  describe("v1 argv (and the legacy-safe unknown line)", () => {
    it("emits the full v1 flag set with extraArgs trailing", () => {
      expect(
        buildRunArgs({
          line: "v1",
          model: "openai/gpt-5",
          variant: "fast",
          resumeSessionId: "ses_abc123",
          printLogs: true,
          autoApprove: true,
          extraArgs: ["--foo", "bar"],
        }),
      ).toEqual([
        "run",
        "--format",
        "json",
        "--print-logs",
        "--session",
        "ses_abc123",
        "--model",
        "openai/gpt-5",
        "--variant",
        "fast",
        "--foo",
        "bar",
      ]);
    });

    it("emits only the base argv when no optional flag applies", () => {
      expect(
        buildRunArgs({
          line: "v1",
          model: "",
          variant: "",
          resumeSessionId: null,
          printLogs: false,
          autoApprove: false,
        }),
      ).toEqual(["run", "--format", "json"]);
    });

    it("keeps the unknown line on the legacy v1 argv with no v2-only flags", () => {
      expect(
        buildRunArgs({
          line: "unknown",
          model: "openai/gpt-5",
          variant: "fast",
          resumeSessionId: "ses_abc123",
          printLogs: true,
          autoApprove: true,
          extraArgs: ["--passthrough"],
        }),
      ).toEqual([
        "run",
        "--format",
        "json",
        "--print-logs",
        "--session",
        "ses_abc123",
        "--model",
        "openai/gpt-5",
        "--variant",
        "fast",
        "--passthrough",
      ]);
    });

    it("ignores autoApprove on v1 because the v1 CLI has no --auto flag", () => {
      const args = buildRunArgs({
        line: "v1",
        model: "openai/gpt-5",
        variant: "",
        printLogs: false,
        autoApprove: true,
      });
      expect(args).not.toContain("--auto");
      expect(args).not.toContain("--standalone");
    });
  });

  describe("v2 argv", () => {
    it("maps model and variant into one --model provider/model#variant value without --variant", () => {
      const args = buildRunArgs({
        line: "v2",
        model: "anthropic/claude-sonnet-4-5",
        variant: "fast",
        resumeSessionId: "ses_abc123",
        printLogs: true,
        autoApprove: true,
        extraArgs: ["--foo", "bar"],
      });
      expect(args).toEqual([
        "--print-logs",
        "run",
        "--format",
        "json",
        "--standalone",
        "--session",
        "ses_abc123",
        "--model",
        "anthropic/claude-sonnet-4-5#fast",
        "--auto",
        "--foo",
        "bar",
      ]);
      expect(args).not.toContain("--variant");
      expect(args).toContain("--standalone");
    });

    it("places the global --print-logs flag before the run subcommand", () => {
      const args = buildRunArgs({
        line: "v2",
        model: "",
        variant: "",
        printLogs: true,
        autoApprove: false,
      });
      expect(args.slice(0, 2)).toEqual(["--print-logs", "run"]);
      expect(args).toEqual(["--print-logs", "run", "--format", "json", "--standalone"]);
    });

    it("emits no --auto when autoApprove is false", () => {
      const args = buildRunArgs({
        line: "v2",
        model: "openai/gpt-5",
        variant: "",
        printLogs: false,
        autoApprove: false,
      });
      expect(args).toEqual(["run", "--format", "json", "--standalone", "--model", "openai/gpt-5"]);
      expect(args).not.toContain("--auto");
    });

    it("emits no --auto when dangerouslySkipPermissions is false even with default autoApprove", () => {
      const args = buildRunArgs({
        line: "v2",
        model: "openai/gpt-5",
        variant: "",
        printLogs: false,
        autoApprove: resolveRunAutoApprove({ dangerouslySkipPermissions: false }),
      });
      expect(args).toEqual(["run", "--format", "json", "--standalone", "--model", "openai/gpt-5"]);
      expect(args).not.toContain("--auto");
    });

    it("emits --auto when both gating config fields default", () => {
      const args = buildRunArgs({
        line: "v2",
        model: "openai/gpt-5",
        variant: "",
        printLogs: false,
        autoApprove: resolveRunAutoApprove({}),
      });
      expect(args).toContain("--auto");
    });

    it("appends extraArgs after every built-in v2 flag", () => {
      const args = buildRunArgs({
        line: "v2",
        model: "openai/gpt-5",
        variant: "fast",
        resumeSessionId: "ses_abc123",
        printLogs: true,
        autoApprove: true,
        extraArgs: ["--tail", "one"],
      });
      expect(args.slice(-2)).toEqual(["--tail", "one"]);
    });

    it("does not double-qualify a model that already carries a #variant suffix", () => {
      expect(
        buildRunArgs({
          line: "v2",
          model: "openrouter/models/claude-sonnet-4-5#fast",
          variant: "fast",
          printLogs: false,
          autoApprove: false,
        }),
      ).toEqual([
        "run",
        "--format",
        "json",
        "--standalone",
        "--model",
        "openrouter/models/claude-sonnet-4-5#fast",
      ]);
    });

    it("keeps an already-qualified model untouched when a conflicting variant is configured", () => {
      expect(
        buildRunArgs({
          line: "v2",
          model: "openai/gpt-5#fast",
          variant: "slow",
          printLogs: false,
          autoApprove: false,
        }),
      ).toEqual(["run", "--format", "json", "--standalone", "--model", "openai/gpt-5#fast"]);
    });

    it("emits no --model when only a variant is configured", () => {
      const args = buildRunArgs({
        line: "v2",
        model: "",
        variant: "fast",
        printLogs: false,
        autoApprove: false,
      });
      expect(args).toEqual(["run", "--format", "json", "--standalone"]);
      expect(args).not.toContain("--model");
    });
  });
});
