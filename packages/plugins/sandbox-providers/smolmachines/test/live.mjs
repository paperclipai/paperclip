// Opt-in integration smoke. Boots real VMs; set SMOL_TEST_CLOUD=1 to include Cloud.
import assert from "node:assert/strict";
import plugin from "../dist/plugin.js";

const handlers = plugin.definition;
const base = { driverKey: "smolmachines", companyId: "smol-smoke-company", environmentId: "smol-smoke-env" };

async function verify(target) {
  const config = { target, image: target === "cloud" ? process.env.SMOL_TEST_CLOUD_IMAGE ?? "node:24-alpine" : "node:24-alpine", cpus: 1, memoryMb: 1024, ttlSeconds: 600, reuseLease: target === "cloud" };
  let lease;
  try {
    lease = await handlers.onEnvironmentAcquireLease({ ...base, runId: `smol-smoke-${Date.now()}`, config });
    assert.ok(lease.providerLeaseId);
    const realized = await handlers.onEnvironmentRealizeWorkspace({ ...base, config, lease, workspace: {} });
    assert.ok(realized.cwd.startsWith("/") && realized.cwd.endsWith("/paperclip-workspace"));
    const input = "sandbox input ' $(not-a-command)\n";
    const uploaded = await handlers.onEnvironmentExecute({ ...base, config, lease, command: "sh", args: ["-c", "cat > stdin.txt"], cwd: realized.cwd, stdin: input, timeoutMs: 15_000 });
    assert.equal(uploaded.exitCode, 0, JSON.stringify(uploaded));
    const read = await handlers.onEnvironmentExecute({ ...base, config, lease, command: "cat", args: ["stdin.txt"], cwd: realized.cwd, timeoutMs: 15_000 });
    assert.equal(read.stdout, input);
    const leaked = await handlers.onEnvironmentExecute({ ...base, config, lease, command: "sh", args: ["-c", `find "$HOME" -maxdepth 1 -name '.paperclip-stdin-*' -print`], timeoutMs: 15_000 });
    assert.equal(leaked.stdout, "", "staged stdin must be removed");
    console.log(`${target}: create, workspace, stdin, and exec passed`);
    if (config.reuseLease) {
      await handlers.onEnvironmentReleaseLease({ ...base, config, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
      lease = await handlers.onEnvironmentResumeLease({ ...base, config, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
      assert.ok(lease.providerLeaseId, "resume must retain the lease");
      const retained = await handlers.onEnvironmentExecute({ ...base, config, lease, command: "cat", args: ["stdin.txt"], cwd: realized.cwd, timeoutMs: 15_000 });
      assert.equal(retained.stdout, input);
      console.log(`${target}: stop and resume preserved workspace`);
    }
  } finally {
    if (lease?.providerLeaseId) await handlers.onEnvironmentDestroyLease({ ...base, config, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
  }
}

await verify("local");
if (process.env.SMOL_TEST_CLOUD === "1") await verify("cloud");
