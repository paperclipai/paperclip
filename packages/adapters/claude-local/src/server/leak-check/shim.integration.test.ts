import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareLeakCheckShimDir, prependPath } from "./host.js";

const __thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The real leak-check.sh ships from the company policies dir. For the
 * integration test we point at a copy in /tmp to avoid coupling to a single
 * developer's home dir. The shim contract is: bash leak-check.sh - reads
 * stdin and exits 0 (clean) or 1 (blocked).
 */
const REAL_LEAK_CHECK_SCRIPT = path.resolve(
  __thisDir,
  "..", "..", "..", "..", "..", "..",
  "..", // up to user home (rough — fall through to env override below)
);

describe("leak-check shim end-to-end", () => {
  const tempDirs: string[] = [];

  async function mkTmp(prefix: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `paperclip-shim-test-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    tempDirs.length = 0;
  });

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Build a self-contained fake leak-check.sh that flags the literal
   * "paperclip.ing" or "/SIE/issues/SIE-" patterns. We intentionally match
   * the production script's contract: stdin → exit 0/1, last stdout line
   * `LEAK-CHECK: clean | blocked (N)`. Tests therefore don't depend on the
   * production company-policies file.
   */
  async function writeFakeLeakCheck(): Promise<string> {
    const dir = await mkTmp("policy");
    const script = path.join(dir, "leak-check.sh");
    await writeFile(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "ALLOW=0",
        "INPUT=''",
        "while [[ $# -gt 0 ]]; do",
        "  case \"$1\" in",
        "    --allow-leak-OK) ALLOW=1; shift;;",
        "    -) INPUT='-'; shift;;",
        "    *) INPUT=\"$1\"; shift;;",
        "  esac",
        "done",
        "if [[ \"$INPUT\" == '-' ]]; then BODY=\"$(cat)\"; else BODY=\"$(cat \"$INPUT\")\"; fi",
        "MATCHES=0",
        "if grep -qiE 'paperclip\\.ing|/SIE/issues/SIE-|Paperclip <noreply' <<<\"$BODY\"; then",
        "  grep -niE 'paperclip\\.ing|/SIE/issues/SIE-|Paperclip <noreply' <<<\"$BODY\" | head -5",
        "  MATCHES=$(grep -ciE 'paperclip\\.ing|/SIE/issues/SIE-|Paperclip <noreply' <<<\"$BODY\")",
        "fi",
        "if [[ $MATCHES -eq 0 ]]; then echo 'LEAK-CHECK: clean'; exit 0; fi",
        "if [[ $ALLOW -eq 1 ]]; then echo \"LEAK-CHECK: clean (override --allow-leak-OK, $MATCHES hit(s))\"; exit 0; fi",
        "echo \"LEAK-CHECK: blocked ($MATCHES match(es))\"; exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    return script;
  }

  /**
   * Write fake `gh` and `git` binaries (bash) to a stub-tools dir. The real
   * shim, when it forwards, will find these on PATH (skipping the shim dir).
   */
  async function writeFakeTools(): Promise<{ dir: string; logFile: string }> {
    const dir = await mkTmp("tools");
    const logFile = path.join(dir, "tool.log");
    for (const tool of ["gh", "git"]) {
      const script = path.join(dir, tool);
      await writeFile(
        script,
        [
          "#!/usr/bin/env bash",
          `printf 'FAKE-${tool} ARGV: ' >> ${shellQuote(logFile)}`,
          `printf '%s ' "$@" >> ${shellQuote(logFile)}`,
          `printf '\\n' >> ${shellQuote(logFile)}`,
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
    }
    return { dir, logFile };
  }

  function runShim(input: {
    tool: "gh" | "git";
    argv: string[];
    shimDir: string;
    fakeToolsDir: string;
    scriptPath: string;
    stdin?: string;
    env?: Record<string, string>;
  }) {
    const wrapperPath = path.join(input.shimDir, input.tool);
    // PATH order: fakeTools (real gh/git) → shimDir → system PATH (bash, env,
    // grep, etc). The shim itself drops shimDir before resolving the real
    // tool, so the fakeTools entry is what it ends up exec'ing.
    const systemPath = process.env.PATH ?? "";
    const path_ = `${input.fakeToolsDir}${path.delimiter}${prependPath(systemPath, input.shimDir)}`;
    return spawnSync(wrapperPath, input.argv, {
      input: input.stdin ?? "",
      encoding: "utf8",
      env: {
        PATH: path_,
        HOME: process.env.HOME ?? "",
        PAPERCLIP_LEAK_CHECK_SCRIPT: input.scriptPath,
        PAPERCLIP_LEAK_CHECK_SHIM_DIR: input.shimDir,
        ...input.env,
      },
    });
  }

  it("forwards a clean gh pr create body to the real gh", async () => {
    const scriptPath = await writeFakeLeakCheck();
    const { dir: fakeTools, logFile } = await writeFakeTools();
    const setup = await prepareLeakCheckShimDir({ runId: "test-run-1", scriptPath });
    try {
      const result = runShim({
        tool: "gh",
        argv: ["pr", "create", "--title", "Add cache", "--body", "Clean body, no leaks here."],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath,
      });
      expect(result.status).toBe(0);
      const log = await import("node:fs/promises").then((m) => m.readFile(logFile, "utf8"));
      expect(log).toContain("FAKE-gh ARGV:");
      expect(log).toContain("pr create");
      expect(log).toContain("Clean body");
    } finally {
      await setup.cleanup();
    }
  });

  it("blocks a gh pr create with a paperclip.ing leak in --body", async () => {
    const scriptPath = await writeFakeLeakCheck();
    const { dir: fakeTools, logFile } = await writeFakeTools();
    const setup = await prepareLeakCheckShimDir({ runId: "test-run-2", scriptPath });
    try {
      const result = runShim({
        tool: "gh",
        argv: [
          "pr",
          "create",
          "--title",
          "Visit paperclip.ing!",
          "--body",
          "See /SIE/issues/SIE-458 for details.",
        ],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/leak-check: BLOCKED gh pr create/i);
      const log = await tryReadFile(logFile);
      // Real gh should NOT have been invoked.
      expect(log).toBe("");
    } finally {
      await setup.cleanup();
    }
  });

  it("blocks a leaky body delivered via --body-file", async () => {
    const scriptPath = await writeFakeLeakCheck();
    const { dir: fakeTools, logFile } = await writeFakeTools();
    const setup = await prepareLeakCheckShimDir({ runId: "test-run-3", scriptPath });
    try {
      const bodyDir = await mkTmp("body");
      const bodyFile = path.join(bodyDir, "body.md");
      await writeFile(bodyFile, "Visit paperclip.ing for the live demo.");
      const result = runShim({
        tool: "gh",
        argv: ["pr", "edit", "42", "--body-file", bodyFile],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/leak-check: BLOCKED gh pr edit/i);
      expect(await tryReadFile(logFile)).toBe("");
    } finally {
      await setup.cleanup();
    }
  });

  it("blocks git commit -m with an internal SIE link", async () => {
    const scriptPath = await writeFakeLeakCheck();
    const { dir: fakeTools, logFile } = await writeFakeTools();
    const setup = await prepareLeakCheckShimDir({ runId: "test-run-4", scriptPath });
    try {
      const result = runShim({
        tool: "git",
        argv: ["commit", "-m", "fix(thing): see /SIE/issues/SIE-458"],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/leak-check: BLOCKED git commit/i);
      expect(await tryReadFile(logFile)).toBe("");
    } finally {
      await setup.cleanup();
    }
  });

  it("regression: blocks the SIE-458 incident pattern (leaky PR body)", async () => {
    const scriptPath = await writeFakeLeakCheck();
    const { dir: fakeTools, logFile } = await writeFakeTools();
    const setup = await prepareLeakCheckShimDir({ runId: "test-run-sie458", scriptPath });
    try {
      const leakyBody = [
        "## Summary",
        "Migrated to a new auth flow.",
        "",
        "Discussed in /SIE/issues/SIE-458 — see also paperclip.ing for context.",
        "",
        "Co-Authored-By: Paperclip <noreply@paperclip.ing>",
      ].join("\n");
      const result = runShim({
        tool: "gh",
        argv: ["pr", "create", "--title", "Auth refactor", "--body", leakyBody],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/paperclip\.ing|SIE-458|noreply/i);
      expect(await tryReadFile(logFile)).toBe("");
    } finally {
      await setup.cleanup();
    }
  });

  it("honors --allow-leak-OK only when PAPERCLIP_LEAK_OVERRIDE=1", async () => {
    const scriptPath = await writeFakeLeakCheck();
    const { dir: fakeTools, logFile } = await writeFakeTools();
    const setup = await prepareLeakCheckShimDir({ runId: "test-run-5", scriptPath });
    try {
      // Without override env: --allow-leak-OK is ignored, block stays.
      const blocked = runShim({
        tool: "gh",
        argv: ["pr", "create", "--body", "see paperclip.ing", "--allow-leak-OK"],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath,
      });
      expect(blocked.status).toBe(1);
      expect(await tryReadFile(logFile)).toBe("");

      // With override env: --allow-leak-OK is honored.
      const allowed = runShim({
        tool: "gh",
        argv: ["pr", "create", "--body", "see paperclip.ing", "--allow-leak-OK"],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath,
        env: { PAPERCLIP_LEAK_OVERRIDE: "1" },
      });
      expect(allowed.status).toBe(0);
      const log = await tryReadFile(logFile);
      expect(log).toContain("FAKE-gh");
      // The --allow-leak-OK flag should be stripped before reaching real gh.
      expect(log).not.toContain("--allow-leak-OK");
    } finally {
      await setup.cleanup();
    }
  });

  it("passes through unsupported gh subcommands without scanning", async () => {
    const scriptPath = await writeFakeLeakCheck();
    const { dir: fakeTools, logFile } = await writeFakeTools();
    const setup = await prepareLeakCheckShimDir({ runId: "test-run-6", scriptPath });
    try {
      const result = runShim({
        tool: "gh",
        argv: ["auth", "status"],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath,
      });
      expect(result.status).toBe(0);
      expect(await tryReadFile(logFile)).toContain("auth status");
    } finally {
      await setup.cleanup();
    }
  });

  it("fails closed if PAPERCLIP_LEAK_CHECK_SCRIPT is missing", async () => {
    const { dir: fakeTools } = await writeFakeTools();
    const setup = await prepareLeakCheckShimDir({
      runId: "test-run-7",
      scriptPath: "/this/path/does/not/exist/leak-check.sh",
    });
    try {
      const result = runShim({
        tool: "gh",
        argv: ["pr", "create", "--body", "anything"],
        shimDir: setup.shimDir,
        fakeToolsDir: fakeTools,
        scriptPath: "/this/path/does/not/exist/leak-check.sh",
        env: {
          PAPERCLIP_LEAK_CHECK_SCRIPT: "/this/path/does/not/exist/leak-check.sh",
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/PAPERCLIP_LEAK_CHECK_SCRIPT/);
    } finally {
      await setup.cleanup();
    }
  });
});

function shellQuote(raw: string): string {
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

async function tryReadFile(file: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

void REAL_LEAK_CHECK_SCRIPT;
