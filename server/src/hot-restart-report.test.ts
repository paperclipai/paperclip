import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeHotRestartReport,
  getHotRestartReportPath,
  writeHotRestartPendingReport,
} from "./hot-restart-report.js";

const originalHome = process.env.PAPERCLIP_HOME;

afterEach(async () => {
  const current = process.env.PAPERCLIP_HOME;
  if (current) await fs.rm(current, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
});

describe("hot restart report", () => {
  it("classifies adopted, finalized-while-down, and lost preserved runs", async () => {
    process.env.PAPERCLIP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-report-"));
    writeHotRestartPendingReport({
      version: 1,
      requestedAt: "2026-07-15T18:00:00.000Z",
      previousServerPid: 1234,
      requestedByRunId: "routine-run",
      preservedRunIds: ["adopted", "finalized", "missing"],
    });

    const report = completeHotRestartReport({
      newServerVersion: "v2026.715.1",
      adoptedRunIds: ["adopted"],
      finalizedWhileDownRunIds: ["finalized"],
      rejectedRunIds: ["rejected"],
      now: new Date("2026-07-15T18:01:00.000Z"),
      newServerPid: 5678,
    });

    expect(report).toMatchObject({
      previousServerPid: 1234,
      newServerPid: 5678,
      newServerVersion: "v2026.715.1",
      requestedByRunId: "routine-run",
      adoptedRunIds: ["adopted"],
      finalizedWhileDownRunIds: ["finalized"],
      lostRunIds: ["rejected", "missing"],
    });
    expect(JSON.parse(await fs.readFile(getHotRestartReportPath(), "utf8"))).toEqual(report);
    expect(completeHotRestartReport({
      newServerVersion: "ignored",
      adoptedRunIds: [],
      finalizedWhileDownRunIds: [],
      rejectedRunIds: [],
    })).toBeNull();
  });
});
