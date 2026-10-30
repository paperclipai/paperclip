import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { assertManagedAiProjectAuth } from "../services/ai-connection-runtime.js";

let root: string;
let cwd: string;
const commentKeys = ["model_provider =", "env_key =", "experimental_bearer_token", "cli_auth_credentials_store", "OPENAI_API_KEY"];

beforeEach(async () => {
  const temporaryBase = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  root = await realpath(await mkdtemp(path.join(temporaryBase, "paperclip-project-auth-")));
  await mkdir(path.join(root, ".git"));
  cwd = path.join(root, "project", "nested");
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function configFile(relative: string, content: string, directory = root) {
  const file = path.join(directory, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { mode: 0o600 });
  return file;
}
function remoteCheck(provider: "openai" | "anthropic" = "openai") {
  const target = { kind: "remote", transport: "sandbox", remoteCwd: cwd } as Parameters<typeof assertManagedAiProjectAuth>[2];
  const execute = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockImplementation(async (_id, _target, command, args, options) => {
    expect(command).toBe("sh");
    expect(options.timeoutSec).toBe(15);
    const startedAt = new Date().toISOString();
    const result = spawnSync("/bin/sh", args, { cwd, encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
    if (result.error) throw result.error;
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, signal: result.signal, timedOut: false, pid: result.pid, startedAt };
  });
  return { check: () => assertManagedAiProjectAuth({}, provider, target), execute };
}

describe("managed AI project authentication", () => {
  it.each(["\n", "\r\n"])("ignores only TOML comment lines locally with %j line endings", async ending => {
    await configFile(".codex/config.toml", commentKeys.map(key => ` \t# ${key} fixture`).concat('model = "fixture"').join(ending));
    await expect(assertManagedAiProjectAuth({ cwd }, "openai")).resolves.toBeUndefined();
  });

  it.each([
    'model_provider = "fixture"', 'env_key = "OPENAI_API_KEY"', 'experimental_bearer_token = "fixture"',
    'cli_auth_credentials_store = "fixture"', 'OPENAI_API_KEY = "fixture"',
  ])("rejects active local TOML override %s after comment lines", async override => {
    await configFile(".codex/config.toml", `# model_provider = "comment"\n${override} # trailing comment\n`);
    await expect(assertManagedAiProjectAuth({ cwd }, "openai")).rejects.toMatchObject({ status: 422, details: { code: "ai_connection_incompatible" } });
  });

  it("continues to reject active ancestor overrides above a harmless project config", async () => {
    await configFile(".codex/config.toml", '# model_provider = "comment"\n', cwd);
    await configFile(".codex/config.toml", 'model_provider = "fixture"\n');
    await expect(assertManagedAiProjectAuth({ cwd }, "openai")).rejects.toThrow("conflict");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("preserves local file read failures instead of treating them as harmless comments", async () => {
    const file = await configFile(".codex/config.toml", '# model_provider = "comment"\n');
    await chmod(file, 0);
    try { await expect(assertManagedAiProjectAuth({ cwd }, "openai")).rejects.toMatchObject({ code: "EACCES" }); }
    finally { await chmod(file, 0o600); }
  });

  it("preserves Claude JSON override checks", async () => {
    await configFile(".claude/settings.json", '{"apiKeyHelper":"fixture"}');
    await expect(assertManagedAiProjectAuth({ cwd }, "anthropic")).rejects.toThrow("conflict");
  });

  it.each(["--config=fixture", "-c", "--settings", "--setting-sources=fixture", "--api-key=fixture", "--auth-token=fixture"])("preserves argument override rejection for %s", async arg => {
    const execute = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess");
    await expect(assertManagedAiProjectAuth({ cwd, extraArgs: [arg] }, "openai")).rejects.toThrow("overrides");
    expect(execute).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32").each(["\n", "\r\n"])("runs the remote shell check against ancestor TOML comments with %j line endings", async ending => {
    await configFile(".codex/config.toml", commentKeys.map(key => ` \t# ${key} fixture`).join(ending));
    const { check, execute } = remoteCheck();
    await expect(check()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    const result = await execute.mock.results[0].value;
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  });

  it.skipIf(process.platform === "win32").each(['model_provider = "fixture"', 'env_key = "fixture"', 'experimental_bearer_token = "fixture"'])("rejects active remote TOML override %s after comments", async override => {
    await configFile(".codex/config.toml", `# model_provider = "comment"\n${override}\n`);
    const { check, execute } = remoteCheck();
    await expect(check()).rejects.toThrow("project authentication settings");
    const result = await execute.mock.results[0].value;
    expect(result.exitCode).toBe(42); expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps remote TOML read errors fail closed without exposing content", async () => {
    const file = await configFile(".codex/config.toml", '# model_provider = "comment"\n');
    await chmod(file, 0);
    try {
      const { check, execute } = remoteCheck();
      await expect(check()).rejects.toThrow("project authentication settings");
      const result = await execute.mock.results[0].value;
      expect(result.exitCode).toBe(43); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("model_provider");
    } finally { await chmod(file, 0o600); }
  });

  it.skipIf(process.platform === "win32")("keeps remote Claude JSON override checks unchanged", async () => {
    await configFile(".claude/settings.local.json", '{"ANTHROPIC_AUTH_TOKEN":"fixture"}');
    const { check, execute } = remoteCheck("anthropic");
    await expect(check()).rejects.toThrow("project authentication settings");
    expect((await execute.mock.results[0].value).exitCode).toBe(42);
  });
});
