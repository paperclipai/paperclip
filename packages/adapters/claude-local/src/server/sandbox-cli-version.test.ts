import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompatibleClaudeCommand } from "./sandbox-cli-version.js";

const runFile = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(version: string, installer = "success") {
  const root = await mkdtemp(path.join(tmpdir(), "claude-version-fixture-"));
  roots.push(root);
  const versionFile = path.join(root, "version");
  const receipt = path.join(root, "install-receipt");
  await writeFile(versionFile, version);
  await writeFile(path.join(root, "claude"), '#!/bin/sh\nif test -f "$0.version"; then cat "$0.version"; else cat "$VERSION_FILE"; fi\n', { mode: 0o700 });
  await writeFile(path.join(root, "npm"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" > "$INSTALL_RECEIPT"',
    'test "$INSTALLER_RESULT" != fail || exit 1',
    'test "$INSTALLER_RESULT" != unchanged || exit 0',
    'if test "$INSTALLER_RESULT" != success; then printf "%s\\n" "$INSTALLER_RESULT https://registry-secret@example.test/private" >&2; exit 7; fi',
    'mkdir -p "$4/bin"',
    'cp "$SOURCE_CLAUDE" "$4/bin/claude"',
    'printf "%s\\n" "${5##*@}" > "$4/bin/claude.version"',
    'chmod 700 "$4/bin/claude"',
  ].join("\n"), { mode: 0o700 });
  const env = { PATH: `${root}:${process.env.PATH}`, VERSION_FILE: versionFile, INSTALL_RECEIPT: receipt, INSTALLER_RESULT: installer, SOURCE_CLAUDE: path.join(root, "claude") };
  const target: AdapterExecutionTarget = {
    kind: "remote", transport: "sandbox", providerKey: "fixture", remoteCwd: root,
    runner: {
      async execute(input) {
        const startedAt = new Date().toISOString();
        if (input.args?.some(arg => arg.includes("npm install"))) {
          if (installer == "timeout") return { stdout: "", stderr: "registry-secret", exitCode: null, signal: "SIGTERM", timedOut: true, pid: null, startedAt };
          if (installer == "throw") throw new Error("registry-secret");
        }
        try {
          const result = await runFile(input.command, input.args ?? [], {
            cwd: input.cwd ?? root, env: { ...process.env, ...env, ...input.env }, timeout: input.timeoutMs,
          });
          return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
        } catch (error) {
          const result = error as Error & { code?: number; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
          return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1,
            signal: result.signal ?? null, timedOut: result.killed === true, pid: null, startedAt };
        }
      },
    },
  };
  return { target, receipt, input: { runId: "version-fixture", command: "claude", target, cwd: root, env, timeoutSec: 10, graceSec: 1, minimumVersion: "2.1.280" } };
}

describe("managed sandbox Claude CLI compatibility", () => {
  it("updates an existing outdated CLI to the exact required version and verifies it", async () => {
    const { input, receipt } = await fixture("2.1.263");
    expect(await prepareCompatibleClaudeCommand(input)).toMatchObject({ version: "2.1.280", command: path.join(input.cwd, ".paperclip-runtime/claude-cli/2.1.280/bin/claude"), check: { code: "claude_runtime_prepared", level: "info" } });
    expect(await readFile(path.join(input.cwd, "version"), "utf8")).toBe("2.1.263");
    expect((await readFile(receipt, "utf8")).trim()).toBe(`install --global --prefix ${path.join(input.cwd, ".paperclip-runtime/claude-cli/2.1.280")} @anthropic-ai/claude-code@2.1.280`);
  });

  it.each(["2.1.280", "2.1.286"])("keeps a compatible CLI %s without installing", async version => {
    const { input, receipt } = await fixture(version);
    expect(await prepareCompatibleClaudeCommand(input)).toEqual({ command: "claude", version });
    await expect(readFile(receipt)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["fail", "unchanged"])("preserves the failed version gate after an installer result of %s", async installer => {
    const { input, receipt } = await fixture("2.1.263", installer);
    expect(await prepareCompatibleClaudeCommand(input)).toMatchObject({ command: "claude", version: "2.1.263", check: { code: "claude_runtime_preparation_failed", level: "warn" } });
    expect((await readFile(receipt, "utf8")).trim()).toBe(`install --global --prefix ${path.join(input.cwd, ".paperclip-runtime/claude-cli/2.1.280")} @anthropic-ai/claude-code@2.1.280`);
  });

  it.each([
    ["EACCES", "The package installation was denied filesystem access."],
    ["ENOTFOUND", "The package installation could not reach the registry."],
    ["ETARGET", "The required package version could not be resolved from the registry."],
    ["unknown-error", "The package installer exited with code 7."],
    ["timeout", "The package installation timed out."],
    ["throw", "The package installer could not complete execution."],
    ["unchanged", "The prepared runtime did not report its version."],
  ])("reports safe diagnostics after %s without exposing installer output", async (installer, detail) => {
    const { input } = await fixture("2.1.263", installer);
    const result = await prepareCompatibleClaudeCommand(input);
    expect(result).toMatchObject({ command: "claude", version: "2.1.263", check: { code: "claude_runtime_preparation_failed", detail } });
    expect(JSON.stringify(result)).not.toContain("registry-secret");
    expect(JSON.stringify(result)).not.toContain("example.test");
  });

  it("does not replace a caller's custom command", async () => {
    const { input, receipt } = await fixture("2.1.263");
    expect(await prepareCompatibleClaudeCommand({ ...input, command: path.join(input.cwd, "claude") })).toEqual({ command: path.join(input.cwd, "claude"), version: "2.1.263" });
    await expect(readFile(receipt)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not install when the CLI version is unknown", async () => {
    const { input, receipt } = await fixture("unknown");
    expect(await prepareCompatibleClaudeCommand(input)).toEqual({ command: "claude", version: null });
    await expect(readFile(receipt)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not install into a local execution target", async () => {
    const { input, receipt } = await fixture("2.1.263");
    expect(await prepareCompatibleClaudeCommand({ ...input, target: null })).toEqual({ command: "claude", version: "2.1.263" });
    await expect(readFile(receipt)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
