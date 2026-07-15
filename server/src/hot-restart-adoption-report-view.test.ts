import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeDir = mkdtempSync(path.join(tmpdir(), "hot-restart-report-view-"));

vi.mock("./home-paths.js", () => ({
  resolvePaperclipHomeDir: () => homeDir,
}));

const { readRecentHotRestartAdoptionReport, getHotRestartReportViewPath } = await import(
  "./hot-restart-adoption-report-view.js"
);

function writeReport(body: unknown) {
  writeFileSync(getHotRestartReportViewPath(), JSON.stringify(body), "utf8");
}

afterEach(() => {
  rmSync(getHotRestartReportViewPath(), { force: true });
});

describe("readRecentHotRestartAdoptionReport", () => {
  const now = new Date("2026-03-20T12:10:00.000Z");

  it("returns null when no report file exists", () => {
    expect(readRecentHotRestartAdoptionReport(now)).toBeNull();
  });

  it("summarizes a recent completed report into counts", () => {
    writeReport({
      completedAt: "2026-03-20T12:05:00.000Z",
      newServerVersion: "abc1234",
      adoptedRunIds: ["a", "b"],
      finalizedWhileDownRunIds: ["c"],
      lostRunIds: [],
    });
    expect(readRecentHotRestartAdoptionReport(now)).toEqual({
      completedAt: "2026-03-20T12:05:00.000Z",
      newServerVersion: "abc1234",
      adopted: 2,
      finalizedWhileDown: 1,
      lost: 0,
    });
  });

  it("ignores a report older than the freshness window", () => {
    writeReport({
      completedAt: "2026-03-20T11:00:00.000Z",
      newServerVersion: "abc1234",
      adoptedRunIds: ["a"],
      finalizedWhileDownRunIds: [],
      lostRunIds: [],
    });
    expect(readRecentHotRestartAdoptionReport(now)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    writeFileSync(getHotRestartReportViewPath(), "{ not json", "utf8");
    expect(readRecentHotRestartAdoptionReport(now)).toBeNull();
  });
});
