import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureCommandResolvable,
  redactEnvForLogs,
  renderPaperclipRuntimeNote,
  runChildProcess,
} from "./server-utils.js";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-adapter-utils-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("server utils", () => {
  it("redacts sensitive environment keys while keeping harmless keys readable", () => {
    expect(
      redactEnvForLogs({
        OPENAI_API_KEY: "sk-live-secret",
        PAPERCLIP_RUN_ID: "run-123",
      }),
    ).toEqual({
      OPENAI_API_KEY: "***REDACTED***",
      PAPERCLIP_RUN_ID: "run-123",
    });
  });

  it("renders a repo-backed runtime note when workspace checkout metadata is present", () => {
    const note = renderPaperclipRuntimeNote({
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_WORKSPACE_CHECKOUT_ID: "checkout-1",
      PAPERCLIP_WORKSPACE_BRANCH: "codex/review-handoff",
      PAPERCLIP_WORKSPACE_REPO_URL: "https://github.com/paperclipai/paperclip",
    });

    expect(note).toContain("Paperclip runtime note:");
    expect(note).toContain("checkout-1");
    expect(note).toContain("codex/review-handoff");
  });

  it("resolves commands from the provided PATH instead of relying on the parent shell", async () => {
    const dir = await createTempDir();
    const scriptPath = path.join(dir, "paperclip-test-command");
    await writeFile(scriptPath, "#!/bin/sh\necho integration-ok\n");
    await chmod(scriptPath, 0o755);

    const resolved = await ensureCommandResolvable("paperclip-test-command", dir, {
      PATH: dir,
    });

    expect(resolved).toBe(scriptPath);
  });

  it("captures stdout from a child process without timing out", async () => {
    const result = await runChildProcess("run-123", "node", ["-e", "process.stdout.write('hello from child')"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      graceSec: 2,
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from child");
  });
});
