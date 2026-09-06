import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createOpenCodeOutputInactivityMonitor,
  formatOpenCodeInactivityMonitorErrorMessage,
} from "./output-inactivity-monitor.js";

const FAKE_OPENCODE_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "text", sessionID: "opencode_123", part: { text: "hello" } }) + "\\n");
// Simulate a wedged opencode: read stdin forever, never write again.
process.stdin.resume();
process.stdin.on("data", () => {});
setInterval(() => {}, 60_000);
`;

describe("opencode inactivity monitor (integration: real subprocess)", () => {
  it(
    "kills an opencode child that goes silent after one JSONL event and surfaces a monitor failure",
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
        if (process.platform !== "win32" && target.processGroupId && target.processGroupId > 0) {
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

      const monitor = createOpenCodeOutputInactivityMonitor({
        timeoutMs,
        onFire: (state) => {
          monitorFired = true;
          elapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
          if (kill("SIGTERM")) terminationSignal = "SIGTERM";
          sigkillTimer = setTimeout(() => {
            sigkillTimer = null;
            if (kill("SIGKILL")) terminationSignal = "SIGKILL";
          }, OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
          if (typeof (sigkillTimer as { unref?: () => void }).unref === "function") {
            (sigkillTimer as { unref: () => void }).unref();
          }
        },
      });

      try {
        const proc = await runChildProcess(runId, process.execPath, ["-e", FAKE_OPENCODE_SCRIPT], {
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutSec: 30,
          graceSec: 1,
          onSpawn: async (meta) => {
            killTarget = { pid: meta.pid ?? null, processGroupId: meta.processGroupId };
          },
          onLog: async (stream, chunk) => {
            logs.push({ stream, chunk });
            monitor.noteOutputChunk(stream, chunk);
          },
        });

        expect(monitorFired, "monitor should fire when opencode goes silent").toBe(true);
        // Process was killed by our signal, not by hitting timeoutSec.
        expect(proc.timedOut).toBe(false);
        expect(["SIGTERM", "SIGKILL"]).toContain(proc.signal);
        expect(["SIGTERM", "SIGKILL"]).toContain(terminationSignal);
        // The errorMessage shape mirrors the AdapterExecutionResult that
        // execute.ts will produce for this case.
        expect(formatOpenCodeInactivityMonitorErrorMessage(elapsedMs)).toMatch(
          /^monitor: no opencode activity for \d+s$/,
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

  it("keeps a healthy opencode session alive while JSONL output continues", async () => {
    const runId = `monitor-healthy-${Date.now()}`;
    const timeoutMs = 250;
    let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
    let monitorFired = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    const kill = (signal: NodeJS.Signals) => {
      const target = killTarget;
      if (!target) return false;
      if (process.platform !== "win32" && target.processGroupId && target.processGroupId > 0) {
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

    // Healthy script: emit a JSONL line every 100ms, then finish normally.
    const healthyScript = `
const ticks = 10;
let i = 0;
function tick() {
  process.stdout.write(JSON.stringify({ type: "text", sessionID: "opencode_123", part: { text: "tick " + i } }) + "\\n");
  i++;
  if (i < ticks) { setTimeout(tick, 100); return; }
  process.exit(0);
}
tick();
`;

    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs,
      onFire: () => {
        monitorFired = true;
        if (kill("SIGTERM")) {
          sigkillTimer = setTimeout(() => kill("SIGKILL"), OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
          if (typeof (sigkillTimer as { unref?: () => void }).unref === "function") {
            (sigkillTimer as { unref: () => void }).unref();
          }
        }
      },
    });

    try {
      const proc = await runChildProcess(
        runId,
        process.execPath,
        ["-e", healthyScript],
        {
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutSec: 30,
          graceSec: 1,
          onSpawn: async (meta) => {
            killTarget = { pid: meta.pid ?? null, processGroupId: meta.processGroupId };
          },
          onLog: async (stream, chunk) => {
            monitor.noteOutputChunk(stream, chunk);
          },
        },
      );

      expect(monitorFired).toBe(false);
      expect(proc.exitCode).toBe(0);
      expect(proc.timedOut).toBe(false);
      expect(monitor.state().parsedEventCount).toBe(10);
    } finally {
      monitor.stop();
      if (sigkillTimer) clearTimeout(sigkillTimer);
    }
  }, 15_000);
});
