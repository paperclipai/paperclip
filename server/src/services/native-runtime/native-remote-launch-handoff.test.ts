import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { createNativeRemoteLaunchIntent, launchNativeRemoteRunnerOnce, NATIVE_REMOTE_LAUNCH_SCRIPT,
  readNativeRemoteLaunchReceipt } from "./native-remote-launch-handoff.js";

const executeFile = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    writeFileSync(join(root, "release-receipt"), "release");
    for (let attempt = 0; attempt < 20; attempt++) {
      const pidFile = join(root, "spawned-children");
      if (existsSync(pidFile)) {
        for (const pid of readFileSync(pidFile, "utf8").trim().split("\n").map(Number)) {
          if (!Number.isSafeInteger(pid) || pid < 1) continue;
          await new Promise(resolve => setTimeout(resolve, 30));
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-remote-launch-"));
  roots.push(root);
  const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
    normalizedSessionId: "session", turnId: "turn", itemId: "item" };
  const stateDirectory = join(root, "state"), processIdentityPath = join(stateDirectory, "runner-process.identity");
  const spec: RunnerProcessLaunchSpec = { command: process.execPath, cwd: root, environment: { BOOTSTRAP_TICKET: "original-fixture-ticket" },
    args: ["-e", `if(process.env.BOOTSTRAP_TICKET!=="original-fixture-ticket")process.exit(9);require("node:fs").appendFileSync(${JSON.stringify(join(root, "turns"))},"turn\\n");setInterval(()=>{},1000)`, "--",
      "--runner-id", identity.runnerInstanceId, "--environment-lease-id", identity.environmentLeaseId,
      "--run-id", identity.runId, "--session-id", identity.normalizedSessionId, "--turn-id", identity.turnId,
      "--item-id", identity.itemId, "--runner-version", "fixture-v1", "--runner-digest", `sha256:${"a".repeat(64)}`,
      "--state-dir", stateDirectory] };
  const intent = createNativeRemoteLaunchIntent({ identity, checkpoint: { headerSha256: "a".repeat(64),
    cursorSha256: "b".repeat(64), partsSha256: "c".repeat(64) }, remoteCwd: root, remoteBinary: process.execPath,
    stateDirectory, processIdentityPath, diagnosticsDirectory: join(root, "diagnostics"),
    runnerVersion: "fixture-v1", runnerDigest: `sha256:${"a".repeat(64)}`, spec });
  const script = NATIVE_REMOTE_LAUNCH_SCRIPT
    .replace('const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");',
      'const stat = String(pid) + " (fixture) " + ["S", ...Array(18).fill("0"), "1234"].join(" ");')
    .replace('const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();', 'const boot = "abcd-1234";')
    .replace('const claimDirectory = intent.processIdentityPath + ".launch";', 'const claimDirectory = intent.processIdentityPath + ".launch";if(mode==="worker")process.on("exit",()=>fs.appendFileSync(path.join(intent.remoteCwd,"finished-workers"),String(process.pid)+"\\n"));')
    .replace('worker.unref();', 'fs.appendFileSync(path.join(intent.remoteCwd,"accepted-workers"),String(worker.pid)+"\\n");worker.unref();')
    .replace('child.unref();', 'fs.appendFileSync(path.join(intent.remoteCwd,"spawned-children"),String(child.pid)+"\\n");child.unref();')
    .replace('} else if (mode === "publish") {', `} else if (mode === "publish") {
      fs.appendFileSync(path.join(intent.remoteCwd, "test-owned-pid"), encodedConfig + "\\n");
      while(!fs.existsSync(path.join(intent.remoteCwd,"release-receipt"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`);
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
    expect(request.command).toBe("node");
    expect(request.cwd).toBe(root);
    expect(request.bypassSession).toBe(true);
    const args = request.args!.map(value => value === NATIVE_REMOTE_LAUNCH_SCRIPT ? script : value);
    try {
      const result = await executeFile(process.execPath, args, { cwd: root, env: { ...process.env, ...request.env },
        timeout: request.timeoutMs, maxBuffer: 32_768 });
      return { exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: null, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      return { exitCode: typeof result.code === "number" ? result.code : 1, signal: null, timedOut: result.killed === true,
        pid: null, startedAt: null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
  });
  return { root, spec, intent, runner: { execute } satisfies CommandManagedRuntimeRunner, execute,
    receiptPath: join(processIdentityPath + ".launch", "receipt.json") };
}

function lines(root: string, name: string) {
  return existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim().split("\n").filter(Boolean) : [];
}

async function settledSpawns(root: string) {
  await vi.waitFor(() => {
    const accepted = lines(root, "accepted-workers"), finished = lines(root, "finished-workers");
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every(pid => finished.includes(pid))).toBe(true);
  });
  return lines(root, "spawned-children");
}

it("adopts the independently continuing remote launch after controller I/O dies before receipt publication", async () => {
  const f = fixture();
  let disconnected = false;
  const oldRunner = { execute: vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
    if (disconnected) throw new Error("old_controller_transport_closed");
    await f.runner.execute(request);
    disconnected = true;
    throw new Error("launch_ack_lost");
  }) };
  await expect(launchNativeRemoteRunnerOnce({ runner: oldRunner, intent: f.intent, spec: f.spec,
    deadline: Date.now() + 250 })).rejects.toMatchObject({ code: "native_remote_launch_receipt_pending" });
  expect(existsSync(f.receiptPath)).toBe(false);
  const resumed = readNativeRemoteLaunchReceipt({ runner: f.runner, intent: JSON.parse(JSON.stringify(f.intent)),
    deadline: Date.now() + 5_000 });
  writeFileSync(join(f.root, "release-receipt"), "release");
  const receipt = await resumed;
  await vi.waitFor(() => expect(readFileSync(join(f.root, "turns"), "utf8")).toBe("turn\n"));
  expect(receipt.nonce).toBe(f.intent.nonce);
  expect(() => process.kill(receipt.pid, 0)).not.toThrow();
  expect(await launchNativeRemoteRunnerOnce({ runner: f.runner, intent: f.intent, spec: f.spec })).toEqual(receipt);
  expect(await settledSpawns(f.root)).toEqual([String(receipt.pid)]);
  expect(readFileSync(join(f.root, "turns"), "utf8")).toBe("turn\n");
  expect(oldRunner.execute.mock.calls.filter(([request]) => request.args?.[2] === "launch")).toHaveLength(1);
});

