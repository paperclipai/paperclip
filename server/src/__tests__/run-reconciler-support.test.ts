import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRunPidFile,
  removeRunPidFile,
  runPidFilePath,
  writeRunPidFile,
} from "../services/recovery/run-pid-file.js";
import { renderRunReconcilerPrometheusMetrics, setRunReconcilerMetricSamples } from "../services/recovery/run-reconciler-metrics.js";

describe("run pid file", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("writes and reads a run pid record", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-pid-"));
    const runId = "abc-123";
    await writeRunPidFile(tempDir, runId, {
      pid: 4242,
      runId,
      startedAt: "2026-06-15T11:00:00.000Z",
    });

    expect(await readFile(runPidFilePath(tempDir, runId), "utf8")).toContain("4242");
    expect(await readRunPidFile(tempDir, runId)).toEqual({
      pid: 4242,
      runId,
      startedAt: "2026-06-15T11:00:00.000Z",
    });
  });

  it("removes pid files on cleanup", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-pid-"));
    const runId = "cleanup-123";
    await writeRunPidFile(tempDir, runId, {
      pid: 99,
      runId,
      startedAt: "2026-06-15T11:00:00.000Z",
    });
    await removeRunPidFile(tempDir, runId);
    expect(await readRunPidFile(tempDir, runId)).toBeNull();
  });
});

describe("run reconciler metrics", () => {
  it("renders prometheus text for active runs", () => {
    setRunReconcilerMetricSamples([
      {
        runId: "run-1",
        adapterType: "claude_local",
        agentNameKey: "engineer",
        active: 1,
        lastOutputAgeSeconds: 1800,
        childPidAlive: 1,
      },
    ]);

    const body = renderRunReconcilerPrometheusMetrics(new Date("2026-06-15T12:00:00.000Z"));
    expect(body).toContain("paperclip_run_active{adapter=\"claude_local\",agent=\"engineer\",runId=\"run-1\"} 1");
    expect(body).toContain("paperclip_run_last_output_age_seconds{adapter=\"claude_local\",runId=\"run-1\"} 1800");
    expect(body).toContain("paperclip_run_child_pid_alive{runId=\"run-1\"} 1");
  });
});
