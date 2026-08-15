import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  COMPANY_WORK_PROJECTION_API_VERSION,
  COMPANY_WORK_PROJECTION_DEFAULT_PAGE_SIZE,
  COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE,
  COMPANY_WORK_PROJECTION_SCHEMA_VERSION,
  companyWorkProjectionItemFieldsSchema,
  companyWorkProjectionItemSchema,
  companyWorkProjectionResponseSchema,
  type CompanyWorkProjectionItem,
  type CompanyWorkProjectionResponse,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import {
  assertCompanyWorkProjectionCursorSigningReady,
  decodeCompanyWorkProjectionCursor,
  encodeCompanyWorkProjectionCursor,
} from "./company-work-projection-cursor.js";

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_ISSUED_AT_BUCKET_MS = 60 * 1000;

type ProjectionRow = {
  head_issue_id: string;
  head_first_revision: string | number | bigint;
  issue_id: string;
  revision: string | number | bigint;
  identifier: string | null;
  project_id: string | null;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  status: string | null;
  priority: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  project_reference_valid: boolean;
  assignee_agent_reference_valid: boolean;
  assignee_user_reference_valid: boolean;
  deleted: boolean;
};

type SnapshotInput = {
  companyId: string;
  credentialId: string;
  cursor?: string;
  pageSize?: number;
  now?: Date;
  cursorSecretForTest?: string;
  cursorPreviousSecretForTest?: string;
};

const MAX_SHARED_CONCURRENT_READS_PER_CREDENTIAL = 4;

function projectionError(status: number, message: string, code: string): never {
  throw new HttpError(status, message, { code });
}

function decimal(value: unknown): string {
  const normalized = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    projectionError(409, "Work projection revision is incompatible", "WORK_PROJECTION_INCOMPATIBLE");
  }
  return normalized;
}

function instant(value: Date | string | null, field: string): string {
  if (value === null) {
    projectionError(409, `Work projection ${field} is missing`, "WORK_PROJECTION_INCOMPATIBLE");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    projectionError(409, `Work projection ${field} is malformed`, "WORK_PROJECTION_INCOMPATIBLE");
  }
  return date.toISOString();
}

function nullableInstant(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    projectionError(409, "Work projection timestamp is malformed", "WORK_PROJECTION_INCOMPATIBLE");
  }
  return date.toISOString();
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Canonical JSON rejects lone Unicode surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Canonical JSON rejects lone Unicode surrogates");
    }
  }
}

function canonicalString(value: string): string {
  assertWellFormedUnicode(value);
  return JSON.stringify(value);
}

/** RFC 8785 JSON Canonicalization Scheme for JSON-domain values. */
export function canonicalCompanyWorkProjectionJson(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCompanyWorkProjectionJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON supports only plain JSON objects");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${canonicalString(key)}:${canonicalCompanyWorkProjectionJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON supports only JSON values");
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalCompanyWorkProjectionJson(value), "utf8").digest("hex");
}

function toItem(row: ProjectionRow): CompanyWorkProjectionItem {
  if (
    !row.project_reference_valid
    || !row.assignee_agent_reference_valid
    || !row.assignee_user_reference_valid
  ) {
    projectionError(409, "Work projection contains a cross-company reference", "WORK_PROJECTION_INCOMPATIBLE");
  }
  if (row.assignee_agent_id && row.assignee_user_id) {
    projectionError(409, "Work projection contains an ambiguous owner", "WORK_PROJECTION_INCOMPATIBLE");
  }
  const safeFields = {
    id: row.issue_id,
    identifier: row.identifier,
    owner: row.assignee_agent_id
      ? { type: "agent" as const, id: row.assignee_agent_id }
      : row.assignee_user_id
        ? { type: "user" as const, id: row.assignee_user_id }
        : { type: "unassigned" as const },
    projectId: row.project_id,
    priority: row.priority,
    planningState: row.status,
    timestamps: {
      createdAt: instant(row.created_at, "createdAt"),
      updatedAt: instant(row.updated_at, "updatedAt"),
      startedAt: nullableInstant(row.started_at),
      completedAt: nullableInstant(row.completed_at),
      cancelledAt: nullableInstant(row.cancelled_at),
    },
    revision: decimal(row.revision),
  };
  const parsedFields = companyWorkProjectionItemFieldsSchema.safeParse(safeFields);
  if (!parsedFields.success) {
    projectionError(409, "Work projection contains incompatible source data", "WORK_PROJECTION_INCOMPATIBLE");
  }
  const candidate = {
    ...parsedFields.data,
    evidence: { algorithm: "sha256" as const, digest: canonicalDigest(parsedFields.data) },
  };
  const parsed = companyWorkProjectionItemSchema.safeParse(candidate);
  if (!parsed.success) {
    projectionError(409, "Work projection contains incompatible source data", "WORK_PROJECTION_INCOMPATIBLE");
  }
  return parsed.data;
}