it("concurrent replays keep one exact physical process and one provider turn", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "release-receipt"), "release");
  const receipts = await Promise.all([1, 2, 3].map(() => launchNativeRemoteRunnerOnce({ runner: f.runner, intent: f.intent, spec: f.spec })));
  expect(receipts[1]).toEqual(receipts[0]);
  expect(receipts[2]).toEqual(receipts[0]);
  expect(await settledSpawns(f.root)).toEqual([String(receipts[0]!.pid)]);
  await vi.waitFor(() => expect(readFileSync(join(f.root, "turns"), "utf8")).toBe("turn\n"));
});

it("preserves a claimed but unpublished launch without spawning again", async () => {
  const f = fixture(), directory = f.intent.processIdentityPath + ".launch";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "intent.json"), JSON.stringify(f.intent), { mode: 0o600 });
  await expect(launchNativeRemoteRunnerOnce({ runner: f.runner, intent: f.intent, spec: f.spec,
    deadline: Date.now() + 250 })).rejects.toMatchObject({ code: "native_remote_launch_receipt_pending" });
  expect(existsSync(join(f.root, "turns"))).toBe(false);
  expect(existsSync(join(f.root, "test-owned-pid"))).toBe(false);
  expect(JSON.parse(readFileSync(join(directory, "intent.json"), "utf8"))).toEqual(f.intent);
});

it("refuses changed configuration or foreign checkpoint identity while preserving the existing process", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "release-receipt"), "release");
  const receipt = await launchNativeRemoteRunnerOnce({ runner: f.runner, intent: f.intent, spec: f.spec });
  await expect(launchNativeRemoteRunnerOnce({ runner: f.runner, intent: f.intent,
    spec: { ...f.spec, environment: { BOOTSTRAP_TICKET: "different-ticket" } } }))
    .rejects.toMatchObject({ code: "native_remote_launch_configuration_changed" });
  for (const changed of [{ ...f.intent, identity: { ...f.intent.identity, runId: "foreign-run" } },
    { ...f.intent, checkpoint: { ...f.intent.checkpoint, headerSha256: "f".repeat(64) } }]) {
    await expect(readNativeRemoteLaunchReceipt({ runner: f.runner, intent: changed }))
      .rejects.toMatchObject({ code: "native_remote_launch_identity_mismatch" });
  }
  expect(await readNativeRemoteLaunchReceipt({ runner: f.runner, intent: f.intent })).toEqual(receipt);
  expect(() => process.kill(receipt.pid, 0)).not.toThrow();
});

it("keeps old unreceipted identity markers on the strict fallback path", async () => {
  const f = fixture();
  mkdirSync(f.intent.stateDirectory, { mode: 0o700 });
  const marker = "old-unproven-marker\n";
  writeFileSync(f.intent.processIdentityPath, marker, { mode: 0o600 });
  await expect(launchNativeRemoteRunnerOnce({ runner: f.runner, intent: f.intent, spec: f.spec }))
    .rejects.toMatchObject({ code: "native_remote_launch_identity_mismatch" });
  expect(readFileSync(f.intent.processIdentityPath, "utf8")).toBe(marker);
  expect(existsSync(f.intent.processIdentityPath + ".launch")).toBe(false);
});

it("applies the remote workspace fence before following a retained launch-directory symlink", async () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), "native-launch-outside-"));
  roots.push(outside);
  symlinkSync(outside, f.intent.stateDirectory);
  await expect(launchNativeRemoteRunnerOnce({ runner: f.runner, intent: f.intent, spec: f.spec }))
    .rejects.toMatchObject({ code: "native_remote_launch_path_unsafe" });
  expect(existsSync(join(outside, "runner-process.identity.launch"))).toBe(false);
  expect(existsSync(join(outside, "runner-process.identity"))).toBe(false);
});
