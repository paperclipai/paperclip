import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeCredentialStore } from "./native-credential-store.js";

const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(target: "local" | "ssh" | "sandbox", provider: "codex" | "grok" = "codex") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-credential-store-"))); roots.push(root);
  const localHome = join(root, "local"), remoteHome = join(root, "remote");
  await mkdir(localHome); await mkdir(remoteHome);
  const home = target === "local" ? localHome : remoteHome;
  const runner = { execute: vi.fn(async (request: { command: string; args: string[]; bypassSession?: boolean; timeoutMs?: number }) => {
    expect(request.bypassSession).toBe(true); expect(request.timeoutMs).toBe(10_000);
    try {
      const result = await execute(request.command, request.args, { timeout: request.timeoutMs });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { exitCode: (error as { code: number }).code, stdout: "", stderr: "" };
    }
  }) };
  return { home, runner, store: createNativeCredentialStore({ provider, localHome,
    ...(target === "local" ? {} : { remoteHome, runner: runner as never }) }) };
}

it.each(["local", "ssh", "sandbox"] as const)("exports %s snapshots only on demand and removes them after retirement", async target => {
  const { home, runner, store } = await fixture(target);
  expect(runner.execute).not.toHaveBeenCalled();
  await writeFile(join(home, "auth.json"), '{"tokens":{"refresh_token":"synthetic"}}', { mode: 0o600 });
  expect(await store.read()).toContain("synthetic");
  await store.remove();
  await expect(store.read()).rejects.toMatchObject({ code: "ENOENT" });
});

it.each((["codex", "grok"] as const).flatMap(provider => (["local", "ssh", "sandbox"] as const).map(target => ({ provider, target }))))("uses the $provider close handoff for $target when auth.json is absent", async ({ target, provider }) => {
  const { home, store } = await fixture(target, provider);
  await writeFile(join(home, "auth-refresh.json"), '{"synthetic":"refresh"}', { mode: 0o600 });
  expect(await store.read()).toBe('{"synthetic":"refresh"}');
  await store.remove();
  await expect(store.read()).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["local", "ssh", "sandbox"] as const)("rejects unsafe %s files without falling back to another credential", async target => {
  const { home, store } = await fixture(target, "grok");
  await writeFile(join(home, "auth-refresh.json"), "must-not-read", { mode: 0o600 });
  await writeFile(join(home, "auth.json"), "unsafe", { mode: 0o644 });
  await expect(store.read()).rejects.toThrow();
  await chmod(join(home, "auth.json"), 0o600);
  await writeFile(join(home, "auth.json"), "x".repeat(65_537));
  await expect(store.read()).rejects.toThrow();
  await rm(join(home, "auth.json"));
  await symlink(join(home, "auth-refresh.json"), join(home, "auth.json"));
  await expect(store.read()).rejects.toThrow();
});

it("rejects truncated remote replies and timeouts", async () => {
  const runner = { execute: vi.fn(async () => ({ exitCode: 0, stdout: "not-base64!", timedOut: false })) };
  const store = createNativeCredentialStore({ provider: "codex", localHome: "/unused", remoteHome: "/owned", runner: runner as never });
  await expect(store.read()).rejects.toThrow("export invalid");
  runner.execute.mockResolvedValue({ exitCode: 0, stdout: "", timedOut: true });
  await expect(store.read()).rejects.toThrow("export unavailable");
});