function bucketedNow(now: Date): Date {
  return new Date(Math.floor(now.getTime() / SNAPSHOT_ISSUED_AT_BUCKET_MS) * SNAPSHOT_ISSUED_AT_BUCKET_MS);
}

export function companyWorkProjectionService(db: Db) {
  return {
    readSnapshot: async (input: SnapshotInput): Promise<CompanyWorkProjectionResponse> => {
      const now = input.now ?? new Date();
      // Signing readiness is part of endpoint readiness even when an empty or
      // one-page response would not otherwise need to emit a cursor.
      assertCompanyWorkProjectionCursorSigningReady(input.companyId, input.cursorSecretForTest);
      const decoded = input.cursor
        ? decodeCompanyWorkProjectionCursor(
            input.cursor,
            input.companyId,
            now,
            input.cursorSecretForTest,
            input.cursorPreviousSecretForTest,
          )
        : null;
      if (decoded && input.pageSize !== undefined && input.pageSize !== decoded.pageSize) {
        projectionError(400, "Cursor page size cannot be changed", "WORK_PROJECTION_MALFORMED");
      }
      const pageSize = decoded?.pageSize
        ?? input.pageSize
        ?? COMPANY_WORK_PROJECTION_DEFAULT_PAGE_SIZE;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE) {
        projectionError(400, "Invalid work projection page size", "WORK_PROJECTION_MALFORMED");
      }

      return db.transaction(async (tx) => {
        // PostgreSQL enforces the endpoint's no-write property in addition to
        // the application tests that compare every projection-adjacent table.
        await tx.execute(sql.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"));

        let admitted = false;
        for (let slot = 0; slot < MAX_SHARED_CONCURRENT_READS_PER_CREDENTIAL; slot += 1) {
          const admissionRows = Array.from(await tx.execute(sql<{ acquired: boolean }>`
            SELECT pg_try_advisory_xact_lock(
              hashtextextended(
                ${`company-work-projection-admission:v1:${input.credentialId}:${slot}`},
                0
              )
            ) AS acquired
          `));
          if (admissionRows[0]?.acquired) {
            admitted = true;
            break;
          }
        }
        if (!admitted) {
          projectionError(429, "Work projection read is rate limited", "WORK_PROJECTION_RATE_LIMITED");
        }

        const revisionRows = Array.from(await tx.execute(sql<{
          current_revision: string | number | bigint;
          current_integrity_token: string;
          witness_revision: string | number | bigint;
          witness_integrity_token: string;
          database_epoch: string;
          verified_database_epoch: string;
          verified_revision: string | number | bigint;
          verified_integrity_token: string;
          verified_history_count: string | number | bigint;
          verified_event_count: string | number | bigint;
          history_integrity_token: string | null;
          source_event_integrity_token: string | null;
        }>`
          SELECT
            revisions.current_revision,
            revisions.current_integrity_token,
            witnesses.current_revision AS witness_revision,
            witnesses.current_integrity_token AS witness_integrity_token,
            witnesses.database_epoch,
            verification.database_epoch AS verified_database_epoch,
            verification.verified_revision,
            verification.verified_integrity_token,
            verification.verified_history_count,
            verification.verified_event_count,
            history.integrity_token AS history_integrity_token,
            source_event.integrity_token AS source_event_integrity_token
          FROM public.company_work_projection_revisions AS revisions
          JOIN public.company_work_projection_source_witnesses AS witnesses
            ON witnesses.company_id = revisions.company_id
          JOIN public.company_work_projection_verifications AS verification
            ON verification.company_id = revisions.company_id
          LEFT JOIN public.issue_work_projection_versions AS history
            ON history.company_id = revisions.company_id
            AND history.revision = revisions.current_revision
          LEFT JOIN public.company_work_projection_source_events AS source_event
            ON source_event.company_id = revisions.company_id
            AND source_event.revision = revisions.current_revision
          WHERE revisions.company_id = ${input.companyId}::uuid
        `));
        if (!revisionRows[0]) {
          projectionError(409, "Work projection integrity state is missing", "WORK_PROJECTION_INCOMPATIBLE");
        }
        const integrity = revisionRows[0];
        const currentRevision = decimal(integrity.current_revision);
        const witnessRevision = decimal(integrity.witness_revision);
        const expectedEmpty = currentRevision === "0";
        if (
          witnessRevision !== currentRevision
          || integrity.witness_integrity_token !== integrity.current_integrity_token
          || integrity.verified_database_epoch !== integrity.database_epoch
          || decimal(integrity.verified_revision) !== currentRevision
          || integrity.verified_integrity_token !== integrity.current_integrity_token
          || decimal(integrity.verified_history_count) !== currentRevision
          || decimal(integrity.verified_event_count) !== currentRevision
          || (!expectedEmpty && (
            integrity.history_integrity_token !== integrity.current_integrity_token
            || integrity.source_event_integrity_token !== integrity.current_integrity_token
          ))
          || (expectedEmpty && (
            integrity.history_integrity_token !== null
            || integrity.source_event_integrity_token !== null
          ))
        ) {
          projectionError(409, "Work projection source witness does not match", "WORK_PROJECTION_INCOMPATIBLE");
        }
        const issuedAt = decoded?.issuedAt ?? bucketedNow(now).toISOString();
        const expiresAt = decoded?.expiresAt
          ?? new Date(new Date(issuedAt).getTime() + SNAPSHOT_TTL_MS).toISOString();
        const snapshotRevision = decoded?.snapshotRevision ?? currentRevision;

        if (BigInt(snapshotRevision) > BigInt(currentRevision)) {
          projectionError(410, "Work projection snapshot is stale", "WORK_PROJECTION_SNAPSHOT_STALE");
        }
        if (decoded && BigInt(decoded.afterRevision) > BigInt(snapshotRevision)) {
          projectionError(400, "Malformed work projection cursor position", "WORK_PROJECTION_MALFORMED");
        }
        if (decoded && decoded.afterIssueId === null) {
          projectionError(400, "Malformed work projection cursor position", "WORK_PROJECTION_MALFORMED");
        }

        const afterRevision = decoded?.afterRevision ?? "0";
        const afterIssueId = decoded?.afterIssueId ?? "00000000-0000-0000-0000-000000000000";
        const rows = Array.from(await tx.execute(sql<ProjectionRow>`
          SELECT
            head.issue_id AS head_issue_id,
            head.first_revision AS head_first_revision,
            history.issue_id, history.revision, history.deleted,
            history.identifier, history.project_id,
            history.assignee_agent_id, history.assignee_user_id,
            history.status, history.priority,
            history.started_at, history.completed_at, history.cancelled_at,
            history.created_at, history.updated_at,
            history.project_reference_valid,
            history.assignee_agent_reference_valid,
            history.assignee_user_reference_valid
          FROM public.company_work_projection_issue_heads AS head
          LEFT JOIN LATERAL (
            SELECT
              version.issue_id, version.revision, version.deleted,
              version.identifier, version.project_id,
              version.assignee_agent_id, version.assignee_user_id,
              version.status, version.priority,
              version.started_at, version.completed_at, version.cancelled_at,
              version.created_at, version.updated_at,
              version.project_reference_valid,
              version.assignee_agent_reference_valid,
              version.assignee_user_reference_valid
            FROM public.issue_work_projection_versions AS version
            WHERE version.company_id = head.company_id
              AND version.issue_id = head.issue_id
              AND version.revision <= ${snapshotRevision}::bigint
            ORDER BY version.revision DESC
            LIMIT 1
          ) AS history ON true
          WHERE head.company_id = ${input.companyId}::uuid
            AND head.first_revision <= ${snapshotRevision}::bigint
            AND (head.first_revision, head.issue_id)
              > (${afterRevision}::bigint, ${afterIssueId}::uuid)
          ORDER BY head.first_revision, head.issue_id
          LIMIT ${pageSize + 1}
        `)) as ProjectionRow[];

        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        if (pageRows.some((row) => !row.issue_id || row.issue_id !== row.head_issue_id)) {
          projectionError(409, "Work projection verification receipt is invalid", "WORK_PROJECTION_INCOMPATIBLE");
        }
        const items = pageRows.filter((row) => !row.deleted).map(toItem);
        const lastRow = pageRows.at(-1);
        const nextCursor = hasMore && lastRow
          ? encodeCompanyWorkProjectionCursor({
              apiVersion: COMPANY_WORK_PROJECTION_API_VERSION,
              schemaVersion: COMPANY_WORK_PROJECTION_SCHEMA_VERSION,
              companyId: input.companyId,
              snapshotRevision,
              issuedAt,
              expiresAt,
              afterRevision: decimal(lastRow.head_first_revision),
              afterIssueId: lastRow.head_issue_id,
              pageSize,
            }, input.cursorSecretForTest)
          : null;

        const bodyWithoutEtag = {
          apiVersion: COMPANY_WORK_PROJECTION_API_VERSION,
          schemaVersion: COMPANY_WORK_PROJECTION_SCHEMA_VERSION,
          companyId: input.companyId,
          snapshot: { revision: snapshotRevision, issuedAt, expiresAt },
          items,
          page: {
            size: items.length,
            hasMore,
            nextCursor,
            completeness: hasMore ? "partial" as const : "complete" as const,
          },
        };
        const response = {
          ...bodyWithoutEtag,
          etag: `"${canonicalDigest(bodyWithoutEtag)}"`,
        };
        const parsed = companyWorkProjectionResponseSchema.safeParse(response);
        if (!parsed.success) {
          projectionError(409, "Work projection response is incompatible", "WORK_PROJECTION_INCOMPATIBLE");
        }
        return parsed.data;
      });
    },
  };
}
