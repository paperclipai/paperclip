import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createCodexOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
} from "./output-inactivity-monitor.js";

const FAKE_CODEX_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "abc" }) + "\\n");
// Simulate a wedged codex: read stdin forever, never write again.
process.stdin.resume();
process.stdin.on("data", () => {});
setInterval(() => {}, 60_000);
`;

describe("codex inactivity monitor (integration: real subprocess)", () => {
  it(
    "kills a codex child that goes silent after one event and surfaces a monitor failure",
    async () => {
      const runId = `monitor-integration-${Date.now()}`;
      const timeoutMs = 250;
      const logs: Array<{ stream: string; chunk: string }> = [];
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let monitorFired = false;
      let terminationSignal: NodeJS.Signals | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
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

      const monitor = createCodexOutputInactivityMonitor({
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

      try {
        const proc = await runChildProcess(runId, process.execPath, ["-e", FAKE_CODEX_SCRIPT], {
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutSec: 30,
          graceSec: 1,
          onSpawn: async (meta) => {
            killTarget = { pid: meta.pid, processGroupId: meta.processGroupId };
          },
          onLog: async (stream, chunk) => {
            logs.push({ stream, chunk });
            monitor.noteOutputChunk(stream, chunk);
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
          /^monitor: no codex output for \d+m \d+s$/,
        );
        // We should have observed exactly one parsed JSONL event before silence.
        expect(monitor.state().parsedEventCount).toBe(1);
      } finally {
        monitor.stop();
        if (sigkillTimer) clearTimeout(sigkillTimer);
      }
    },
    15_000,
  );
});
