import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Boxd, NotFoundError } from "@boxd-sh/sdk";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "./plugin.js";

const live = process.env.BOXD_LIVE_TEST === "1";
const hooks = plugin.definition;
const timings: Record<string, number> = {};
const params = {
  driverKey: "boxd",
  companyId: "boxd-plugin-smoke",
  environmentId: "boxd-plugin-smoke",
  config: {
    ...(process.env.BOXD_ORG ? { org: process.env.BOXD_ORG } : {}),
    namePrefix: "paperclip-e2e",
    reuseLease: true,
    timeoutMs: 120_000,
  },
};
const ephemeral = { ...params, config: { ...params.config, reuseLease: false } };
let sdkClient: Boxd | null = null;

function sdk(): Boxd {
  sdkClient ??= new Boxd({ apiKey: process.env.BOXD_API_KEY });
  return sdkClient;
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    timings[label] = Math.round(performance.now() - startedAt);
  }
}

async function acquire(input: typeof params = params, extra: Record<string, unknown> = {}) {
  return await hooks.onEnvironmentAcquireLease!({ ...input, runId: `smoke-${randomUUID().slice(0, 8)}`, ...extra });
}

async function cleanup(providerLeaseId: string | null | undefined) {
  if (!providerLeaseId) return;
  await hooks.onEnvironmentDestroyLease!({ ...params, providerLeaseId }).catch(() => undefined);
}

