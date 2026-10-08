import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { issueService } from "./issues.js";
import {
  DATABASE_BACKUP_ALERT_ORIGIN_KIND,
  type DatabaseBackupAlertBoard,
} from "./database-backup-alerts.js";

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];

/**
 * Concrete adapter implementing the `DatabaseBackupAlertBoard` port over the
 * issues service. Kept thin: the idempotent create-vs-update decision lives in
 * the pure bridge (`database-backup-alerts.ts`); this only translates port calls
 * into storage operations.
 */
export function createDatabaseBackupAlertBoard(
  db: Db,
  opts: { priority?: "critical" | "high" | "medium" | "low"; assigneeAgentId?: string | null } = {},
): DatabaseBackupAlertBoard {
  const svc = issueService(db);
  const priority = opts.priority ?? "high";

  return {
    async findOpenAlert(companyId, fingerprint) {
      return db
        .select({ id: issues.id, identifier: issues.identifier, status: issues.status })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, DATABASE_BACKUP_ALERT_ORIGIN_KIND),
            eq(issues.originFingerprint, fingerprint),
            isNull(issues.hiddenAt),
            notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
          ),
        )
        .orderBy(asc(issues.createdAt), asc(issues.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    async createAlert(companyId, input) {
      // `allowDuplicate: false` — NOT a static idempotencyKey. The idempotency
      // key dedup in `issueService.create` matches on (company, key) regardless
      // of status and retains the key for 7 days, so a key from a resolved
      // (`done`) alert would shadow a genuine second incident and report
      // `created` with no open board issue — the exact OWASP A09 gap SIN-70819
      // closes. `allowDuplicate: false` instead takes an advisory lock and
      // dedups only against a NON-terminal recent-open-title issue, which guards
      // the create-race without shadowing a resolved alert.
      const created = await svc.create(companyId, {
        title: input.title,
        description: input.description,
        status: "todo",
        priority,
        originKind: DATABASE_BACKUP_ALERT_ORIGIN_KIND,
        originId: companyId,
        originFingerprint: input.fingerprint,
        allowDuplicate: false,
        assigneeAgentId: opts.assigneeAgentId ?? undefined,
      });
      return {
        id: created.id,
        identifier: created.identifier ?? null,
        status: created.status,
      };
    },

    async commentAlert(issueId, body) {
      await svc.addComment(issueId, body, { runId: null }, { authorType: "system" });
    },

    async resolveAlert(issueId, body) {
      // Comment first so the resolution trail lands before the issue closes.
      await svc.addComment(issueId, body, { runId: null }, { authorType: "system" });
      await svc.update(issueId, { status: "done" });
    },
  };
}
