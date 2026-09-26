import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DatabaseBackupHealthStatus,
  DatabaseBackupHealthWarning,
} from "./database-backup-health.js";

/**
 * Adapter/bridge that turns a control-plane database-backup failure (or a
 * `warning` health status) into a LOUD, idempotent board signal — the missing
 * link behind SIN-70819 (backup died silently for 9 days).
 *
 * This module is deliberately dependency-light: it depends only on the board
 * PORT (`DatabaseBackupAlertBoard`) and the filesystem for the failure marker.
 * The domain inspector (`inspectDatabaseBackupHealth`) stays pure and is NOT
 * imported here beyond its result types — the wiring in `index.ts` runs the
 * inspector and hands its result to `reportHealthWarnings`.
 */

/** Origin kind stamped on auto-created alert issues so they can be de-duped. */
export const DATABASE_BACKUP_ALERT_ORIGIN_KIND = "database_backup_failure";
/** Stable fingerprint used to find/update the single open alert issue. */
export const DATABASE_BACKUP_ALERT_FINGERPRINT = "control-plane-backup-failure";

/** A board issue reference the bridge can act on. */
export type DatabaseBackupAlertIssueRef = {
  id: string;
  identifier: string | null;
  status: string;
};

/**
 * Port the bridge needs from the board. The concrete adapter over the issues
 * service lives in `database-backup-alert-board.ts`.
 */
export type DatabaseBackupAlertBoard = {
  /** Newest-first: the single open (non-terminal, visible) alert issue, if any. */
  findOpenAlert(
    companyId: string,
    fingerprint: string,
  ): Promise<DatabaseBackupAlertIssueRef | null>;
  /**
   * Create the alert issue. The create MUST be status-aware: it may only
   * deduplicate against a NON-terminal issue (the create-race guard). It must
   * NOT be shadowed by a resolved (`done`/`cancelled`) issue — otherwise a
   * second incident after a resolution would silently report `created` while no
   * open alert exists on the board (the SIN-70819 A09 gap). The concrete adapter
   * satisfies this with `allowDuplicate: false` (advisory-lock + non-terminal
   * recent-open-title dedup), NOT with a static idempotency key.
   */
  createAlert(
    companyId: string,
    input: {
      title: string;
      description: string;
      fingerprint: string;
    },
  ): Promise<DatabaseBackupAlertIssueRef>;
  commentAlert(issueId: string, body: string): Promise<void>;
  resolveAlert(issueId: string, body: string): Promise<void>;
};

export type DatabaseBackupAlertLogger = {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
};

