import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { assertManagedAiProjectAuth } from "../services/ai-connection-runtime.js";

const execute = promisify(execFile);
const conflictingConfig = 'model_provider = "host-only"\n';
const targets = process.platform === "win32" ? ["local"] as const : ["local", "remote"] as const;

describe.each(targets)("managed Codex project authentication (%s)", (mode) => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-project-auth-")));
    if (mode === "remote") {
      vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockImplementation(
        async (_runId, target, command, args) => {
          const cwd = target.kind === "remote" ? target.remoteCwd : root;
          try {
            const result = await execute(command, args, { cwd, timeout: 5_000 });
            return { ...result, exitCode: 0, signal: null, timedOut: false };
          } catch (error) {
            const result = error as { code: number; stdout: string; stderr: string };
            return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, signal: null, timedOut: false };
          }
        },
      );
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function config(directory: string, content = conflictingConfig) {
    await mkdir(path.join(directory, ".codex"), { recursive: true });
    await writeFile(path.join(directory, ".codex", "config.toml"), content);
  }

  function check(cwd: string, provider: "openai" | "anthropic" = "openai") {
    return assertManagedAiProjectAuth(
      { cwd },
      provider,
      mode === "remote" ? { kind: "remote", transport: "sandbox", remoteCwd: cwd } : undefined,
    );
  }

  it("does not treat a host configuration above the repository as project authentication", async () => {
    await config(root);
    const repository = path.join(root, "repository");
    const cwd = path.join(repository, "src", "nested");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await expect(check(cwd)).resolves.toBeUndefined();
  });

  it("checks only the working directory when no Git root exists", async () => {
    await config(root);
    const cwd = path.join(root, "plain-workspace");
    await mkdir(cwd);
    await expect(check(cwd)).resolves.toBeUndefined();
  });

  it("still rejects authentication overrides in a repository root", async () => {
    await writeFile(path.join(root, ".git"), "gitdir: /unused/worktree-metadata\n");
    await config(root);
    const cwd = path.join(root, "nested");
    await mkdir(cwd);
    await expect(check(cwd)).rejects.toMatchObject({
      status: 422,
      details: { code: "ai_connection_incompatible" },
    });
  });

  it("still rejects authentication overrides in a nested project directory", async () => {
    await mkdir(path.join(root, ".git"));
    const cwd = path.join(root, "nested", "workspace");
    await mkdir(cwd, { recursive: true });
    await config(path.dirname(cwd));
    await expect(check(cwd)).rejects.toMatchObject({
      details: { code: "ai_connection_incompatible" },
    });
  });

  it("still rejects authentication overrides in a non-Git workspace", async () => {
    await config(root);
    await expect(check(root)).rejects.toMatchObject({
      details: { code: "ai_connection_incompatible" },
    });
  });

  it("checks the physical project ancestry when the working directory is a symlink", async () => {
    const repository = path.join(root, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await config(repository);
    const physicalCwd = path.join(repository, "nested");
    await mkdir(physicalCwd);
    const cwd = path.join(root, "workspace-alias");
    await symlink(physicalCwd, cwd, process.platform === "win32" ? "junction" : "dir");
    await expect(check(cwd)).rejects.toMatchObject({
      details: { code: "ai_connection_incompatible" },
    });
  });

  it("allows project settings that do not override authentication", async () => {
    await config(root, 'model = "fixture-model"\nmodel_reasoning_effort = "low"\n');
    await expect(check(root)).resolves.toBeUndefined();
  });

  it("retains the existing parent configuration check for Claude", async () => {
    await mkdir(path.join(root, ".claude"));
    await writeFile(path.join(root, ".claude", "settings.json"), '{"apiKeyHelper":"fixture-helper"}');
    const cwd = path.join(root, "nested");
    await mkdir(cwd);
    await expect(check(cwd, "anthropic")).rejects.toMatchObject({
      details: { code: "ai_connection_incompatible" },
    });
  });

  if (mode === "local") {
    it("does not inspect the server working directory before a project path is resolved", async () => {
      await config(root);
      const serverCwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      try {
        await expect(assertManagedAiProjectAuth({}, "openai")).resolves.toBeUndefined();
        await expect(assertManagedAiProjectAuth({ args: ["--config=model_provider=override"] }, "openai"))
          .rejects.toMatchObject({ details: { code: "ai_connection_incompatible" } });
      } finally {
        serverCwd.mockRestore();
      }
    });
  }
});
