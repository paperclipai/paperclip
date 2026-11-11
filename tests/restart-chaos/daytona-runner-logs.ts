/**
 * Sandbox-side evidence for `--env daytona`: what the remote Runner was doing when the control plane went
 * away and when it came back. Staging class R (`runner_remote_process_identity_unavailable`, see
 * doc/plans/2026-11-11-staging-failures-vs-chaos-coverage.md) found the Runner gone after a 4–7 minute
 * mid-turn outage; this captures its stderr log, process identity, durable state and the sandbox's
 * process, memory, disk and OOM evidence so the exit reason is visible in the wave folder.
 *
 * Read-only by construction: it lists this wave's sandboxes by their company and environment labels
 * (the same selection as daytona-sweep.ts) and runs one fixed probe that only reads (`ps`, `tail`, `stat`,
 * `find`, `free`, `df`, `dmesg`). It never stops, starts, archives or deletes a sandbox, and never runs a
 * command derived from wave data.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRemoteFixtureClient } from "../runner-e2e/remote-native-bootstrap.js";
import { selectWaveSandboxes, type DaytonaSandboxRow } from "./daytona-sweep.js";
import { redactKnownSecrets } from "./evidence.js";

/** The fixed read-only probe. Every file read is bounded with `tail -c`. */
export const RUNNER_LOG_PROBE = [
  'echo "== observed_at $(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  'echo "== uptime"; cat /proc/uptime 2>/dev/null',
  // Every process, not only the Runner's: a tool the agent started (for example T1's loop) shows as a child.
  'echo "== processes"; ps -eo pid,ppid,sid,etimes,stat,rss,args 2>/dev/null | cut -c1-400 | head -n 120',
  'echo "== memory"; free -m 2>/dev/null',
  'echo "== disk"; df -h / /tmp 2>/dev/null',
  'echo "== oom"; dmesg 2>/dev/null | grep -iE "oom|killed process" | tail -n 20',
  'for f in $(find / -xdev \\( -name runnerd.stderr.log -o -name runner-process.identity -o -name runner-state.json \\) -type f 2>/dev/null | head -n 30); do'
    + ' echo "== file $f $(stat -c "%s bytes, modified %y" "$f" 2>/dev/null)"; tail -c 24576 "$f"; echo; done',
].join("; ");

/** The whole capture (client, listing and every probe) gets this long; the outage it runs in must not grow. */
export const RUNNER_LOG_CAPTURE_DEADLINE_MS = 45_000;

export interface RunnerLogCapture {
  label: string;
  observedAt: string;
  /** True when the deadline ended the capture; sandboxes not reached are recorded with `error: "deadline"`. */
  deadlineExceeded?: boolean;
  sandboxes: Array<{ id: string; name: string | null; state: string | null; file: string | null; exitCode: number | null; error: string | null }>;
  error: string | null;
}

interface ProbeSandbox { process: { executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<{ exitCode: number; result: string }> } }
interface ProbeClient {
  list(query: { labels: Record<string, string> }): AsyncIterable<DaytonaSandboxRow>;
  get(id: string): Promise<ProbeSandbox>;
}

/** A capture label safe as a directory name (fault id and phase). */
export function captureDirectoryName(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Runner log capture needs a non-empty label");
  return safe.slice(0, 80);
}

/** Only started sandboxes can run the probe; stopped or archived ones are recorded by state alone. */
export function probeableSandbox(sandbox: DaytonaSandboxRow): boolean {
  return String(sandbox.state ?? "").toLowerCase() === "started";
}

/**
 * Capture every wave sandbox's Runner evidence into `<outDir>/<label>/<sandboxId>.txt` and an index.
 * Failures are recorded, never thrown: evidence capture must not fail or delay a wave beyond its timeout.
 */
export async function captureWaveRunnerLogs(input: {
  apiKey: string; companyId: string; environmentId: string; outDir: string; label: string; secrets: readonly string[];
  client?: ProbeClient; timeoutSeconds?: number; deadlineMs?: number;
}): Promise<RunnerLogCapture> {
  // An unusable label must not throw out of the restart path: fall back to a fixed directory and record why.
  let label = "capture";
  let labelError: string | null = null;
  try { label = captureDirectoryName(input.label); } catch (error) { labelError = error instanceof Error ? error.message : String(error); }
  const capture: RunnerLogCapture = { label, observedAt: new Date().toISOString(), sandboxes: [], error: labelError };
  const directory = path.join(input.outDir, label);
  const deadlineMs = input.deadlineMs ?? RUNNER_LOG_CAPTURE_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">(resolve => { timer = setTimeout(() => resolve("deadline"), deadlineMs); });
  // The probe races the shared deadline. A probe that loses may still be awaiting Daytona in the background:
  // `expired` stops it from probing or writing anything once the capture has been saved.
  let expired = false;
  const live = () => !expired && Date.now() < deadlineAt;
  try {
    const outcome = await Promise.race([probeWave(), deadline]);
    if (outcome === "deadline") {
      expired = true;
      capture.deadlineExceeded = true;
      // A probe still in flight when the deadline won left its entry with neither a file nor an error.
      for (const entry of capture.sandboxes) if (entry.file === null && entry.error === null && probeableSandbox({ id: entry.id, state: entry.state ?? undefined })) entry.error = "deadline";
      capture.error = `capture deadline ${deadlineMs} ms exceeded`;
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    await writeFile(path.join(directory, "index.json"), `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  } catch { /* the directory itself failed; the returned record still carries the error */ }
  return capture;

  async function probeWave(): Promise<void> {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const client = input.client ?? await createRemoteFixtureClient(input.apiKey) as unknown as ProbeClient;
      if (!live()) return;
      const wave = { companyId: input.companyId, environmentId: input.environmentId };
      const rows: DaytonaSandboxRow[] = [];
      for await (const row of client.list({ labels: { "paperclip-company-id": wave.companyId, "paperclip-environment-id": wave.environmentId } })) rows.push(row);
      if (!live()) return;
      // Every wave sandbox gets its entry before any probe, so a deadline marks the ones it never reached.
      const targets = selectWaveSandboxes(rows, wave).map(row => ({ row,
        entry: { id: row.id, name: row.name ?? null, state: row.state ?? null, file: null, exitCode: null, error: null } as RunnerLogCapture["sandboxes"][number] }));
      capture.sandboxes.push(...targets.map(target => target.entry));
      for (const { row, entry } of targets) {
        if (expired) return;
        if (!probeableSandbox(row)) continue;
        if (!live()) { if (!expired) entry.error = "deadline"; continue; }
        try {
          const sandbox = await client.get(row.id);
          if (!live()) { if (!expired) entry.error = "deadline"; continue; }
          const response = await sandbox.process.executeCommand(`sh -c '${RUNNER_LOG_PROBE.replace(/'/g, `'\\''`)}'`, undefined, {}, input.timeoutSeconds ?? 20);
          // Evidence that arrives after the deadline was taken after the outage window: never write it.
          if (!live()) { if (!expired) entry.error = "deadline"; continue; }
          entry.exitCode = response.exitCode;
          // The id names the file: keep it one safe path segment, and list the file only once it is written.
          const file = `${captureDirectoryName(row.id)}.txt`;
          await writeFile(path.join(directory, file), redactKnownSecrets(String(response.result ?? ""), input.secrets), { mode: 0o600 });
          entry.file = file;
        } catch (error) {
          if (!expired) entry.error = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      if (!expired) capture.error = error instanceof Error ? error.message : String(error);
    }
  }
}