const POSTGRES_URL_PATTERN = /postgres(?:ql)?:\/\/[^\s"'`]+/gi;

/**
 * Strip anything that looks like a Postgres connection URL (which can embed
 * credentials) before the message reaches a marker file or a board issue.
 * OWASP A09: never persist secrets in the alert signal.
 */
export function redactDatabaseBackupErrorMessage(message: string): string {
  return message.replace(POSTGRES_URL_PATTERN, "postgres://[redacted]").trim();
}

/** First non-empty line of the (already redacted) message, for the marker. */
function firstLine(message: string): string {
  const line = message
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line || "Database backup failed.";
}

/**
 * Write the `db-backup-to-s3.failure` marker that `inspectDatabaseBackupHealth`
 * reads. First line is the exact (redacted) error; a second line carries the
 * timestamp. This is channel 1 of the defense-in-depth signal and must succeed
 * independently of the board push.
 */
export function writeDatabaseBackupFailureMarker(
  markerFile: string,
  message: string,
  at: Date,
): void {
  mkdirSync(dirname(markerFile), { recursive: true });
  const redacted = redactDatabaseBackupErrorMessage(message);
  writeFileSync(markerFile, `${firstLine(redacted)}\nfailedAt=${at.toISOString()}\n`, "utf8");
}

/** Best-effort removal of every candidate marker path (clear on success). */
export function clearDatabaseBackupFailureMarkers(markerFiles: string[]): void {
  for (const markerFile of markerFiles) {
    if (!existsSync(markerFile)) continue;
    try {
      unlinkSync(markerFile);
    } catch {
      // Best-effort: a stale marker we cannot remove must not fail the backup.
    }
  }
}

/** Summarize warnings into a single human line (used for the stale/missing path). */
export function summarizeDatabaseBackupWarnings(
  warnings: DatabaseBackupHealthWarning[],
): string {
  if (warnings.length === 0) return "Database backup health check reported a warning.";
  return warnings.map((warning) => warning.message).join(" ");
}

/** Pure payload builder: warning/failure context → issue title + description. */
export function buildDatabaseBackupAlertContent(input: {
  reason: "failure" | "health";
  message: string;
  warnings?: DatabaseBackupHealthWarning[];
  at: Date;
}): { title: string; description: string } {
  const redacted = redactDatabaseBackupErrorMessage(input.message);
  const title =
    input.reason === "failure"
      ? "Control-plane database backup is failing"
      : "Control-plane database backup is unhealthy";
  const lines: string[] = [
    input.reason === "failure"
      ? "The automatic control-plane database backup failed."
      : "The control-plane database backup health check is reporting a warning.",
    "",
    `First observed: ${input.at.toISOString()}`,
    "",
    "```",
    redacted || "(no error message captured)",
    "```",
  ];
  if (input.warnings && input.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of input.warnings) {
      lines.push(`- \`${warning.code}\`: ${redactDatabaseBackupErrorMessage(warning.message)}`);
    }
  }
  lines.push(
    "",
    "This issue is auto-managed (deduplicated by origin fingerprint " +
      `\`${DATABASE_BACKUP_ALERT_FINGERPRINT}\`). It updates in place while the ` +
      "backup keeps failing and is resolved automatically on the next successful backup.",
  );
  return { title, description: lines.join("\n") };
}

/**
 * Idempotent board push: update the open alert issue if one exists, otherwise
 * create it. Never spawns a duplicate (alert-storm guard). When `updateComment`
 * is omitted, an existing open issue is left untouched (used by the periodic
 * staleness bridge so it doesn't comment every tick).
 */
export async function raiseDatabaseBackupAlert(
  board: DatabaseBackupAlertBoard,
  input: {
    companyId: string;
    fingerprint: string;
    title: string;
    description: string;
    updateComment?: string;
  },
): Promise<{ action: "created" | "updated" | "exists"; issueId: string }> {
  const open = await board.findOpenAlert(input.companyId, input.fingerprint);
  if (open) {
    if (input.updateComment) {
      await board.commentAlert(open.id, input.updateComment);
      return { action: "updated", issueId: open.id };
    }
    return { action: "exists", issueId: open.id };
  }
  // `findOpenAlert` above (origin fingerprint, non-terminal) is the primary,
  // status-aware dedup. The create itself is guarded status-awarely by the
  // concrete adapter (`allowDuplicate: false`) so a resolved alert can never
  // shadow a fresh incident. Deliberately NO static idempotency key here: a
  // retained key survives the alert being resolved to `done` and would make a
  // second incident dedup-hit the old closed issue (SIN-70819 A09 regression).
  const created = await board.createAlert(input.companyId, {
    title: input.title,
    description: input.description,
    fingerprint: input.fingerprint,
  });
  return { action: "created", issueId: created.id };
}

/** Resolve the open alert (on a successful backup). No-op when none is open. */
export async function resolveDatabaseBackupAlert(
  board: DatabaseBackupAlertBoard,
  input: { companyId: string; fingerprint: string; comment: string },
): Promise<{ action: "resolved" | "noop"; issueId?: string }> {
  const open = await board.findOpenAlert(input.companyId, input.fingerprint);
  if (!open) return { action: "noop" };
  await board.resolveAlert(open.id, input.comment);
  return { action: "resolved", issueId: open.id };
}

