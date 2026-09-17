/** Explicit paid/provider stress campaign. Never runs under pnpm test. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "../../packages/plugins/sandbox-providers/exe-dev/src/plugin.js";
import { openSsh, ssh, quote } from "../../packages/plugins/sandbox-providers/exe-dev/src/transport.js";
import { prepareAdapterExecutionTargetRuntime, type AdapterSandboxExecutionTarget } from "../../packages/adapter-utils/src/execution-target.js";
import type { PluginEnvironmentLease } from "../../packages/plugins/sdk/src/protocol.js";

if (process.env.EXE_DEV_LIVE_SMOKE !== "1") throw new Error("Set EXE_DEV_LIVE_SMOKE=1 to authorize this real VM campaign");
const image = process.env.PAPERCLIP_E2E_EXE_IMAGE;
const key = process.env.EXE_DEV_SSH_PRIVATE_KEY;
if (!image || !key) throw new Error("PAPERCLIP_E2E_EXE_IMAGE and EXE_DEV_SSH_PRIVATE_KEY are required");
const campaign = randomUUID().slice(0, 12);
const vmName = `paperclip-stress-${campaign}`;
const config = { mode: "create", vmName, image, sshPrivateKey: key, reuseLease: true, timeoutMs: 300000 };
const transport = { ...config, strictHostKeyChecking: "accept-new" as const };
const scope = { companyId: randomUUID(), environmentId: randomUUID(), driverKey: "exe-dev", config };
const hooks = plugin.definition;
const leases: PluginEnvironmentLease[] = [];
const checks: { name: string; durationMs: number }[] = [];
const temporary = await mkdtemp(path.join(os.tmpdir(), "paperclip-exe-stress-"));
const outputPath = process.env.EXE_DEV_EVIDENCE_PATH ?? path.join(temporary, "result.json");
async function check(name: string, run: () => Promise<void>) {
  const started = Date.now(); await run(); checks.push({ name, durationMs: Date.now() - started }); console.log(`PASS ${name}`);
}
async function execute(lease: PluginEnvironmentLease, script: string, timeoutMs = 30000) {
  return hooks.onEnvironmentExecute!({ ...scope, lease, command: "sh", args: ["-c", script], timeoutMs });
}
let failure: string | undefined;
try {
  await check("compatible image and initial durable VM", async () => {
    leases.push(await hooks.onEnvironmentAcquireLease!({ ...scope, runId: randomUUID(), agentId: "agent-0" }));
    assert.equal(leases[0].metadata?.vmName, vmName);
  });
  await check("every bundled legacy CLI starts without credentials", async () => {
    const result = await execute(leases[0], "set -e; for cli in codex claude opencode grok gemini kimi hermes cursor-agent gh; do timeout 45 \"$cli\" --version; done", 300000);
    assert.equal(result.exitCode, 0, result.stderr);
  });
  const resourceBinding = leases[0].metadata?.environmentResourceBinding as NonNullable<Parameters<NonNullable<typeof hooks.onEnvironmentAcquireLease>>[0]["resourceBinding"]>;
  await check("eight independent leases share the bound VM", async () => {
    leases.push(...await Promise.all(Array.from({ length: 7 }, (_, i) => hooks.onEnvironmentAcquireLease!({ ...scope, resourceBinding, runId: randomUUID(), agentId: `agent-${i + 1}` }))));
    assert.equal(new Set(leases.map((l) => l.providerLeaseId)).size, 8);
    assert.equal(new Set(leases.map((l) => l.metadata?.remoteHome)).size, 8);
    assert.equal(new Set(leases.map((l) => l.metadata?.bindingId)).size, 1);
  });
  await check("64 concurrent commands preserve stdin, output, homes, and exit codes", async () => {
    const results = await Promise.all(Array.from({ length: 64 }, async (_, i) => {
      const lease = leases[i % leases.length];
      const result = await hooks.onEnvironmentExecute!({ ...scope, lease, command: "node", args: ["-e", `let x='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>x+=d);process.stdin.on('end',()=>{require('fs').writeFileSync(process.env.HOME+'/result-${i}',x);process.stdout.write(x);process.exit(${i % 3})})`], stdin: `task-${i}-é-🚀\n`.repeat(500), timeoutMs: 60000 });
      assert.equal(result.stdout, `task-${i}-é-🚀\n`.repeat(500)); assert.equal(result.exitCode, i % 3);
      return result;
    }));
    assert.equal(results.length, 64);
  });
  await check("large output is completely drained before the exit receipt", async () => {
    const result = await execute(leases[0], "node -e \"let pending=2;const done=()=>{if(--pending===0)process.exit(0)};process.stdout.write('x'.repeat(8*1024*1024),done);process.stderr.write('tail'.repeat(256*1024),done)\"");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.length, 8 * 1024 * 1024);
    assert.equal(result.stderr, "tail".repeat(256 * 1024));
    const started = Date.now();
    const inherited = await execute(leases[0], "node -e \"require('child_process').spawn('sleep',['10'],{stdio:['ignore',process.stdout,process.stderr]}).unref()\"");
    assert.equal(inherited.exitCode, 0);
    assert.ok(Date.now() - started < 8000, "a detached child's inherited pipes must not hold the command open");
  });
  await check("SSH loss does not kill remote work or imply a termination receipt", async () => {
    const root = String(leases[0].metadata?.remoteCwd).replace(/\/workspace$/, "");
    const { child } = await openSsh(transport, `${vmName}.exe.xyz`, `node /opt/paperclip-exe/lease.mjs call ${quote(root)}`);
    let ready = false;
    child.stdout.on("data", () => { ready = true; }); child.stderr.resume();
    child.stdin.write(JSON.stringify({ type: "start", command: "sh", args: ["-c", "printf started; sleep 2; printf completed > survived-disconnect"], timeoutMs: 10000 }) + "\n");
    const deadline = Date.now() + 15000;
    while (!ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(ready, "remote command started");
    child.kill("SIGKILL");
    const result = await execute(leases[0], "sleep 3; cat survived-disconnect");
    assert.equal(result.stdout, "completed");
  });
  await check("workspace seed, remote edits between runs, and copyback", async () => {
    const local = path.join(temporary, "workspace"); await mkdir(local);
    await writeFile(path.join(local, "initial.txt"), "host seed\n");
    const lease = leases[1];
    const target: AdapterSandboxExecutionTarget = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "exe-dev", remoteCwd: String(lease.metadata?.remoteCwd), runner: {
      execute: async (command) => { const result = await hooks.onEnvironmentExecute!({ ...scope, lease, ...command }); return { ...result, signal: result.signal ?? null, pid: null, startedAt: null }; },
    } };
    const first = await prepareAdapterExecutionTargetRuntime({ runId: randomUUID(), target, adapterKey: "stress", workspaceLocalDir: local });
    await first.restoreWorkspace();
    await execute(lease, "printf 'changed remotely\\n' > initial.txt; printf 'durable untracked\\n' > remote-only.txt");
    const next = await prepareAdapterExecutionTargetRuntime({ runId: randomUUID(), target, adapterKey: "stress", workspaceLocalDir: local });
    assert.equal((await execute(lease, "cat initial.txt")).stdout, "changed remotely\n");
    await next.restoreWorkspace();
    assert.equal(await readFile(path.join(local, "initial.txt"), "utf8"), "changed remotely\n");
    assert.equal(await readFile(path.join(local, "remote-only.txt"), "utf8"), "durable untracked\n");
  });
  await check("normal release and worker restart preserve disk", async () => {
    const lease = leases[1];
    await hooks.onEnvironmentReleaseLease!({ ...scope, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    await hooks.onShutdown!();
    const resumed = await hooks.onEnvironmentResumeLease!({ ...scope, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    assert.equal(resumed.providerLeaseId, lease.providerLeaseId);
    assert.equal((await execute(resumed, "cat remote-only.txt")).stdout, "durable untracked\n");
  });
  await check("verified copyback seeds a fresh lease and preserves unrelated host edits", async () => {
    const local = path.join(temporary, "workspace");
    const lease = leases[7];
    const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "exe-dev", remoteCwd: String(lease.metadata?.remoteCwd), runner: {
      execute: async (command) => { const result = await hooks.onEnvironmentExecute!({ ...scope, lease, ...command }); return { ...result, signal: result.signal ?? null, pid: null, startedAt: null }; },
    } };
    const restored = await prepareAdapterExecutionTargetRuntime({ runId: randomUUID(), target, adapterKey: "stress", workspaceLocalDir: local });
    assert.equal((await execute(lease, "cat remote-only.txt")).stdout, "durable untracked\n");
    await writeFile(path.join(local, "host-only.txt"), "host collaboration\n");
    await writeFile(path.join(local, "initial.txt"), "competing host change\n");
    await execute(lease, "printf 'remote final\\n' > initial.txt");
    await restored.restoreWorkspace();
    assert.equal(await readFile(path.join(local, "host-only.txt"), "utf8"), "host collaboration\n");
    // Existing file copyback gives changed remote files precedence at the same
    // path. This is deliberately recorded rather than advertised as a merge.
    assert.equal(await readFile(path.join(local, "initial.txt"), "utf8"), "remote final\n");
    assert.equal((await execute(leases[1], "cat initial.txt")).stdout, "changed remotely\n");
  });
  await check("timeout returns evidence and independent control commands still work", async () => {
    const result = await execute(leases[2], "sleep 30", 200);
    assert.equal(result.timedOut, true);
    assert.equal((await execute(leases[2], "printf healthy")).stdout, "healthy");
  });
  await check("cancel one lease while another continues", async () => {
    const pending = execute(leases[3], "sleep 60").catch((error: Error) => error);
    const other = execute(leases[4], "sleep 3; printf survived");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...scope, providerLeaseId: leases[3].providerLeaseId, leaseMetadata: leases[3].metadata, cancelActiveWork: true });
    assert.equal(receipt?.state, "stopped");
    await pending; assert.equal((await other).stdout, "survived");
  });
  await check("lease teardown kills a descendant that escapes its process group", async () => {
    const lease = leases[6];
    await execute(lease, "node -e \"const c=require('child_process').spawn('sleep',['120'],{detached:true,stdio:'ignore'});require('fs').writeFileSync('escaped.pid',String(c.pid));c.unref()\"");
    const pid = Number((await execute(lease, "cat escaped.pid")).stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 1);
    await hooks.onEnvironmentDestroyLease!({ ...scope, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    assert.equal((await execute(leases[4], `if kill -0 ${pid} 2>/dev/null; then printf alive; else printf stopped; fi`)).stdout, "stopped");
  });
  await check("separately managed HTTP service survives lease teardown", async () => {
    const unit = `paperclip-preview-${campaign}`;
    const host = `${vmName}.exe.xyz`;
    await ssh(transport, host, `sudo -n systemd-run --unit=${quote(unit)} --uid=exedev --collect node -e ${quote("require('http').createServer((q,s)=>s.end('preview-alive')).listen(8000,'0.0.0.0')")}`);
    await hooks.onEnvironmentDestroyLease!({ ...scope, providerLeaseId: leases[5].providerLeaseId, leaseMetadata: leases[5].metadata });
    assert.equal((await ssh(transport, host, "curl -fsS http://127.0.0.1:8000")).trim(), "preview-alive");
    const response = await fetch(`https://${host}`, { redirect: "manual" });
    assert.ok([302, 303, 307, 308, 401, 403].includes(response.status), `Preview must remain private; got ${response.status}`);
    if (response.status < 400) {
      const login = new URL(response.headers.get("location")!, `https://${host}`);
      assert.equal(login.origin, `https://${host}`);
      assert.equal(login.pathname, "/__exe.dev/login");
    }
    await ssh(transport, host, `sudo -n systemctl stop ${quote(unit)}`);
  });
  const soakMs = Number(process.env.EXE_DEV_SOAK_MS ?? 0);
  if (soakMs > 0) await check(`idle persistence after ${soakMs}ms`, async () => {
    await new Promise((resolve) => setTimeout(resolve, soakMs));
    assert.equal((await execute(leases[1], "cat remote-only.txt")).stdout, "durable untracked\n");
  });
  await check("VM reboot preserves disk and resumed lease identity", async () => {
    const host = `${vmName}.exe.xyz`;
    const previousBoot = await ssh(transport, host, "cat /proc/sys/kernel/random/boot_id");
    await ssh(transport, host, "sudo -n systemctl reboot").catch(() => {});
    const deadline = Date.now() + 90000;
    let rebooted = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try { if (await ssh({ ...transport, timeoutMs: 10000 }, host, "cat /proc/sys/kernel/random/boot_id") !== previousBoot) { rebooted = true; break; } } catch {}
    }
    assert.ok(rebooted, "VM completed reboot");
    const lease = leases[1];
    const resumed = await hooks.onEnvironmentResumeLease!({ ...scope, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    assert.equal(resumed.metadata?.bindingId, lease.metadata?.bindingId);
    assert.equal((await execute(resumed, "cat remote-only.txt")).stdout, "durable untracked\n");
  });
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
} finally {
  for (const lease of leases) {
    try { await hooks.onEnvironmentDestroyLease!({ ...scope, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata }); }
    catch (error) { failure ??= `Lease cleanup failed: ${String(error)}`; }
  }
  // Only this explicitly generated campaign VM is removable. Durable production
  // lifecycle hooks never call rm. Missing VMs are already cleaned up.
  try {
    const list = JSON.parse(await ssh(transport, "exe.dev", "ls --json"));
    if (list.vms.some((vm: Record<string, unknown>) => vm.vm_name === vmName)) await ssh(transport, "exe.dev", `rm --json ${quote(vmName)}`);
    const after = JSON.parse(await ssh(transport, "exe.dev", "ls --json"));
    assert.ok(!after.vms.some((vm: Record<string, unknown>) => vm.vm_name === vmName));
  } catch (error) { failure ??= `VM cleanup failed: ${String(error)}`; }
  await hooks.onShutdown?.();
  await writeFile(outputPath, JSON.stringify({ campaign, image, vmName, checks, failure, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  if (failure) { console.error(failure); process.exitCode = 1; }
  console.log(`Evidence: ${outputPath}`);
}
