import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_MACOS_APP_COMMAND_PATH,
  buildCodexCommandEnv,
  codexCommandResolutionDetail,
  codexCommandUnresolvableHint,
  withCodexCommandPath,
} from "./command.js";

describe("codex command environment", () => {
  it("appends fallback directories for the default bare codex command", () => {
    const initialPath = ["/usr/bin", "/bin"].join(path.delimiter);
    const fallbackDir = "/tmp/paperclip-codex-fallback";

    const env = buildCodexCommandEnv(
      "codex",
      { PATH: initialPath },
      { fallbackDirs: [fallbackDir] },
    );

    expect(env.PATH?.split(path.delimiter)).toEqual(["/usr/bin", "/bin", fallbackDir]);
  });

  it("preserves existing PATH precedence and does not duplicate fallback directories", () => {
    const fallbackDir = "/tmp/paperclip-codex-fallback";
    const initialPath = [fallbackDir, "/usr/bin"].join(path.delimiter);

    const env = buildCodexCommandEnv(
      "codex",
      { PATH: initialPath },
      { fallbackDirs: [fallbackDir, "/opt/homebrew/bin"] },
    );

    expect(env.PATH?.split(path.delimiter)).toEqual([
      fallbackDir,
      "/usr/bin",
      "/opt/homebrew/bin",
    ]);
  });

  it("does not augment explicit custom commands", () => {
    const initialPath = ["/usr/bin", "/bin"].join(path.delimiter);
    const fallbackDir = "/tmp/paperclip-codex-fallback";

    const env = buildCodexCommandEnv(
      "/custom/bin/codex",
      { PATH: initialPath },
      { fallbackDirs: [fallbackDir] },
    );

    expect(env.PATH).toBe(initialPath);
  });

  it("copies the resolved runtime PATH into the child process env", () => {
    const runtimePath = ["/usr/bin", "/tmp/paperclip-codex-fallback"].join(path.delimiter);

    const env = withCodexCommandPath(
      { PAPERCLIP_AGENT_ID: "agent-1" },
      { PATH: runtimePath },
    );

    expect(env).toEqual({
      PAPERCLIP_AGENT_ID: "agent-1",
      PATH: runtimePath,
    });
  });

  it("formats diagnostics with command, cwd, PATH, and no secret values", () => {
    const detail = codexCommandResolutionDetail("codex", "/tmp/workspace", {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "secret-value",
    });
    const hint = codexCommandUnresolvableHint("codex");

    expect(detail).toContain("command: codex");
    expect(detail).toContain("cwd: /tmp/workspace");
    expect(detail).toContain("PATH: /usr/bin");
    expect(detail).not.toContain("secret-value");
    expect(hint).toContain(CODEX_MACOS_APP_COMMAND_PATH);
  });
});