async function machineOrNull(id: string) {
  try {
    return await sdk().machines.get(id);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

async function waitFor(description: string, timeoutMs: number, check: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

describe.skipIf(!live)("boxd live", () => {
  afterAll(async () => {
    await hooks.onShutdown!();
    await sdkClient?.close();
    console.log(`boxd live timings (ms): ${JSON.stringify(timings)}`);
  });

  it("validates config before the API is called", async () => {
    if (!process.env.BOXD_API_KEY) throw new Error("Set BOXD_API_KEY for the live tests.");
    expect(await hooks.onEnvironmentValidateConfig!({ ...params, config: { vcpu: 3 } })).toMatchObject({ ok: false });
    expect(await hooks.onEnvironmentValidateConfig!({ ...params, config: { vcpu: 2, snapshot: "x" } })).toMatchObject({ ok: false });
    expect(await hooks.onEnvironmentValidateConfig!(params)).toMatchObject({ ok: true });
  });

  it("probes with a sized throwaway machine and deletes it", async () => {
    const before = new Set((await sdk().machines.list()).map((machine) => machine.id));
    const probe = await timed("probe", () => hooks.onEnvironmentProbe!({ ...params, config: { ...params.config, vcpu: 2 } }));
    expect(probe).toMatchObject({ ok: true, metadata: { remoteCwd: "/home/boxd/paperclip-workspace" } });
    const name = String(probe.metadata?.machineName);
    expect(name).toMatch(/^paperclip-e2e-probe-/);
    const leftover = (await sdk().machines.list()).filter((machine) => !before.has(machine.id) && machine.name === name);
    expect(leftover).toEqual([]);

    const failed = await hooks.onEnvironmentProbe!({ ...params, config: { ...params.config, apiKey: "bxd_invalid" } });
    expect(failed).toMatchObject({ ok: false, metadata: { provider: "boxd" } });
    expect(String(failed.metadata?.error)).not.toBe("");
  }, 120_000);

  it("runs create/exec/stdin/timeout/suspend/resume/stop/destroy", async () => {
    const lease = await timed("acquire", () => acquire());
    const providerLeaseId = lease.providerLeaseId!;
    try {
      const machine = await sdk().machines.get(providerLeaseId);
      expect(machine.labels).toMatchObject({
        "paperclip-provider": "boxd",
        "paperclip-environment": "boxd-plugin-smoke",
      });
      expect(machine.labels["paperclip-run"]).toMatch(/^smoke-/);
      expect(machine.networking.isolated).toBe(true);
      if (process.env.BOXD_ORG) expect([machine.org?.id, machine.org?.name]).toContain(process.env.BOXD_ORG);

      const workspace = await hooks.onEnvironmentRealizeWorkspace!({ ...params, lease, workspace: {} });
      expect(workspace.cwd).toBe("/home/boxd/paperclip-workspace");

      const tools = await hooks.onEnvironmentExecute!({
        ...params, lease, command: "sh", args: ["-c", "command -v node && command -v tar && command -v claude"],
      });
      expect(tools).toMatchObject({ exitCode: 0, timedOut: false });

      const streams = await timed("execute", () => hooks.onEnvironmentExecute!({
        ...params, lease, command: "sh", args: ["-c", "cat > note.txt; printf '%s' \"$SMOKE\" >&2; exit 7"],
        stdin: "persisted\n", env: { SMOKE: "stderr works" }, cwd: workspace.cwd,
      }));
      expect(streams).toEqual({ exitCode: 7, timedOut: false, stdout: "", stderr: "stderr works" });
      const staged = await hooks.onEnvironmentExecute!({
        ...params, lease, command: "sh", args: ["-c", "ls /tmp | grep -c '^paperclip-stdin-' || true"],
      });
      expect(staged.stdout.trim()).toBe("0");

      const emptyStdin = await hooks.onEnvironmentExecute!({ ...params, lease, command: "wc", args: ["-c"], stdin: "" });
      expect(emptyStdin).toMatchObject({ exitCode: 0, stdout: "0\n" });
      const stdinMode = await hooks.onEnvironmentExecute!({
        ...params, lease, command: "sh", args: ["-c", "stat -c %a \"$(readlink /proc/self/fd/0)\""], stdin: "private",
      });
      expect(stdinMode.stdout.trim()).toBe("600");

      const quoted = await hooks.onEnvironmentExecute!({
        ...params, lease, command: "printf", args: ["%s|", "it's", "$HOME", "a b"],
      });
      expect(quoted.stdout).toBe("it's|$HOME|a b|");

      const payload = randomBytes(5 * 1024 * 1024);
      const digest = createHash("sha256").update(payload).digest("hex");
      const upload = await timed("upload5MiB", () => hooks.onEnvironmentExecute!({
        ...params, lease, command: "sh", args: ["-c", "base64 -d > big.bin && sha256sum big.bin | cut -d' ' -f1"],
        stdin: payload.toString("base64"), cwd: workspace.cwd,
      }));
      expect(upload.stdout.trim()).toBe(digest);
      const download = await timed("download5MiB", () => hooks.onEnvironmentExecute!({
        ...params, lease, command: "base64", args: ["-w0", "big.bin"], cwd: workspace.cwd,
      }));
      expect(createHash("sha256").update(Buffer.from(download.stdout, "base64")).digest("hex")).toBe(digest);

      const timeout = await timed("timeout", () => hooks.onEnvironmentExecute!({
        ...params, lease, command: "sh", args: ["-c", "sleep 47 & sleep 48; wait"], timeoutMs: 2_000,
      }));
      expect(timeout).toMatchObject({ exitCode: null, timedOut: true });
      await waitFor("the timed out command to end", 15_000, async () => {
        const left = await hooks.onEnvironmentExecute!({
          ...params, lease, command: "sh", args: ["-c", "pgrep -fc 'sleep 4[78]' || true"],
        });
        return left.stdout.trim() === "0";
      });

      await hooks.onEnvironmentExecute!({
        ...params, lease, command: "sh", args: ["-c", "setsid -f sh -c 'while true; do date +%s >> ticks; sleep 1; done' >/dev/null 2>&1 < /dev/null"], cwd: workspace.cwd,
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const released = await timed("releaseSuspend", () => hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId, leaseMetadata: lease.metadata }));
      expect(released).toBeUndefined();
      expect((await sdk().machines.get(providerLeaseId)).status).toBe("suspended");
      expect(await hooks.onEnvironmentInspectLease!({ ...params, providerLeaseId })).toEqual({ providerLeaseId, state: "stopped" });

      const resumed = await timed("resumeSuspended", () => hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata: lease.metadata }));
      expect(resumed.providerLeaseId).toBe(providerLeaseId);
      expect(resumed.metadata).toMatchObject({ resumedLease: true, remoteCwd: workspace.cwd });
      expect(await hooks.onEnvironmentInspectLease!({ ...params, providerLeaseId })).toEqual({ providerLeaseId, state: "active" });
      const kept = await hooks.onEnvironmentExecute!({
        ...params, lease: resumed, command: "sh", args: ["-c", "cat note.txt; a=$(wc -l < ticks); sleep 2; b=$(wc -l < ticks); [ \"$b\" -gt \"$a\" ] && echo process-kept"], cwd: workspace.cwd,
      });
      expect(kept.stdout).toBe("persisted\nprocess-kept\n");

      const stopped = await timed("stop", () => hooks.onEnvironmentStopLease!({ ...params, providerLeaseId, leaseMetadata: lease.metadata }));
      expect(stopped).toEqual({ providerLeaseId, state: "stopped" });
      const restarted = await timed("resumeStopped", () => hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata: lease.metadata }));
      const afterStop = await hooks.onEnvironmentExecute!({ ...params, lease: restarted, command: "cat", args: ["note.txt"], cwd: workspace.cwd });
      expect(afterStop).toMatchObject({ exitCode: 0, stdout: "persisted\n" });
    } finally {
      const receipt = await timed("destroy", () => hooks.onEnvironmentDestroyLease!({ ...params, providerLeaseId, leaseMetadata: lease.metadata }));
      expect(receipt).toEqual({ providerLeaseId, state: "destroyed" });
      expect(await hooks.onEnvironmentInspectLease!({ ...params, providerLeaseId })).toEqual({ providerLeaseId, state: "destroyed" });
      expect(await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata: lease.metadata }))
        .toEqual({ providerLeaseId: null, metadata: { expired: true } });
    }
  }, 300_000);

  it("starts a stopped machine when a command arrives, and deletes it on release without reuse", async () => {
    const lease = await acquire(ephemeral, { requestedCwd: "/home/boxd/custom-cwd" });
    const providerLeaseId = lease.providerLeaseId!;
    try {
      expect(lease.metadata).toMatchObject({ remoteCwd: "/home/boxd/custom-cwd", reuseLease: false });
      await hooks.onEnvironmentExecute!({ ...ephemeral, lease, command: "sh", args: ["-c", "echo kept > note.txt"] });
      await sdk().machines.stop(providerLeaseId);
      await waitFor("the machine to stop", 60_000, async () => (await sdk().machines.get(providerLeaseId)).status === "stopped");

      const result = await timed("executeOnStopped", () => hooks.onEnvironmentExecute!({ ...ephemeral, lease, command: "cat", args: ["note.txt"] }));
      expect(result).toMatchObject({ exitCode: 0, stdout: "kept\n" });

      await sdk().machines.stop(providerLeaseId);
      await waitFor("the machine to stop", 60_000, async () => (await sdk().machines.get(providerLeaseId)).status === "stopped");
      const realized = await hooks.onEnvironmentRealizeWorkspace!({ ...ephemeral, lease, workspace: {} });
      expect(realized.cwd).toBe("/home/boxd/custom-cwd");

      const receipt = await timed("releaseDestroy", () => hooks.onEnvironmentReleaseLease!({ ...ephemeral, providerLeaseId, leaseMetadata: lease.metadata }));
      expect(receipt).toEqual({ providerLeaseId, state: "destroyed" });
      expect(await machineOrNull(providerLeaseId)).toBeNull();
    } finally {
      await cleanup(providerLeaseId);
    }
  }, 300_000);

  it("wakes and stops hibernated and suspended machines, and stops on cancel or stop_and_retain", async () => {
    const lease = await acquire();
    const providerLeaseId = lease.providerLeaseId!;
    const leaseMetadata = lease.metadata;
    const readNote = async (current: typeof lease) =>
      await hooks.onEnvironmentExecute!({ ...params, lease: current, command: "cat", args: ["note.txt"] });
    const hibernate = async () => {
      await sdk().machines.hibernate(providerLeaseId);
      await waitFor("the machine to hibernate", 120_000, async () => (await sdk().machines.get(providerLeaseId)).status === "hibernated");
    };
    try {
      await hooks.onEnvironmentExecute!({ ...params, lease, command: "sh", args: ["-c", "echo kept > note.txt"] });

      await hibernate();
      expect(await hooks.onEnvironmentInspectLease!({ ...params, providerLeaseId })).toEqual({ providerLeaseId, state: "stopped" });
      const woken = await timed("resumeHibernated", () => hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata }));
      expect(await readNote(woken)).toMatchObject({ exitCode: 0, stdout: "kept\n" });

      await hibernate();
      expect(await timed("stopHibernated", () => hooks.onEnvironmentStopLease!({ ...params, providerLeaseId, leaseMetadata })))
        .toEqual({ providerLeaseId, state: "stopped" });
      expect((await sdk().machines.get(providerLeaseId)).status).toBe("stopped");

      let current = await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata });
      await hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId, leaseMetadata });
      expect((await sdk().machines.get(providerLeaseId)).status).toBe("suspended");
      expect(await timed("stopSuspended", () => hooks.onEnvironmentStopLease!({ ...params, providerLeaseId, leaseMetadata })))
        .toEqual({ providerLeaseId, state: "stopped" });

      current = await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata });
      expect(await hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId, leaseMetadata, cancelActiveWork: true }))
        .toEqual({ providerLeaseId, state: "stopped" });

      current = await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata });
      expect(await hooks.onEnvironmentReleaseLease!({ ...ephemeral, providerLeaseId, leaseMetadata, resourceDisposition: "stop_and_retain" }))
        .toEqual({ providerLeaseId, state: "stopped" });

      current = await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata });
      expect(await readNote(current)).toMatchObject({ exitCode: 0, stdout: "kept\n" });
    } finally {
      await cleanup(providerLeaseId);
    }
  }, 600_000);

  it("bounds the machine lifetime at a requested expiry", async () => {
    const requestedExpiresAt = new Date(Date.now() + 45_000).toISOString();
    const lease = await acquire(ephemeral, { requestedExpiresAt });
    const providerLeaseId = lease.providerLeaseId!;
    try {
      expect(Date.parse(lease.expiresAt!)).toBeLessThanOrEqual(Date.parse(requestedExpiresAt));
      const machine = await sdk().machines.get(providerLeaseId);
      expect(machine.deleteAt).not.toBeNull();
      expect(machine.deleteAt!.getTime()).toBeLessThanOrEqual(Date.parse(requestedExpiresAt));
      await timed("expiry", () => waitFor("boxd to delete the expired machine", 180_000, async () => {
        const current = await machineOrNull(providerLeaseId);
        return current === null || current.status === "destroyed";
      }));
      expect(await hooks.onEnvironmentInspectLease!({ ...ephemeral, providerLeaseId })).toEqual({ providerLeaseId, state: "destroyed" });
    } finally {
      await cleanup(providerLeaseId);
    }
  }, 300_000);

  it("restores each run from a snapshot", async () => {
    const source = await acquire(ephemeral);
    const snapshotName = `paperclip-e2e-${randomUUID().slice(0, 8)}`;
    let restoredId: string | null = null;
    try {
      await hooks.onEnvironmentExecute!({ ...ephemeral, lease: source, command: "sh", args: ["-c", "echo from-snapshot > /home/boxd/golden.txt"] });
      await timed("snapshotSave", () => sdk().snapshots.create(source.providerLeaseId!, snapshotName));
      await waitFor("the snapshot to be ready", 300_000, async () => {
        const snapshot = await sdk().snapshots.get(snapshotName).catch(() => null);
        return snapshot?.status === "ready";
      });

      const snapshotParams = { ...ephemeral, config: { ...ephemeral.config, snapshot: snapshotName } };
      const restored = await timed("acquireFromSnapshot", () => acquire(snapshotParams));
      restoredId = restored.providerLeaseId!;
      expect(restored.metadata).toMatchObject({ snapshot: snapshotName });
      expect((await sdk().machines.get(restoredId)).networking.isolated).toBe(true);
      const golden = await hooks.onEnvironmentExecute!({ ...snapshotParams, lease: restored, command: "cat", args: ["/home/boxd/golden.txt"] });
      expect(golden).toMatchObject({ exitCode: 0, stdout: "from-snapshot\n" });
    } finally {
      await cleanup(restoredId);
      await cleanup(source.providerLeaseId);
      await sdk().snapshots.delete(snapshotName).catch(() => undefined);
    }
  }, 600_000);

  it("creates fresh machines at the configured size", async () => {
    const sized = { ...ephemeral, config: { ...ephemeral.config, vcpu: 2 } };
    const lease = await acquire(sized);
    try {
      const machine = await sdk().machines.get(lease.providerLeaseId!);
      expect(machine.resources.vcpu).toBe(2);
      expect(machine.resources.memoryBytes).toBe(8 * 1024 ** 3);
      const nproc = await hooks.onEnvironmentExecute!({ ...sized, lease, command: "nproc" });
      expect(nproc.stdout.trim()).toBe("2");
    } finally {
      await cleanup(lease.providerLeaseId);
    }
  }, 180_000);

  it("leaves no machines behind", async () => {
    const leftover = (await sdk().machines.list())
      .filter((machine) => machine.name.startsWith("paperclip-e2e-") && machine.status !== "destroyed");
    expect(leftover.map((machine) => machine.name)).toEqual([]);
  });
});
