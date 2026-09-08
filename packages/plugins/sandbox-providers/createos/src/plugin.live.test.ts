import { expect, it } from "vitest";
import { createPlugin } from "./plugin.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Explicit opt-in: this creates a billable sandbox on the supplied endpoint.
// It never selects a region or discovers credentials automatically.
it.skipIf(process.env.CREATEOS_LIVE_TEST !== "1")("CreateOS create/exec/stdin/reuse/destroy live smoke", async () => {
  const { CREATEOS_API_URL: apiUrl, CREATEOS_API_KEY: apiKey, CREATEOS_SHAPE: shape, CREATEOS_ROOTFS: rootfs } = process.env;
  if (!apiUrl || !apiKey || !shape) throw new Error("Set CREATEOS_API_URL, CREATEOS_API_KEY, and CREATEOS_SHAPE for the live smoke.");
  const hooks = createPlugin().definition;
  const params = {
    driverKey: "createos", companyId: "createos-plugin-smoke", environmentId: "createos-plugin-smoke",
    config: { apiUrl, apiKey, shape, ...(rootfs ? { rootfs } : {}), reuseLease: true, timeoutMs: 120_000 },
  };
  const lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "smoke" });
  let temp: string | null = null;
  try {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "createos-live-"));
    const workspace = await hooks.onEnvironmentRealizeWorkspace!({ ...params, lease, workspace: {} });
    const large = Buffer.alloc(5 * 1024 * 1024, 0xa5);
    const source = path.join(temp, "source");
    const target = path.join(temp, "download");
    await fs.writeFile(source, large);
    await hooks.onEnvironmentSyncIn!({ ...params, lease, operations: [{ operationId: "smoke-in", files: [{
      sourcePath: source, targetPath: `${workspace.cwd}/large.bin`, kind: "file", mode: 0o600,
    }] }] });
    await hooks.onEnvironmentSyncOut!({ ...params, lease, operations: [{ operationId: "smoke-out", files: [{
      sourcePath: `${workspace.cwd}/large.bin`, targetPath: target, kind: "file", mode: 0o600,
    }] }] });
    expect((await fs.readFile(target)).equals(large)).toBe(true);
    const written = await hooks.onEnvironmentExecute!({
      ...params, lease, command: "/bin/bash", args: ["-c", "cat > smoke.txt; printf '%s' \"$SMOKE\" >&2"],
      stdin: "persisted\n", env: { SMOKE: "stderr works" }, cwd: workspace.cwd,
    });
    expect(written).toMatchObject({ exitCode: 0, timedOut: false, stderr: "stderr works" });
    await hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    const resumed = await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    const read = await hooks.onEnvironmentExecute!({ ...params, lease: resumed, command: "/bin/cat", args: ["smoke.txt"], cwd: workspace.cwd });
    expect(read).toMatchObject({ exitCode: 0, timedOut: false, stdout: "persisted\n" });
  } finally {
    try { await hooks.onEnvironmentDestroyLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata }); }
    finally {
      await hooks.onShutdown!();
      if (temp) await fs.rm(temp, { recursive: true, force: true });
    }
  }
}, 300_000);
