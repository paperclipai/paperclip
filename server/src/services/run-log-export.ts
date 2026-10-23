import type { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";

// Session-log export for heartbeat runs, borrowed from the DeepSeek Harness
// `session-log-export` package: bundle one run's metadata, events, and log
// text into a ZIP archive for download. Reads stay bounded (event pages and
// a log byte cap); truncation is recorded in manifest.json instead of
// failing. Redaction happens in the route, which owns the redaction
// registry; this module only collects and formats.

export const RUN_LOG_EXPORT_MAX_EVENTS = 5000;
export const RUN_LOG_EXPORT_EVENT_PAGE_SIZE = 1000;
export const RUN_LOG_EXPORT_MAX_LOG_BYTES = 8 * 1024 * 1024;

export const RUN_LOG_EXPORT_FILES = ["run.json", "events.jsonl", "log.txt", "manifest.json"] as const;

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type HeartbeatRunEventRow = typeof heartbeatRunEvents.$inferSelect;

export interface RunLogExportDeps {
  listEvents(runId: string, afterSeq: number, limit: number): Promise<HeartbeatRunEventRow[]>;
  readLog(
    run: { id: string; companyId: string; logStore: string | null; logRef: string | null },
    opts: { offset: number; limitBytes: number },
  ): Promise<{ content: string; nextOffset?: number | null }>;
}

export interface CollectedRunLogExport {
  run: HeartbeatRunRow;
  events: HeartbeatRunEventRow[];
  eventsTruncated: boolean;
  logContent: string | null;
  logTruncated: boolean;
  logAbsent: boolean;
}

function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toJsonLines(rows: ReadonlyArray<unknown>): string {
  if (rows.length === 0) return "";
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

export async function collectRunLogExport(
  deps: RunLogExportDeps,
  run: HeartbeatRunRow,
): Promise<CollectedRunLogExport> {
  const events: HeartbeatRunEventRow[] = [];
  let afterSeq = 0;
  let eventsTruncated = false;
  for (;;) {
    const page = await deps.listEvents(run.id, afterSeq, RUN_LOG_EXPORT_EVENT_PAGE_SIZE);
    if (page.length === 0) break;
    const room = RUN_LOG_EXPORT_MAX_EVENTS - events.length;
    if (page.length >= room) {
      const included = page.slice(0, Math.max(0, room));
      events.push(...included);
      if (page.length > room) {
        eventsTruncated = true;
      } else {
        // Exact-cap fill: probe one more event instead of assuming truncation.
        const lastSeq = included[included.length - 1]?.seq ?? afterSeq;
        const nextPage = await deps.listEvents(run.id, lastSeq, 1);
        eventsTruncated = nextPage.length > 0;
      }
      break;
    }
    events.push(...page);
    afterSeq = page[page.length - 1]?.seq ?? afterSeq;
    if (page.length < RUN_LOG_EXPORT_EVENT_PAGE_SIZE) break;
  }

  let logContent: string | null = null;
  let logTruncated = false;
  let logAbsent = false;
  if (run.logStore && run.logRef) {
    try {
      const result = await deps.readLog(
        { id: run.id, companyId: run.companyId, logStore: run.logStore, logRef: run.logRef },
        { offset: 0, limitBytes: RUN_LOG_EXPORT_MAX_LOG_BYTES },
      );
      logContent = result.content;
      logTruncated = typeof result.nextOffset === "number";
    } catch {
      // A missing or unreadable log must not fail the export; the manifest
      // records the absence and events plus metadata still ship.
      logAbsent = true;
    }
  } else {
    logAbsent = true;
  }

  return { run, events, eventsTruncated, logContent, logTruncated, logAbsent };
}

export interface RunLogArchiveInput {
  run: unknown;
  events: ReadonlyArray<unknown>;
  logContent: string | null;
  eventsTruncated: boolean;
  logTruncated: boolean;
  logAbsent: boolean;
  exportedAt?: string;
}

/** Assemble the archive file set. Fixed names only, never caller input. */
export function buildRunLogArchiveFiles(input: RunLogArchiveInput): Record<string, Uint8Array> {
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "run.json": encoder.encode(toJsonText(input.run)),
    "events.jsonl": encoder.encode(toJsonLines(input.events)),
    "manifest.json": encoder.encode(
      toJsonText({
        exportedAt: input.exportedAt ?? new Date().toISOString(),
        eventCount: input.events.length,
        eventsTruncated: input.eventsTruncated,
        logPresent: input.logContent !== null,
        logTruncated: input.logTruncated,
        logAbsent: input.logAbsent,
        files: input.logContent === null
          ? ["run.json", "events.jsonl", "manifest.json"]
          : [...RUN_LOG_EXPORT_FILES],
      }),
    ),
  };
  if (input.logContent !== null) {
    files["log.txt"] = encoder.encode(input.logContent);
  }
  return files;
}

export function runLogExportFilename(runId: string): string {
  const short = runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "run";
  return `paperclip-run-${short}.zip`;
}
