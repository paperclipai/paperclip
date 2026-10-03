import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectDatabaseBackupHealth } from "../services/database-backup-health.js";
import {
  buildDatabaseBackupAlertContent,
  clearDatabaseBackupFailureMarkers,
  createDatabaseBackupAlertReporter,
  DATABASE_BACKUP_ALERT_FINGERPRINT,
  raiseDatabaseBackupAlert,
  redactDatabaseBackupErrorMessage,
  resolveDatabaseBackupAlert,
  summarizeDatabaseBackupWarnings,
  writeDatabaseBackupFailureMarker,
  type DatabaseBackupAlertBoard,
} from "../services/database-backup-alerts.js";

type FakeIssue = {
  id: string;
  identifier: string;
  status: string;
  fingerprint: string;
  title: string;
  description: string;
  comments: string[];
};

function createFakeBoard(options: { failCreate?: boolean } = {}) {
  const records: FakeIssue[] = [];
  let counter = 0;
  const board: DatabaseBackupAlertBoard = {
    async findOpenAlert(_companyId, fingerprint) {
      const open = records.find(
        (r) => r.fingerprint === fingerprint && r.status !== "done" && r.status !== "cancelled",
      );
      return open ? { id: open.id, identifier: open.identifier, status: open.status } : null;
    },
    async createAlert(_companyId, input) {
      if (options.failCreate) throw new Error("board create failed");
      // Model the create-path dedup we keep: `allowDuplicate: false` in the
      // concrete adapter dedups ONLY against a NON-terminal recent-open-title
      // issue (the create-race guard). Crucially it must NOT be shadowed by a
      // resolved (`done`/`cancelled`) issue — that status-agnostic shadowing is
      // exactly the retained-idempotency-key bug this change removes. A `done`
      // alert therefore does not block a fresh create.
      const openSameTitle = records.find(
        (r) => r.title === input.title && r.status !== "done" && r.status !== "cancelled",
      );
      if (openSameTitle) {
        return {
          id: openSameTitle.id,
          identifier: openSameTitle.identifier,
          status: openSameTitle.status,
        };
      }
      counter += 1;
      const rec: FakeIssue = {
        id: `issue-${counter}`,
        identifier: `SIN-${counter}`,
        status: "todo",
        fingerprint: input.fingerprint,
        title: input.title,
        description: input.description,
        comments: [],
      };
      records.push(rec);
      return { id: rec.id, identifier: rec.identifier, status: rec.status };
    },
    async commentAlert(issueId, body) {
      records.find((r) => r.id === issueId)?.comments.push(body);
    },
    async resolveAlert(issueId, body) {
      const rec = records.find((r) => r.id === issueId);
      if (rec) {
        rec.comments.push(body);
        rec.status = "done";
      }
    },
  };
  return { board, records };
}

const FIXED_NOW = new Date("2026-09-07T12:00:00.000Z");

describe("redactDatabaseBackupErrorMessage", () => {
  it("strips postgres/postgresql connection URLs that may embed credentials", () => {
    const message =
      "pg_dump: error: connection to postgres://user:s3cr3t@db.internal:5432/paperclip failed";
    const redacted = redactDatabaseBackupErrorMessage(message);
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).not.toContain("db.internal");
    expect(redacted).toContain("postgres://[redacted]");
  });

  it("leaves a version-mismatch message intact (no secret content)", () => {
    const message = "pg_dump: error: server version: 18.0; pg_dump version: 16.9";
    expect(redactDatabaseBackupErrorMessage(message)).toBe(message);
  });
});

describe("buildDatabaseBackupAlertContent", () => {
  it("builds a failure alert carrying the exact (redacted) error and timestamp", () => {
    const { title, description } = buildDatabaseBackupAlertContent({
      reason: "failure",
      message: "pg_dump: error: server version mismatch",
      at: FIXED_NOW,
    });
    expect(title).toBe("Control-plane database backup is failing");
    expect(description).toContain("server version mismatch");
    expect(description).toContain("2026-09-07T12:00:00.000Z");
    expect(description).toContain(DATABASE_BACKUP_ALERT_FINGERPRINT);
  });

  it("includes each warning code in the health-driven alert", () => {
    const { title, description } = buildDatabaseBackupAlertContent({
      reason: "health",
      message: "stale",
      warnings: [
        { code: "database_backup_stale", message: "Latest database backup is 240h old, exceeding 36h." },
      ],
      at: FIXED_NOW,
    });
    expect(title).toBe("Control-plane database backup is unhealthy");
    expect(description).toContain("database_backup_stale");
    expect(description).toContain("240h old");
  });
});

describe("summarizeDatabaseBackupWarnings", () => {
  it("joins warning messages", () => {
    expect(
      summarizeDatabaseBackupWarnings([
        { code: "database_backup_missing", message: "No backups found." },
        { code: "database_backup_stale", message: "Too old." },
      ]),
    ).toBe("No backups found. Too old.");
  });
});

