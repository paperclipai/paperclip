import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  CLAUDE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createClaudeOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
} from "./output-inactivity-monitor.js";

// Emits one stream-json line then wedges: reads stdin forever, never writes
// again — the exact post-startup hang shape ENGA-578 caught upstream.
const FAKE_CLAUDE_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }) + "\\n");
process.stdin.resume();
process.stdin.on("data", () => {});
setInterval(() => {}, 60_000);
`;

describe("claude inactivity monitor (integration: real subprocess)", () => {
  it(
    "kills a claude child that goes silent after one event and surfaces a monitor failure",
    async () => {
      const runId = `claude-monitor-integration-${Date.now()}`;
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

      const monitor = createClaudeOutputInactivityMonitor({
        timeoutMs,
        onFire: (state) => {
          monitorFired = true;
          elapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
          if (kill("SIGTERM")) terminationSignal = "SIGTERM";
          sigkillTimer = setTimeout(() => {
            if (kill("SIGKILL")) terminationSignal = "SIGKILL";
          }, CLAUDE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
        },
      });

      try {
        const proc = await runChildProcess(runId, process.execPath, ["-e", FAKE_CLAUDE_SCRIPT], {
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutSec: 30,
          graceSec: 1,
          onSpawn: async (meta) => {
            killTarget = { pid: meta.pid, processGroupId: meta.processGroupId };
          },
          onLog: async (stream, chunk) => {
            logs.push({ stream, chunk });
            if (stream === "stdout") {
              monitor.noteStdoutChunk(chunk);
            }
          },
        });

        expect(monitorFired, "monitor should fire when claude goes silent").toBe(true);
        // Process was killed by our signal, not by hitting timeoutSec.
        expect(proc.timedOut).toBe(false);
        expect(["SIGTERM", "SIGKILL"]).toContain(proc.signal);
        expect(["SIGTERM", "SIGKILL"]).toContain(terminationSignal);
        expect(formatOutputInactivityMonitorErrorMessage(elapsedMs)).toMatch(
          /^monitor: no claude output for \d+m \d+s$/,
        );
        // Exactly one parsed stream-json event before silence.
        expect(monitor.state().parsedEventCount).toBe(1);
      } finally {
        monitor.stop();
        if (sigkillTimer) clearTimeout(sigkillTimer);
      }
    },
    15_000,
  );
});
