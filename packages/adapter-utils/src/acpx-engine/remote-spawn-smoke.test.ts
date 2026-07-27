import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";

// Load-bearing repro for the remote-ACP "process session" lane host-spawn bug.
//
// The engine threads ONE cwd (`sessionCwd`) into every cwd-keyed site: the ACP
// `session/new` cwd, the session fingerprint/compat key, AND the acpx HOST
// `spawn()` of the host-local relay proxy. On the remote lane that value is the
// IN-SANDBOX `remoteCwd`, which does not exist on the host, so libuv's pre-`exec`
// `chdir` fails and acpx raises `AgentSpawnError` at `ensure_session`.
//
// A faithful full-engine remote-lane repro is NOT possible without a live
// sandbox: the only local stand-in for a sandbox runs its commands as host child
// processes, so every `remoteCwd`-derived operation (workspace staging, the
// callback bridge, the process-session bridge) executes on the HOST filesystem —
// either materializing `remoteCwd` on the host (masking the host-spawn ENOENT)
// or failing earlier at a different phase. So we split the proof at its two real
// seams: (1) here — the acpx runtime's REAL host `spawn()` honoring
// `spawnCwd ?? cwd` (real `createAcpRuntime`, real libuv `chdir`); and (2) the
// engine → `runtimeOptions` threading (`execute.test.ts`, which asserts the
// engine sets `spawnCwd` host-valid on the remote lane and `undefined`
// elsewhere, with the advertised `session/new` cwd staying `remoteCwd`).
// End-to-end validation against a real sandbox is board-run.

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
// A dedicated ACP agent fixture that reports, on stderr, the working directory
// the host actually spawned it in (`SPAWN_CWD`) and the `cwd` advertised on
// `session/new` (`SESSION_NEW_CWD`).
const fixturePath = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-cwd-report-agent.mjs");
const tempRoots: string[] = [];

type PatchedAcpRuntimeOptions = AcpRuntimeOptions & {
  spawnCwd?: string;
};

type PatchedEnsureSessionOptions = Parameters<ReturnType<typeof createAcpRuntime>["ensureSession"]>[0];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/**
 * Drive a REAL acpx runtime through `ensureSession`, which performs the real
 * host `spawn()` (and its libuv `chdir`). `cwd` is the advertised session cwd;
 * `spawnCwd`, when set, is the host-only spawn cwd the acpx patch consumes as
 * `spawnCwd ?? cwd`.
 */
async function ensureRealAcpSession(input: { cwd: string; spawnCwd?: string }) {
  const stateRoot = await makeTempDir("paperclip-acpx-remote-spawn-state-");
  const stderrChunks: string[] = [];
  const agentCommand = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`;
  const runtimeOptions: PatchedAcpRuntimeOptions = {
    cwd: input.cwd,
    // `spawnCwd` is the host-only knob added by patches/acpx@0.12.0.patch; when
    // unset acpx falls back to `cwd`, so every non-proxy lane is byte-identical.
    ...(input.spawnCwd ? { spawnCwd: input.spawnCwd } : {}),
    sessionStore: createRuntimeStore({ stateDir: path.join(stateRoot, "state") }),
    agentRegistry: createAgentRegistry({ overrides: { custom: agentCommand } }),
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    onAgentStderr: (chunk: string) => stderrChunks.push(chunk),
  };
  const runtime = createAcpRuntime(runtimeOptions);

  try {
    const sessionInput: PatchedEnsureSessionOptions = {
      sessionKey: "remote-spawn-smoke",
      agent: "custom",
      mode: "oneshot",
      cwd: input.cwd,
      sessionOptions: { env: {} },
    };
    const handle = await runtime.ensureSession(sessionInput);
    await (runtime as { close: (i: unknown) => Promise<void> }).close({ handle, reason: "done" }).catch(() => {});
    return { resolved: true as const, stderr: stderrChunks.join("") };
  } catch (err) {
    return { resolved: false as const, error: err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }, stderr: stderrChunks.join("") };
  }
}

it("reproduces host-spawn ENOENT when the advertised session cwd is host-nonexistent", async () => {
  // The in-sandbox `remoteCwd` that does not exist on the host. Intentionally
  // NOT created: this is what trips the acpx host `spawn()` `chdir`.
  const sandboxParent = await makeTempDir("paperclip-acpx-remote-spawn-sandbox-");
  const remoteCwd = path.join(sandboxParent, "does-not-exist-on-host", "workspace");

  const outcome = await ensureRealAcpSession({ cwd: remoteCwd });

  // Before the fix the engine feeds `remoteCwd` as the host spawn cwd, so acpx's
  // real `spawn()` `chdir`s into a host-nonexistent dir and fails ENOENT. This is
  // the exact `ensure_session` failure the remote lane hits in production.
  expect(outcome.resolved, JSON.stringify(outcome)).toBe(false);
  if (outcome.resolved) return;
  expect(outcome.error.name).toBe("AgentSpawnError");
  expect(outcome.error.cause?.code).toBe("ENOENT");
});

it("spawnCwd redirects the host spawn to a host-valid dir while the advertised session cwd stays remoteCwd", async () => {
  const sandboxParent = await makeTempDir("paperclip-acpx-remote-spawn-sandbox-");
  // Host-nonexistent in-sandbox cwd — the advertised `session/new` cwd.
  const remoteCwd = path.join(sandboxParent, "does-not-exist-on-host", "workspace");
  // Host-valid dir the proxy actually spawns in (the engine's host `cwd`).
  const hostSpawnCwd = await makeTempDir("paperclip-acpx-remote-spawn-host-");

  const outcome = await ensureRealAcpSession({ cwd: remoteCwd, spawnCwd: hostSpawnCwd });

  // With `spawnCwd` set the host `spawn()` `chdir`s into the host-valid dir, so
  // the session comes up instead of failing at `ensure_session`.
  expect(outcome.resolved, JSON.stringify(outcome)).toBe(true);
  // The host process really ran in `spawnCwd`...
  expect(outcome.stderr).toContain(`SPAWN_CWD=${await fs.realpath(hostSpawnCwd)}`);
  // ...while the in-sandbox data path (the advertised `session/new` cwd) is
  // unchanged — still `remoteCwd`.
  expect(outcome.stderr).toContain(`SESSION_NEW_CWD=${remoteCwd}`);
});