describe("raiseDatabaseBackupAlert (idempotency / dedup)", () => {
  it("creates the alert when none is open", async () => {
    const { board, records } = createFakeBoard();
    const result = await raiseDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      title: "t",
      description: "d",
      updateComment: "again",
    });
    expect(result.action).toBe("created");
    expect(records).toHaveLength(1);
  });

  it("never spawns a duplicate; updates the open issue with a comment", async () => {
    const { board, records } = createFakeBoard();
    await raiseDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      title: "t",
      description: "d",
      updateComment: "cycle 1",
    });
    const second = await raiseDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      title: "t",
      description: "d",
      updateComment: "cycle 2",
    });
    expect(second.action).toBe("updated");
    expect(records).toHaveLength(1);
    expect(records[0]!.comments).toEqual(["cycle 2"]);
  });

  it("creates a NEW open alert for a second incident after the first was resolved (no shadow by a done issue)", async () => {
    // Regression for SIN-70819: a resolved (`done`) alert must not be reused for
    // a later incident. Previously a static idempotencyKey survived resolution
    // (7-day retention) and dedup-hit the closed issue, so a genuine second
    // failure reported `created` with NO open board alert — the exact A09 gap.
    const { board, records } = createFakeBoard();
    const first = await raiseDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      title: "Control-plane database backup is failing",
      description: "d",
      updateComment: "incident 1",
    });
    expect(first.action).toBe("created");

    // Backup recovers → the open alert is resolved to done.
    await resolveDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      comment: "fixed",
    });
    expect(records[0]!.status).toBe("done");

    // It fails again within the old 7-day idempotency-retention window.
    const second = await raiseDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      title: "Control-plane database backup is failing",
      description: "d",
      updateComment: "incident 2",
    });
    // A brand-new OPEN alert, not the resolved one.
    expect(second.action).toBe("created");
    expect(second.issueId).not.toBe(first.issueId);
    expect(records).toHaveLength(2);
    expect(records[1]!.status).toBe("todo");
  });

  it("leaves an open issue untouched when no updateComment is supplied (no comment storm)", async () => {
    const { board, records } = createFakeBoard();
    await raiseDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      title: "t",
      description: "d",
    });
    const second = await raiseDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      title: "t",
      description: "d",
    });
    expect(second.action).toBe("exists");
    expect(records).toHaveLength(1);
    expect(records[0]!.comments).toEqual([]);
  });
});

describe("resolveDatabaseBackupAlert", () => {
  it("resolves the open alert and no-ops when none is open", async () => {
    const { board, records } = createFakeBoard();
    await raiseDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      title: "t",
      description: "d",
    });
    const resolved = await resolveDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      comment: "fixed",
    });
    expect(resolved.action).toBe("resolved");
    expect(records[0]!.status).toBe("done");

    const again = await resolveDatabaseBackupAlert(board, {
      companyId: "c1",
      fingerprint: DATABASE_BACKUP_ALERT_FINGERPRINT,
      comment: "fixed",
    });
    expect(again.action).toBe("noop");
  });
});

describe("failure marker (fs) integrates with the pure inspector", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pc-backup-marker-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the exact error as the first line and a timestamp, read back as last_failure", () => {
    const markerFile = join(dir, "health", "db-backup-to-s3.failure");
    writeDatabaseBackupFailureMarker(
      markerFile,
      "pg_dump: error: server version mismatch",
      FIXED_NOW,
    );
    const contents = readFileSync(markerFile, "utf8");
    expect(contents.split(/\r?\n/)[0]).toBe("pg_dump: error: server version mismatch");
    expect(contents).toContain("failedAt=2026-09-07T12:00:00.000Z");

    const status = inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: join(dir, "backups"),
      maxAgeHours: 36,
      alertFile: markerFile,
      now: FIXED_NOW,
    });
    expect(status.status).toBe("warning");
    expect(status.lastFailure?.message).toBe("pg_dump: error: server version mismatch");
    expect(status.warnings.map((w) => w.code)).toContain("database_backup_last_failure");
  });

  it("redacts a connection string before persisting it in the marker", () => {
    const markerFile = join(dir, "db-backup-to-s3.failure");
    writeDatabaseBackupFailureMarker(
      markerFile,
      "connection to postgres://user:s3cr3t@db:5432/paperclip refused",
      FIXED_NOW,
    );
    const contents = readFileSync(markerFile, "utf8");
    expect(contents).not.toContain("s3cr3t");
    expect(contents).toContain("postgres://[redacted]");
  });

  it("clears every candidate marker path", () => {
    const a = join(dir, "a.failure");
    const b = join(dir, "b.failure");
    writeDatabaseBackupFailureMarker(a, "x", FIXED_NOW);
    writeDatabaseBackupFailureMarker(b, "y", FIXED_NOW);
    clearDatabaseBackupFailureMarkers([a, b, join(dir, "missing.failure")]);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });
});

