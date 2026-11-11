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
  'echo "== runner and provider processes"; ps -eo pid,ppid,sid,etimes,stat,rss,args 2>/dev/null'
    + ' | grep -E "paperclip-runner|runnerd|opencode|codex|claude|acpx" | grep -v grep | cut -c1-400',
  'echo "== memory"; free -m 2>/dev/null',
  'echo "== disk"; df -h / /tmp 2>/dev/null',
  'echo "== oom"; dmesg 2>/dev/null | grep -iE "oom|killed process" | tail -n 20',
  'for f in $(find / -xdev \\( -name runnerd.stderr.log -o -name runner-process.identity -o -name runner-state.json \\) -type f 2>/dev/null | head -n 30); do'
    + ' echo "== file $f $(stat -c "%s bytes, modified %y" "$f" 2>/dev/null)"; tail -c 24576 "$f"; echo; done',
].join("; ");

export interface RunnerLogCapture {
  label: string;
  observedAt: string;
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
  client?: ProbeClient; timeoutSeconds?: number;
}): Promise<RunnerLogCapture> {
  const label = captureDirectoryName(input.label);
  const capture: RunnerLogCapture = { label, observedAt: new Date().toISOString(), sandboxes: [], error: null };
  const directory = path.join(input.outDir, label);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const client = input.client ?? await createRemoteFixtureClient(input.apiKey) as unknown as ProbeClient;
    const wave = { companyId: input.companyId, environmentId: input.environmentId };
    const rows: DaytonaSandboxRow[] = [];
    for await (const row of client.list({ labels: { "paperclip-company-id": wave.companyId, "paperclip-environment-id": wave.environmentId } })) rows.push(row);
    for (const row of selectWaveSandboxes(rows, wave)) {
      const entry: RunnerLogCapture["sandboxes"][number] = { id: row.id, name: row.name ?? null, state: row.state ?? null, file: null, exitCode: null, error: null };
      capture.sandboxes.push(entry);
      if (!probeableSandbox(row)) continue;
      try {
        const sandbox = await client.get(row.id);
        const response = await sandbox.process.executeCommand(`sh -c '${RUNNER_LOG_PROBE.replace(/'/g, `'\\''`)}'`, undefined, {}, input.timeoutSeconds ?? 20);
        entry.exitCode = response.exitCode;
        entry.file = `${row.id}.txt`;
        await writeFile(path.join(directory, entry.file), redactKnownSecrets(String(response.result ?? ""), input.secrets), { mode: 0o600 });
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    capture.error = error instanceof Error ? error.message : String(error);
  }
  try {
    await writeFile(path.join(directory, "index.json"), `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  } catch { /* the directory itself failed; the returned record still carries the error */ }
  return capture;
}
