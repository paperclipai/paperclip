import { describe, expect, it, vi } from "vitest";
import { runServerShutdownSequence } from "../index.js";

describe("runServerShutdownSequence", () => {
  it("drains running heartbeat runs before waiting for scheduler idle and telemetry flush", async () => {
    const steps: string[] = [];

    const exitError = new Error("exit");
    const exitProcess = vi.fn((code: number) => {
      steps.push(`exit:${code}`);
      throw exitError;
    });

    await expect(
      runServerShutdownSequence({
        signal: "SIGTERM",
        stopHeartbeatScheduler: () => {
          steps.push("stop-scheduler");
        },
        drainHeartbeatRunsForShutdown: async () => {
          steps.push("drain");
          return { interrupted: 2 };
        },
        waitForHeartbeatSchedulerIdle: async () => {
          steps.push("wait-idle");
        },
        stopTelemetry: async () => {
          steps.push("stop-telemetry");
        },
        appShutdown: () => {
          steps.push("app-shutdown");
        },
        stopEmbeddedPostgres: async () => {
          steps.push("stop-postgres");
        },
        shutdownInstrumentation: async () => {
          steps.push("shutdown-instrumentation");
        },
        exitProcess,
      }),
    ).rejects.toBe(exitError);

    expect(steps).toEqual([
      "stop-scheduler",
      "drain",
      "wait-idle",
      "stop-telemetry",
      "app-shutdown",
      "stop-postgres",
      "shutdown-instrumentation",
      "exit:0",
    ]);
  });

  it("continues shutdown when the graceful drain fails", async () => {
    const steps: string[] = [];
    const exitError = new Error("exit");

    await expect(
      runServerShutdownSequence({
        signal: "SIGTERM",
        stopHeartbeatScheduler: () => {
          steps.push("stop-scheduler");
        },
        drainHeartbeatRunsForShutdown: async () => {
          steps.push("drain");
          throw new Error("drain failed");
        },
        waitForHeartbeatSchedulerIdle: async () => {
          steps.push("wait-idle");
        },
        stopTelemetry: async () => {
          steps.push("stop-telemetry");
        },
        shutdownInstrumentation: async () => {
          steps.push("shutdown-instrumentation");
        },
        exitProcess: (code) => {
          steps.push(`exit:${code}`);
          throw exitError;
        },
      }),
    ).rejects.toBe(exitError);

    expect(steps).toEqual([
      "stop-scheduler",
      "drain",
      "wait-idle",
      "stop-telemetry",
      "shutdown-instrumentation",
      "exit:0",
    ]);
  });
});
