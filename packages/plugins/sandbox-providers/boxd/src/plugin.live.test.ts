import { createHash, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import plugin from "./plugin.js";

it.skipIf(process.env.BOXD_LIVE_TEST !== "1")("boxd create/exec/stdin/reuse/stop/destroy live smoke", async () => {
  if (!process.env.BOXD_API_KEY) throw new Error("Set BOXD_API_KEY for the live smoke.");
  const hooks = plugin.definition;
  const timings: Record<string, number> = {};
  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      timings[label] = Math.round(performance.now() - startedAt);
    }
  };
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

  const lease = await timed("acquire", () => hooks.onEnvironmentAcquireLease!({ ...params, runId: `smoke-${Date.now()}` }));
  const providerLeaseId = lease.providerLeaseId!;
  try {
    const workspace = await hooks.onEnvironmentRealizeWorkspace!({ ...params, lease, workspace: {} });
    expect(workspace.cwd).toBe("/home/boxd/paperclip-workspace");

    const probe = await hooks.onEnvironmentExecute!({
      ...params, lease, command: "sh", args: ["-c", "command -v node && command -v tar && command -v claude"],
    });
    expect(probe).toMatchObject({ exitCode: 0, timedOut: false });

    const streams = await timed("execute", () => hooks.onEnvironmentExecute!({
      ...params, lease, command: "sh", args: ["-c", "cat > note.txt; printf '%s' \"$SMOKE\" >&2; exit 7"],
      stdin: "persisted\n", env: { SMOKE: "stderr works" }, cwd: workspace.cwd,
    }));
    expect(streams).toEqual({ exitCode: 7, timedOut: false, stdout: "", stderr: "stderr works" });

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
      ...params, lease, command: "sleep", args: ["30"], timeoutMs: 2_000,
    }));
    expect(timeout).toMatchObject({ exitCode: null, timedOut: true });

    await hooks.onEnvironmentExecute!({
      ...params, lease, command: "sh", args: ["-c", "setsid -f sh -c 'while true; do date +%s >> ticks; sleep 1; done' >/dev/null 2>&1 < /dev/null"], cwd: workspace.cwd,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    await timed("releaseSuspend", () => hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId, leaseMetadata: lease.metadata }));
    expect(await hooks.onEnvironmentInspectLease!({ ...params, providerLeaseId })).toEqual({ providerLeaseId, state: "stopped" });

    const resumed = await timed("resumeSuspended", () => hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId, leaseMetadata: lease.metadata }));
    expect(resumed.providerLeaseId).toBe(providerLeaseId);
    expect(resumed.metadata).toMatchObject({ resumedLease: true, remoteCwd: workspace.cwd });
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
    await hooks.onShutdown!();
    console.log(`boxd live smoke timings (ms): ${JSON.stringify(timings)}`);
  }
}, 300_000);