export type DatabaseBackupAlertReporterDeps = {
  /** Marker path to write on failure (the primary alert file). */
  markerFile: string;
  /** All candidate marker paths to clear on success. */
  clearMarkerFiles: string[];
  /** Board port + target company. Null disables the board channel (marker/log only). */
  board: DatabaseBackupAlertBoard | null;
  companyId: string | null;
  fingerprint?: string;
  now?: () => Date;
  logger?: DatabaseBackupAlertLogger;
};

/**
 * Composes the three defense-in-depth channels (marker file, structured log,
 * board issue). The marker + log always run; a board-channel failure is caught
 * and logged so it can never mask the underlying backup failure.
 */
export function createDatabaseBackupAlertReporter(deps: DatabaseBackupAlertReporterDeps) {
  const fingerprint = deps.fingerprint ?? DATABASE_BACKUP_ALERT_FINGERPRINT;
  const now = deps.now ?? (() => new Date());

  return {
    /** AC1: a single scheduled-backup failure → marker + board issue. */
    async reportFailure(rawMessage: string): Promise<void> {
      const at = now();
      const message = redactDatabaseBackupErrorMessage(rawMessage);

      // Channel 1: marker (must persist even if the board push fails).
      try {
        writeDatabaseBackupFailureMarker(deps.markerFile, message, at);
      } catch (err) {
        deps.logger?.error({ err }, "failed to write database backup failure marker");
      }

      // Channel 3: board issue (idempotent, guarded).
      if (!deps.board || !deps.companyId) return;
      try {
        const { title, description } = buildDatabaseBackupAlertContent({
          reason: "failure",
          message,
          at,
        });
        const result = await raiseDatabaseBackupAlert(deps.board, {
          companyId: deps.companyId,
          fingerprint,
          title,
          description,
          updateComment: `Automatic control-plane database backup failed again at ${at.toISOString()}.\n\n\`\`\`\n${message || "(no error message captured)"}\n\`\`\``,
        });
        deps.logger?.warn(
          { action: result.action, issueId: result.issueId },
          "raised control-plane database backup failure board alert",
        );
      } catch (err) {
        deps.logger?.error({ err }, "failed to raise database backup failure board alert");
      }
    },

    /** AC3: periodic staleness/health bridge → ensure the board alert exists. */
    async reportHealthWarnings(status: DatabaseBackupHealthStatus): Promise<void> {
      if (status.status !== "warning") return;
      if (!deps.board || !deps.companyId) return;
      const at = now();
      try {
        const { title, description } = buildDatabaseBackupAlertContent({
          reason: "health",
          message: summarizeDatabaseBackupWarnings(status.warnings),
          warnings: status.warnings,
          at,
        });
        // No updateComment: only ensure the issue exists so the hourly bridge
        // never storms an already-open alert with comments.
        const result = await raiseDatabaseBackupAlert(deps.board, {
          companyId: deps.companyId,
          fingerprint,
          title,
          description,
        });
        deps.logger?.warn(
          { action: result.action, issueId: result.issueId, warnings: status.warnings.map((w) => w.code) },
          "control-plane database backup health warning bridged to board",
        );
      } catch (err) {
        deps.logger?.error({ err }, "failed to bridge database backup health warning to board");
      }
    },

    /** On a successful backup: clear the marker(s) and resolve the open alert. */
    async reportSuccess(): Promise<void> {
      try {
        clearDatabaseBackupFailureMarkers(deps.clearMarkerFiles);
      } catch (err) {
        deps.logger?.error({ err }, "failed to clear database backup failure marker");
      }

      if (!deps.board || !deps.companyId) return;
      try {
        const at = now();
        const result = await resolveDatabaseBackupAlert(deps.board, {
          companyId: deps.companyId,
          fingerprint,
          comment: `Automatic control-plane database backup succeeded at ${at.toISOString()}; resolving this alert.`,
        });
        if (result.action === "resolved") {
          deps.logger?.info(
            { issueId: result.issueId },
            "resolved control-plane database backup board alert after a successful backup",
          );
        }
      } catch (err) {
        deps.logger?.error({ err }, "failed to resolve database backup board alert");
      }
    },
  };
}

export type DatabaseBackupAlertReporter = ReturnType<typeof createDatabaseBackupAlertReporter>;
