import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createCodexOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
} from "./output-inactivity-monitor.js";
import { createCodexProcessActivityMonitor } from "./process-activity-monitor.js";

const FAKE_CODEX_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "abc" }) + "\\n");
// Simulate a wedged codex: read stdin forever, never write again.
process.stdin.resume();
process.stdin.on("data", () => {});
setInterval(() => {}, 60_000);
`;

const ACTIVE_SILENT_BUILD_SCRIPT = `
const end = Date.now() + 7_000;
const work = () => {
  const sliceEnd = Math.min(end, Date.now() + 10);
  while (Date.now() < sliceEnd) {}
  if (Date.now() < end) setTimeout(work, 40);
};
work();
`;

describe("codex inactivity monitor (integration: real subprocess)", () => {
  it.skipIf(process.platform !== "linux")(
    "allows a long silent build while the child process group is consuming CPU",
    async () => {
      const runId = `monitor-active-build-${randomUUID()}`;
      // Leave enough room for the first /proc baseline on a busy CI host.
      // The test still exercises a multi-timeout period with no output, but
      // avoids treating scheduler contention as a product-level inactivity.
      const timeoutMs = 3_000;
      const processActivityMonitor: {
        current: ReturnType<typeof createCodexProcessActivityMonitor> | null;
      } = { current: null };
      let monitorFired = false;
      const monitor = createCodexOutputInactivityMonitor({
        timeoutMs,
        onFire: () => {
          monitorFired = true;
        },
      });

      try {
        const proc = await runChildProcess(
          runId,
          process.execPath,
          ["-e", ACTIVE_SILENT_BUILD_SCRIPT],
          {
            cwd: process.cwd(),
            env: process.env as Record<string, string>,
            timeoutSec: 12,
            graceSec: 1,
            onSpawn: async (meta) => {
              processActivityMonitor.current = createCodexProcessActivityMonitor({
                pid: meta.pid,
                processGroupId: meta.processGroupId,
                intervalMs: 50,
                onActivity: () => monitor.noteProcessActivity(),
              });
            },
            onLog: async (stream, chunk) => monitor.noteOutputChunk(stream, chunk),
          },
        );

        expect(proc.exitCode).toBe(0);
        expect(proc.timedOut).toBe(false);
        expect(monitorFired).toBe(false);
        expect(monitor.state().processActivityCount).toBeGreaterThan(0);
      } finally {
        processActivityMonitor.current?.stop();
        monitor.stop();
      }
    },
    15_000,
  );

  it(
    "kills a codex child that goes silent after one event and surfaces a monitor failure",
    async () => {
      const runId = `monitor-integration-${randomUUID()}`;
      const timeoutMs = 250;
      const logs: Array<{ stream: string; chunk: string }> = [];
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let monitorFired = false;
      let terminationSignal: NodeJS.Signals | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      const processActivityMonitor: {
        current: ReturnType<typeof createCodexProcessActivityMonitor> | null;
      } = { current: null };
      let elapsedMs = 0;

      const kill = (signal: NodeJS.Signals) => {
        const target = killTarget;
        if (!target) return false;
        if (target.processGroupId && target.processGroupId > 0) {
          try {
            process.kill(-target.processGroupId, signal);
            return true;
          } catch {
            /* fall through */
          }
        }
        if (target.pid && target.pid > 0) {
          try {
            process.kill(target.pid, signal);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      };

      const monitorRef: {
        current: ReturnType<typeof createCodexOutputInactivityMonitor> | null;
      } = { current: null };
      const startMonitor = () => {
        if (monitorRef.current) return monitorRef.current;
        monitorRef.current = createCodexOutputInactivityMonitor({
          timeoutMs,
          onFire: (state) => {
            monitorFired = true;
            elapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
            if (kill("SIGTERM")) terminationSignal = "SIGTERM";
            sigkillTimer = setTimeout(() => {
              if (kill("SIGKILL")) terminationSignal = "SIGKILL";
            }, CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
          },
        });
        return monitorRef.current;
      };

      try {
        const proc = await runChildProcess(runId, process.execPath, ["-e", FAKE_CODEX_SCRIPT], {
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutSec: 30,
          graceSec: 1,
          onSpawn: async (meta) => {
            killTarget = { pid: meta.pid, processGroupId: meta.processGroupId };
            processActivityMonitor.current = createCodexProcessActivityMonitor({
              pid: meta.pid,
              processGroupId: meta.processGroupId,
              intervalMs: 25,
              onActivity: () => monitorRef.current?.noteProcessActivity(),
            });
          },
          onLog: async (stream, chunk) => {
            logs.push({ stream, chunk });
            // The behavior under test is silence *after* Codex's first event.
            // Starting the short watchdog here avoids treating process startup
            // scheduler latency as output inactivity on a busy CI runner.
            startMonitor().noteOutputChunk(stream, chunk);
          },
        });

        expect(monitorFired, "monitor should fire when codex goes silent").toBe(true);
        // Process was killed by our signal, not by hitting timeoutSec.
        expect(proc.timedOut).toBe(false);
        expect(["SIGTERM", "SIGKILL"]).toContain(proc.signal);
        expect(["SIGTERM", "SIGKILL"]).toContain(terminationSignal);
        // The errorMessage shape mirrors the AdapterExecutionResult that
        // execute.ts will produce for this case.
        expect(formatOutputInactivityMonitorErrorMessage(elapsedMs)).toMatch(
          /^monitor: no codex activity \(output or process\) for \d+m \d+s$/,
        );
        // We should have observed exactly one parsed JSONL event before silence.
        expect(monitorRef.current?.state().parsedEventCount).toBe(1);
      } finally {
        processActivityMonitor.current?.stop();
        monitorRef.current?.stop();
        if (sigkillTimer) clearTimeout(sigkillTimer);
      }
    },
    15_000,
  );
});
