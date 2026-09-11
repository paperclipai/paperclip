import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { claimFreshNativeSandboxSession } from "./fresh-native-sandbox-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native fresh ' session-"));
  roots.push(root);
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => {
    const result = spawnSync(input.command, input.args ?? [], { encoding: "utf8" });
    return { pid: result.pid, startedAt: new Date().toISOString(), exitCode: result.status, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr };
  });
  return {
    authority: { runId: "run-new", normalizedSessionId: "session-new" },
    runId: "run-new", normalizedSessionId: "session-new", hasPriorState: false,
    runner: { execute }, sessionRoot: join(root, "sessions", "new"),
  };
}

describe("fresh native session on a retained sandbox", () => {
  it("claims a separate private directory without changing old conversation or task files", async () => {
    const input = await fixture();
    const old = join(input.sessionRoot, "..", "old");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "conversation"), "keep conversation");
    await claimFreshNativeSandboxSession(input);
    expect((await stat(input.sessionRoot)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(old, "conversation"), "utf8")).toBe("keep conversation");
    await expect(claimFreshNativeSandboxSession(input)).rejects.toThrow("runner_harness_state_mismatch");
  });

  it.each(["missing authority", "other run", "other session", "prior state"])("refuses %s before touching the sandbox", async scenario => {
    const input = await fixture();
    const authority = scenario === "missing authority" ? undefined : {
      runId: scenario === "other run" ? "old-run" : input.runId,
      normalizedSessionId: scenario === "other session" ? "old-session" : input.normalizedSessionId,
    };
    await expect(claimFreshNativeSandboxSession({ ...input, authority, hasPriorState: scenario === "prior state" }))
      .rejects.toThrow("runner_harness_state_mismatch");
    expect(input.runner.execute).not.toHaveBeenCalled();
  });

  it.each(["partial directory", "file", "symlink"])("preserves an existing %s", async scenario => {
    const input = await fixture();
    await mkdir(join(input.sessionRoot, ".."), { recursive: true });
    if (scenario === "partial directory") {
      await mkdir(input.sessionRoot);
      await writeFile(join(input.sessionRoot, "partial"), "keep");
    } else if (scenario === "file") await writeFile(input.sessionRoot, "keep");
    else await symlink("missing-target", input.sessionRoot);
    await expect(claimFreshNativeSandboxSession(input)).rejects.toThrow("runner_harness_state_mismatch");
    if (scenario === "partial directory") expect(await readFile(join(input.sessionRoot, "partial"), "utf8")).toBe("keep");
    if (scenario === "file") expect(await readFile(input.sessionRoot, "utf8")).toBe("keep");
  });

  it.each(["timeout", "transport failure"])("fails closed on %s", async scenario => {
    const input = await fixture();
    if (scenario === "timeout") input.runner.execute.mockResolvedValue({ pid: null, startedAt: new Date().toISOString(), exitCode: 0, signal: null, timedOut: true, stdout: "", stderr: "" });
    else input.runner.execute.mockRejectedValue(new Error("transport unavailable"));
    await expect(claimFreshNativeSandboxSession(input)).rejects.toThrow();
  });
});
