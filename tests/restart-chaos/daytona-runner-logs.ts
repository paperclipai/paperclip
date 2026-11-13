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

/**
 * Class R (class-r.ts): what killed or wedged the provider. On top of the Runner probe:
 * - every process with its start time (`lstart`) and what it is blocked on (`wchan`), so a replaced process
 *   shows a new start time and a wedged one shows its wait;
 * - TCP sockets with their owners, so a provider blocked on a Paperclip callback shows an open connection;
 * - the Runner's runtime directory listing (size and last write of each file);
 * - the tail of every log, transcript or state file the Runner and the provider keep under the runtime root and
 *   the usual provider log homes (OpenCode `opencode/log`, Claude `debug` and `projects` transcripts, ACPX state).
 * A remote Runner's own stdout and stderr go to /dev/null, so these files are the only sandbox-side record.
 */
export const CLASS_R_PROBE = [
  'echo "== observed_at $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"',
  'echo "== uptime"; cat /proc/uptime 2>/dev/null',
  'echo "== processes"; ps -eo pid,ppid,sid,lstart,etimes,stat,wchan:24,rss,args 2>/dev/null | cut -c1-400 | head -n 160',
  'echo "== sockets"; (ss -tanp 2>/dev/null || netstat -tanp 2>/dev/null) | head -n 80',
  'echo "== memory"; free -m 2>/dev/null',
  'echo "== disk"; df -h / /tmp 2>/dev/null',
  'echo "== oom"; dmesg 2>/dev/null | grep -iE "oom|killed process" | tail -n 20',
  // Every Runner runtime root: the shared checkout's and each isolated task workspace's (`.paperclip-workspaces/<id>`).
  'roots=$(find /home/daytona -xdev -maxdepth 5 -type d -name .paperclip-runtime -prune -print 2>/dev/null | head -n 20)',
  'echo "== runtime roots"; echo "$roots"',
  'echo "== runtime files"; for root in $roots; do find "$root" -xdev -maxdepth 9 \\( -name node_modules -o -name provider-pack \\) -prune -o -type f'
    + ' -printf "%TY-%Tm-%TdT%TH:%TM:%TS %10s %p\\n" 2>/dev/null; done | sort | tail -n 200',
  'for f in $(find $roots /tmp /home/daytona/.local/share/opencode /home/daytona/.claude -xdev -maxdepth 10'
    + ' \\( -name node_modules -o -name provider-pack \\) -prune -o -type f'
    + ' \\( -name "*.log" -o -name "*.stderr" -o -name "*state*.json" -o -name "*.identity"'
    + ' -o -path "*opencode/log/*" -o -path "*/debug/*.txt" -o -path "*/projects/*.jsonl" \\) -mmin -240 -print 2>/dev/null | head -n 60); do'
    + ' echo "== file $f $(stat -c "%s bytes, modified %y" "$f" 2>/dev/null)"; tail -c 32768 "$f"; echo; done',
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
  /** The fixed probe to run: the Runner probe (default) or the class R probe. */
  probe?: "runner" | "class_r";
}): Promise<RunnerLogCapture> {
  const probe = input.probe === "class_r" ? CLASS_R_PROBE : RUNNER_LOG_PROBE;
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
          // The class R probe reads more files; give it longer, still inside the shared capture deadline.
          const response = await sandbox.process.executeCommand(`sh -c '${probe.replace(/'/g, `'\\''`)}'`, undefined, {},
            input.timeoutSeconds ?? (input.probe === "class_r" ? 40 : 20));
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

export interface SandboxCommandAttempt { sandboxId: string; exitCode: number | null; output: string; error: string | null }

/**
 * Runs one fixed command (a fixed script with validated arguments, built by the caller) in the started sandboxes
 * of this wave, one at a time, until `done` accepts a result. Only CR2 (class-r.ts) uses it; its script acts only
 * in the sandbox whose Runner serves the task's run. Failures are recorded, never thrown.
 *
 * The whole search shares one deadline (default 60 s), because CR2 runs it inside a fault, sometimes while the
 * controller is down. Once the deadline passes no new command starts, and the result reports `deadline`.
 */
export async function executeInWaveSandboxes(input: {
  apiKey: string; companyId: string; environmentId: string; command: string; secrets: readonly string[];
  done: (attempt: SandboxCommandAttempt) => boolean;
  client?: ProbeClient; timeoutSeconds?: number; deadlineMs?: number;
}): Promise<{ attempts: SandboxCommandAttempt[]; error: string | null }> {
  const attempts: SandboxCommandAttempt[] = [];
  const deadlineMs = input.deadlineMs ?? 60_000;
  const deadlineAt = Date.now() + deadlineMs;
  const remainingSeconds = () => Math.floor((deadlineAt - Date.now()) / 1000);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">(resolve => { timer = setTimeout(() => resolve("deadline"), deadlineMs); });
  let expired = false;
  const search = async (): Promise<string | null> => {
    const client = input.client ?? await createRemoteFixtureClient(input.apiKey) as unknown as ProbeClient;
    const wave = { companyId: input.companyId, environmentId: input.environmentId };
    const rows: DaytonaSandboxRow[] = [];
    for await (const row of client.list({ labels: { "paperclip-company-id": wave.companyId, "paperclip-environment-id": wave.environmentId } })) rows.push(row);
    for (const row of selectWaveSandboxes(rows, wave).filter(probeableSandbox)) {
      // Never start a command (a kill) after the deadline.
      if (expired || remainingSeconds() < 1) return `deadline ${deadlineMs} ms exceeded`;
      let attempt: SandboxCommandAttempt;
      try {
        const sandbox = await client.get(row.id);
        if (expired || remainingSeconds() < 1) return `deadline ${deadlineMs} ms exceeded`;
        const response = await sandbox.process.executeCommand(input.command, undefined, {},
          Math.min(input.timeoutSeconds ?? 30, remainingSeconds()));
        attempt = { sandboxId: row.id, exitCode: response.exitCode,
          output: redactKnownSecrets(String(response.result ?? ""), input.secrets).slice(-16_384), error: null };
      } catch (error) {
        attempt = { sandboxId: row.id, exitCode: null, output: "", error: error instanceof Error ? error.message : String(error) };
      }
      if (expired) return `deadline ${deadlineMs} ms exceeded`;
      attempts.push(attempt);
      if (input.done(attempt)) return null;
    }
    return null;
  };
  try {
    const outcome = await Promise.race([search().catch((error: unknown) => error instanceof Error ? error.message : String(error)), deadline]);
    if (outcome === "deadline") { expired = true; return { attempts: [...attempts], error: `deadline ${deadlineMs} ms exceeded` }; }
    return { attempts, error: outcome };
  } finally {
    clearTimeout(timer);
  }
}