describe("createDatabaseBackupAlertReporter (defense-in-depth)", () => {
  let dir: string;
  let markerFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pc-backup-reporter-"));
    markerFile = join(dir, "health", "db-backup-to-s3.failure");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reportFailure writes the marker AND raises the board issue", async () => {
    const { board, records } = createFakeBoard();
    const reporter = createDatabaseBackupAlertReporter({
      markerFile,
      clearMarkerFiles: [markerFile],
      board,
      companyId: "c1",
      now: () => FIXED_NOW,
    });
    await reporter.reportFailure("pg_dump: error: server version mismatch");
    expect(existsSync(markerFile)).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]!.description).toContain("server version mismatch");
  });

  it("reportFailure still writes the marker when the board channel throws", async () => {
    const { board, records } = createFakeBoard({ failCreate: true });
    const reporter = createDatabaseBackupAlertReporter({
      markerFile,
      clearMarkerFiles: [markerFile],
      board,
      companyId: "c1",
      now: () => FIXED_NOW,
    });
    // Must not throw — a board failure cannot mask the backup failure signal.
    await expect(reporter.reportFailure("boom")).resolves.toBeUndefined();
    expect(existsSync(markerFile)).toBe(true);
    expect(records).toHaveLength(0);
  });

  it("reportFailure works with no board (marker-only channel)", async () => {
    const reporter = createDatabaseBackupAlertReporter({
      markerFile,
      clearMarkerFiles: [markerFile],
      board: null,
      companyId: null,
      now: () => FIXED_NOW,
    });
    await reporter.reportFailure("no board here");
    expect(readFileSync(markerFile, "utf8").split(/\r?\n/)[0]).toBe("no board here");
  });

  it("reportSuccess clears the marker and resolves the open alert", async () => {
    const { board, records } = createFakeBoard();
    const reporter = createDatabaseBackupAlertReporter({
      markerFile,
      clearMarkerFiles: [markerFile],
      board,
      companyId: "c1",
      now: () => FIXED_NOW,
    });
    await reporter.reportFailure("pg_dump: error: server version mismatch");
    expect(existsSync(markerFile)).toBe(true);
    expect(records[0]!.status).toBe("todo");

    await reporter.reportSuccess();
    expect(existsSync(markerFile)).toBe(false);
    expect(records[0]!.status).toBe("done");
  });

  it("reportFailure → reportSuccess → reportFailure raises a fresh open alert for the second incident", async () => {
    // End-to-end (marker + board channels) regression for SIN-70819: backup
    // flapping (fail → recover → fail) must produce a NEW open board alert on
    // the second failure, never silently reuse the resolved one.
    const { board, records } = createFakeBoard();
    const reporter = createDatabaseBackupAlertReporter({
      markerFile,
      clearMarkerFiles: [markerFile],
      board,
      companyId: "c1",
      now: () => FIXED_NOW,
    });

    await reporter.reportFailure("pg_dump: error: server version mismatch");
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("todo");

    await reporter.reportSuccess();
    expect(existsSync(markerFile)).toBe(false);
    expect(records[0]!.status).toBe("done");

    await reporter.reportFailure("pg_dump: error: server version mismatch (again)");
    // A second OPEN alert exists — the resolved one was not reused.
    expect(records).toHaveLength(2);
    expect(records[1]!.status).toBe("todo");
    expect(records[1]!.description).toContain("server version mismatch");
    expect(existsSync(markerFile)).toBe(true);
  });

  it("reportHealthWarnings creates one issue for a warning status and never duplicates on repeat ticks", async () => {
    const { board, records } = createFakeBoard();
    const reporter = createDatabaseBackupAlertReporter({
      markerFile,
      clearMarkerFiles: [markerFile],
      board,
      companyId: "c1",
      now: () => FIXED_NOW,
    });
    const staleStatus = {
      enabled: true,
      status: "warning" as const,
      backupDir: "/tmp/backups",
      maxAgeHours: 36,
      latestBackup: null,
      lastFailure: null,
      warnings: [
        { code: "database_backup_stale" as const, message: "Latest database backup is 240h old, exceeding 36h." },
      ],
    };
    await reporter.reportHealthWarnings(staleStatus);
    await reporter.reportHealthWarnings(staleStatus);
    expect(records).toHaveLength(1);
    // No comment storm: the ensure-exists path must not append per-tick comments.
    expect(records[0]!.comments).toEqual([]);
  });

  it("reportHealthWarnings is a no-op for an ok status", async () => {
    const { board, records } = createFakeBoard();
    const reporter = createDatabaseBackupAlertReporter({
      markerFile,
      clearMarkerFiles: [markerFile],
      board,
      companyId: "c1",
      now: () => FIXED_NOW,
    });
    await reporter.reportHealthWarnings({
      enabled: true,
      status: "ok",
      backupDir: "/tmp/backups",
      maxAgeHours: 36,
      latestBackup: null,
      lastFailure: null,
      warnings: [],
    });
    expect(records).toHaveLength(0);
  });
});
