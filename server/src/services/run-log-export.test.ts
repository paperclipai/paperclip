import { describe, expect, it } from "vitest";
import {
  RUN_LOG_EXPORT_MAX_EVENTS,
  buildRunLogArchiveFiles,
  collectRunLogExport,
  runLogExportFilename,
} from "../services/run-log-export.js";

function event(seq: number) {
  return { id: `event-${seq}`, seq, eventType: "lifecycle", message: `event ${seq}` };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    companyId: "company-1",
    logStore: "local_file",
    logRef: "ref-1",
    ...overrides,
  } as Parameters<typeof collectRunLogExport>[1];
}

describe("run log export", () => {
  it("collects events across pages and the bounded log", async () => {
    const all = [event(1), event(2), event(3)];
    const collected = await collectRunLogExport(
      {
        listEvents: async (_runId, afterSeq, limit) =>
          all.filter((row) => row.seq > afterSeq).slice(0, limit) as never,
        readLog: async () => ({ content: "log line\n", nextOffset: null }),
      },
      run(),
    );
    expect(collected.events).toHaveLength(3);
    expect(collected.eventsTruncated).toBe(false);
    expect(collected.logContent).toBe("log line\n");
    expect(collected.logTruncated).toBe(false);
    expect(collected.logAbsent).toBe(false);
  });

  it("caps events and flags truncation", async () => {
    const collected = await collectRunLogExport(
      {
        listEvents: async (_runId, afterSeq, limit) =>
          Array.from({ length: limit }, (_, index) => event(afterSeq + index + 1)) as never,
        readLog: async () => ({ content: "x", nextOffset: 100 }),
      },
      run(),
    );
    expect(collected.events).toHaveLength(RUN_LOG_EXPORT_MAX_EVENTS);
    expect(collected.eventsTruncated).toBe(true);
    expect(collected.logTruncated).toBe(true);
  });

  it("ships metadata and events when the log is absent or unreadable", async () => {
    const noStore = await collectRunLogExport(
      {
        listEvents: async () => [],
        readLog: async () => { throw new Error("must not read"); },
      },
      run({ logStore: null, logRef: null }),
    );
    expect(noStore.logContent).toBeNull();
    expect(noStore.logAbsent).toBe(true);

    const unreadable = await collectRunLogExport(
      {
        listEvents: async () => [],
        readLog: async () => { throw new Error("gone"); },
      },
      run(),
    );
    expect(unreadable.logContent).toBeNull();
    expect(unreadable.logAbsent).toBe(true);
  });

  it("builds a fixed-name archive with a manifest", () => {
    const files = buildRunLogArchiveFiles({
      run: { id: "run-1" },
      events: [{ seq: 1 }],
      logContent: "log line\n",
      eventsTruncated: false,
      logTruncated: false,
      logAbsent: false,
      exportedAt: "2026-09-08T00:00:00.000Z",
    });
    expect(Object.keys(files).sort()).toEqual(["events.jsonl", "log.txt", "manifest.json", "run.json"]);
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(manifest).toMatchObject({
      exportedAt: "2026-09-08T00:00:00.000Z",
      eventCount: 1,
      eventsTruncated: false,
      logPresent: true,
      logAbsent: false,
    });
    expect(new TextDecoder().decode(files["events.jsonl"])).toBe('{"seq":1}\n');

    const withoutLog = buildRunLogArchiveFiles({
      run: { id: "run-1" },
      events: [],
      logContent: null,
      eventsTruncated: false,
      logTruncated: false,
      logAbsent: true,
      exportedAt: "2026-09-08T00:00:00.000Z",
    });
    expect(Object.keys(withoutLog).sort()).toEqual(["events.jsonl", "manifest.json", "run.json"]);
  });

  it("names archives safely", () => {
    expect(runLogExportFilename("12345678-aaaa-bbbb-cccc-123456789abc")).toBe("paperclip-run-12345678.zip");
    expect(runLogExportFilename("!!!")).toBe("paperclip-run-run.zip");
  });
});
