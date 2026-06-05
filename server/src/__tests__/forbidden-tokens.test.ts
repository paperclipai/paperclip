import { describe, expect, it, vi } from "vitest";

const {
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  runCredentialOutputPatternCheck,
  runForbiddenTokenCheck,
} = await import("../../../scripts/check-forbidden-tokens.mjs");

describe("forbidden token check", () => {
  it("derives username tokens without relying on whoami", () => {
    const tokens = resolveDynamicForbiddenTokens(
      { USER: "paperclip", LOGNAME: "paperclip", USERNAME: "pc" },
      {
        userInfo: () => ({ username: "paperclip" }),
      },
    );

    expect(tokens).toEqual(["paperclip", "pc"]);
  });

  it("falls back cleanly when user resolution fails", () => {
    const tokens = resolveDynamicForbiddenTokens(
      {},
      {
        userInfo: () => {
          throw new Error("missing user");
        },
      },
    );

    expect(tokens).toEqual([]);
  });

  it("merges dynamic and file-based forbidden tokens", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tokensFile = path.join(os.tmpdir(), `forbidden-tokens-${Date.now()}.txt`);
    fs.writeFileSync(tokensFile, "# comment\npaperclip\ncustom-token\n");

    try {
      const tokens = resolveForbiddenTokens(tokensFile, { USER: "paperclip" }, {
        userInfo: () => ({ username: "paperclip" }),
      });

      expect(tokens).toEqual(["paperclip", "custom-token"]);
    } finally {
      fs.unlinkSync(tokensFile);
    }
  });

  it("reports matches without leaking which token was searched", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce("server/file.ts:1:found\n")
      .mockImplementation(() => {
        throw new Error("not found");
      });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip", "custom-token"],
      exec,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("ERROR: Forbidden tokens found in tracked files:\n");
    expect(error).toHaveBeenCalledWith("  server/file.ts:1:found");
    expect(error).toHaveBeenCalledWith("\nBuild blocked. Remove the forbidden token(s) before publishing.");
  });

  it("blocks direct stdout writes of targeted runtime credential variables", () => {
    const exec = vi.fn((command: string) => {
      if (command.startsWith("git ls-files")) {
        return ["scripts/probe.sh", "scripts/probe.mjs"].join("\n");
      }
      throw new Error("unexpected command");
    });
    const readFile = vi.fn((file: string) => {
      if (file.includes("scripts/probe.sh")) {
        const openRouterCredential = "OPENROUTER" + "_API_KEY";
        return [
          `echo "$${openRouterCredential}"`,
          'printf "%s" "${DATABASE_URL:-missing}"',
        ].join("\n");
      }
      if (file.includes("scripts/probe.mjs")) {
        const openRouterCredential = "OPENROUTER" + "_API_KEY";
        return [
          `console.log(process.env.${openRouterCredential});`,
          "process.stdout.write(JSON.stringify(process.env));",
        ].join("\n");
      }
      throw new Error("unexpected command");
    });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runCredentialOutputPatternCheck({
      repoRoot: "/repo",
      exec,
      readFile,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("ERROR: Credential stdout patterns found in tracked files:\n");
    expect(error).toHaveBeenCalledWith(
      "  scripts/probe.sh:1: shell stdout/stderr credential expansion",
    );
    expect(error).toHaveBeenCalledWith(
      "  scripts/probe.sh:2: shell stdout/stderr credential expansion",
    );
    expect(error).toHaveBeenCalledWith(
      "  scripts/probe.mjs:1: JavaScript process.env credential output",
    );
    expect(error).toHaveBeenCalledWith(
      "  scripts/probe.mjs:2: JavaScript full process.env serialization",
    );
    expect(error).toHaveBeenCalledWith(
      "\nBuild blocked. Use a safe wrapper and report credential names only.",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("OPENROUTER_API_KEY");
  });

  it("allows safe wrapper-style credential writes to a private curl config", () => {
    const exec = vi.fn((command: string) => {
      if (command.startsWith("git ls-files")) {
        return ["scripts/safe-openrouter-call.sh"].join("\n");
      }
      throw new Error("unexpected command");
    });
    const readFile = vi.fn((file: string) => {
      if (file.includes("scripts/safe-openrouter-call.sh")) {
        const openRouterCredential = "OPENROUTER" + "_API_KEY";
        return [
          `if [ -z "\${${openRouterCredential}:-}" ]; then`,
          '  printf \'%s\\n\' "OPENROUTER_API_KEY is not configured" >&2',
          "fi",
          `printf 'header = \"Authorization: Bearer %s\"\\n' "$${openRouterCredential}" > "$curl_config"`,
        ].join("\n");
      }
      throw new Error("unexpected command");
    });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runCredentialOutputPatternCheck({
      repoRoot: "/repo",
      exec,
      readFile,
      log,
      error,
    });

    expect(exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith("  ✓  No credential stdout patterns found.");
    expect(error).not.toHaveBeenCalled();
  });

  it("blocks stdout-rendered curl config auth header helpers", () => {
    const exec = vi.fn((command: string) => {
      if (command.startsWith("git ls-files")) {
        return ["scripts/probe.sh"].join("\n");
      }
      throw new Error("unexpected command");
    });
    const readFile = vi.fn((file: string) => {
      if (file.includes("scripts/probe.sh")) {
        return `printf 'header = "Authorization: Bearer %s"\\n' "$PAPERCLIP_API_KEY"`;
      }
      throw new Error("unexpected command");
    });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runCredentialOutputPatternCheck({
      repoRoot: "/repo",
      exec,
      readFile,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("ERROR: Credential stdout patterns found in tracked files:\n");
    expect(error).toHaveBeenCalledWith(
      "  scripts/probe.sh:1: shell stdout/stderr credential expansion",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("PAPERCLIP_API_KEY");
    expect(log).not.toHaveBeenCalledWith("  ✓  No credential stdout patterns found.");
  });
});
