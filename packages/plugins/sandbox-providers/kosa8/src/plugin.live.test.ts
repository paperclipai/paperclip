import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import plugin, { DEFAULT_API_URL } from "./plugin.js";

const live = process.env.KOSA8_LIVE_TEST === "1" && Boolean(process.env.KOSA8_API_KEY?.trim());
const hooks = plugin.definition;
const environmentId = `live-${randomUUID().slice(0, 8)}`;
const base = { driverKey: "kosa8", companyId: "company-live", environmentId };
const config = { namePrefix: "pclive", ...(process.env.KOSA8_SIZE ? { size: process.env.KOSA8_SIZE } : {}) };
const reuse = { ...config, reuseLease: true };
const created = new Set<string>();

function apiUrl(): string {
  return (process.env.KOSA8_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

async function listLabelled(): Promise<Array<{ id: string; state: string }>> {
  const response = await fetch(`${apiUrl()}/v1/sandboxes?label=paperclip-environment=${environmentId}`, {
    headers: { Authorization: `Bearer ${process.env.KOSA8_API_KEY}` },
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { sandboxes: Array<{ id: string; state: string }> };
  return body.sandboxes;
}

async function acquire(runId: string, extra: Record<string, unknown> = {}) {
  const started = Date.now();
  const lease = await hooks.onEnvironmentAcquireLease!({ ...base, config: { ...config, ...extra }, runId });
  console.log(`acquire ${runId}: ${Date.now() - started} ms`);
  created.add(lease.providerLeaseId!);
  return lease;
}

async function run(
  lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> },
  script: string,
  extra: Record<string, unknown> = {},
) {
  return await hooks.onEnvironmentExecute!({
    ...base,
    config,
    lease,
    command: "sh",
    args: ["-c", script, "sh"],
    ...extra,
  } as Parameters<NonNullable<typeof hooks.onEnvironmentExecute>>[0]);
}

async function destroy(id: string) {
  await hooks.onEnvironmentDestroyLease!({ ...base, config, providerLeaseId: id }).catch(() => undefined);
  created.delete(id);
}

describe.skipIf(!live)("kosa8 sandbox provider (live)", () => {
  afterAll(async () => {
    for (const id of [...created]) await destroy(id);
    const left = (await listLabelled()).filter((sandbox) => sandbox.state !== "deleted");
    expect(left).toEqual([]);
  }, 180_000);

  it("validates and probes", async () => {
    expect((await hooks.onEnvironmentValidateConfig!({ driverKey: "kosa8", config })).ok).toBe(true);
    const started = Date.now();
    const probe = await hooks.onEnvironmentProbe!({ ...base, config });
    console.log(`probe: ${Date.now() - started} ms`);
    expect(probe.ok).toBe(true);
    const bad = await hooks.onEnvironmentProbe!({ ...base, config: { ...config, apiKey: "k8c_live_invalid" } });
    expect(bad.ok).toBe(false);
  }, 600_000);

  it("runs commands with stdin, env, args, exit codes, large output and timeouts", async () => {
    const lease = await acquire("run-exec");
    try {
      const quick = await run(lease, 'printf "%s|%s|" "$GREETING" "$(pwd)"; cat; echo warn >&2; exit 7', {
        env: { GREETING: "it's $HOME" },
        stdin: "piped",
        timeoutMs: 30_000,
      });
      expect(quick).toEqual({
        exitCode: 7,
        timedOut: false,
        stdout: "it's $HOME|/workspace/paperclip-workspace|piped",
        stderr: "warn\n",
      });
      const tools = await run(lease, "command -v node && command -v tar && command -v git", { timeoutMs: 30_000 });
      expect(tools.exitCode).toBe(0);
      const payload = randomUUID().repeat(60_000);
      const started = Date.now();
      const echoed = await run(lease, "cat", { stdin: payload });
      console.log(`2 MiB stdin and stdout round trip: ${Date.now() - started} ms`);
      expect(createHash("sha256").update(echoed.stdout).digest("hex")).toBe(createHash("sha256").update(payload).digest("hex"));
      const slow = await run(lease, "sleep 2; echo done");
      expect(slow).toMatchObject({ exitCode: 0, stdout: "done\n" });
      const bufferedTimeout = await run(lease, "sleep 30", { timeoutMs: 2_000 });
      expect(bufferedTimeout.timedOut).toBe(true);
      const backgroundTimeout = await run(lease, "sleep 300", { timeoutMs: 95_000 });
      expect(backgroundTimeout.timedOut).toBe(true);
      const leftovers = await run(lease, "ls -A /tmp/paperclip-kosa8 | wc -l", { timeoutMs: 30_000 });
      expect(leftovers.stdout.trim()).toBe("1");
    } finally {
      await destroy(lease.providerLeaseId!);
    }
  }, 600_000);

  it("keeps files and processes across sleep and wake", async () => {
    const lease = await acquire("run-reuse", { reuseLease: true });
    const id = lease.providerLeaseId!;
    try {
      await run(lease, "echo kept > marker; nohup sh -c 'while true; do date +%s > /tmp/tick; sleep 1; done' >/dev/null 2>&1 &", {
        timeoutMs: 30_000,
      });
      let started = Date.now();
      expect(await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id })).toBeUndefined();
      console.log(`release with sleep: ${Date.now() - started} ms`);
      expect(await hooks.onEnvironmentInspectLease!({ ...base, config: reuse, providerLeaseId: id })).toEqual({ providerLeaseId: id, state: "stopped" });
      started = Date.now();
      const resumed = await hooks.onEnvironmentResumeLease!({ ...base, config: reuse, providerLeaseId: id, leaseMetadata: lease.metadata });
      console.log(`resume from sleep: ${Date.now() - started} ms`);
      expect(resumed.providerLeaseId).toBe(id);
      const check = await run(resumed, 'cat marker; a=$(cat /tmp/tick); sleep 2; b=$(cat /tmp/tick); [ "$b" -gt "$a" ] && echo ticking', {
        timeoutMs: 30_000,
      });
      expect(check.stdout).toBe("kept\nticking\n");
      const longRun = run(resumed, "sleep 300");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      started = Date.now();
      const cancelled = await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id, cancelActiveWork: true });
      console.log(`release that cancels active work: ${Date.now() - started} ms`);
      expect(cancelled).toEqual({ providerLeaseId: id, state: "stopped" });
      const ended = await longRun;
      expect(ended.timedOut).toBe(false);
      expect(ended.exitCode).not.toBe(0);
      const again = await hooks.onEnvironmentResumeLease!({ ...base, config: reuse, providerLeaseId: id, leaseMetadata: lease.metadata });
      const quiet = await run(again, 'pgrep -f "sleep [3]00" >/dev/null && echo running || echo stopped', { timeoutMs: 30_000 });
      expect(quiet.stdout).toBe("stopped\n");
      const stopped = await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id, resourceDisposition: "stop_and_retain" });
      expect(stopped).toEqual({ providerLeaseId: id, state: "stopped" });
    } finally {
      await destroy(id);
    }
    expect(await hooks.onEnvironmentResumeLease!({ ...base, config: reuse, providerLeaseId: id })).toEqual({
      providerLeaseId: null,
      metadata: { expired: true },
    });
  }, 600_000);

  it("deletes the sandbox on release without reuse and honours requestedExpiresAt", async () => {
    const lease = await acquire("run-release");
    const id = lease.providerLeaseId!;
    expect(await hooks.onEnvironmentReleaseLease!({ ...base, config, providerLeaseId: id })).toEqual({ providerLeaseId: id, state: "destroyed" });
    created.delete(id);
    expect(await hooks.onEnvironmentInspectLease!({ ...base, config, providerLeaseId: id })).toEqual({ providerLeaseId: id, state: "destroyed" });
    const requestedExpiresAt = new Date(Date.now() + 120_000).toISOString();
    const bounded = await hooks.onEnvironmentAcquireLease!({ ...base, config, runId: "run-expiry", requestedExpiresAt });
    created.add(bounded.providerLeaseId!);
    expect(Date.parse(bounded.expiresAt!)).toBeLessThanOrEqual(Date.parse(requestedExpiresAt));
  }, 600_000);
});
