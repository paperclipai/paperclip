import { and, eq, sql } from "drizzle-orm";
import {
  IssueVersionConflictError,
  pluginDatabaseNamespaces,
  type Db,
  type DbTransaction,
} from "@paperclipai/db";
import type {
  PluginConditionalIssueUpdateResult,
  PluginIssueUpdatePatch,
  PluginNamespaceFence,
  PluginNamespaceFenceScalar,
  WorkerHostCallContext,
  WorkerToHostMethods,
} from "@paperclipai/plugin-sdk";
import { logActivity } from "./activity-log.js";
import { requireVersionedIssue } from "./issue-versioning.js";
import { issueService } from "./issues.js";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;
const MAX_FENCE_COLUMNS = 16;

const ISSUE_PATCH_KEYS = new Set<keyof PluginIssueUpdatePatch>([
  "title",
  "description",
  "status",
  "priority",
  "assigneeAgentId",
  "assigneeUserId",
  "billingCode",
  "originKind",
  "originId",
  "originRunId",
  "requestDepth",
  "executionWorkspaceId",
  "executionWorkspacePreference",
  "blockedByIssueIds",
  "labelIds",
  "executionWorkspaceSettings",
]);

type ConditionalUpdateParams = WorkerToHostMethods["issues.updateConditional"][0];

function assertIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !IDENTIFIER_RE.test(value)
    || value.length > MAX_POSTGRES_IDENTIFIER_LENGTH
  ) {
    throw new Error(`Invalid namespace fence ${label}`);
  }
  return value;
}

function quotedIdentifier(value: string, label: string): string {
  return `"${assertIdentifier(value, label)}"`;
}

function assertFenceScalar(
  value: unknown,
  label: string,
): asserts value is PluginNamespaceFenceScalar {
  if (
    value !== null
    && typeof value !== "string"
    && typeof value !== "boolean"
    && !(typeof value === "number" && Number.isFinite(value))
  ) {
    throw new Error(`Invalid namespace fence value for ${label}`);
  }
}

function validateFenceRecord(
  record: Record<string, PluginNamespaceFenceScalar>,
  label: "lane" | "expected",
): Array<[string, PluginNamespaceFenceScalar]> {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Namespace fence ${label} must be an object`);
  }
  const entries = Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0 || entries.length > MAX_FENCE_COLUMNS) {
    throw new Error(`Namespace fence ${label} must contain 1-${MAX_FENCE_COLUMNS} columns`);
  }
  for (const [column, value] of entries) {
    assertIdentifier(column, `${label} column`);
    assertFenceScalar(value, `${label}.${column}`);
  }
  return entries;
}

function validateNamespaceFence(namespaceFence: PluginNamespaceFence) {
  if (!namespaceFence || typeof namespaceFence !== "object") {
    throw new Error("namespaceFence is required");
  }
  return {
    table: assertIdentifier(namespaceFence.table, "table"),
    lane: validateFenceRecord(namespaceFence.lane, "lane"),
    expected: validateFenceRecord(namespaceFence.expected, "expected"),
  };
}

function validateIssuePatch(patch: PluginIssueUpdatePatch): PluginIssueUpdatePatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Conditional issue patch must be an object");
  }
  for (const key of Object.keys(patch)) {
    if (!ISSUE_PATCH_KEYS.has(key as keyof PluginIssueUpdatePatch)) {
      throw new Error(`Conditional issue patch contains forbidden field: ${key}`);
    }
  }
  return { ...patch };
}

function comparisonSql(entries: Array<[string, PluginNamespaceFenceScalar]>) {
  return sql.join(
    entries.map(([column, value]) =>
      sql`${sql.raw(quotedIdentifier(column, "column"))} IS NOT DISTINCT FROM ${value}`),
    sql` AND `,
  );
}

async function lockAndCompareFence(
  tx: DbTransaction,
  pluginId: string,
  namespaceFence: PluginNamespaceFence,
): Promise<"match" | "mismatch" | "not_found"> {
  const fence = validateNamespaceFence(namespaceFence);
  const namespace = await tx
    .select({ name: pluginDatabaseNamespaces.namespaceName })
    .from(pluginDatabaseNamespaces)
    .where(and(
      eq(pluginDatabaseNamespaces.pluginId, pluginId),
      eq(pluginDatabaseNamespaces.status, "active"),
    ))
    .for("share")
    .then((rows) => rows[0]?.name ?? null);
  if (!namespace) {
    throw new Error("Plugin has no active database namespace");
  }

  const tableExists = Array.from(await tx.execute(sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = ${namespace}
        AND table_name = ${fence.table}
        AND table_type = 'BASE TABLE'
    ) AS "exists"
  `))[0]?.exists === true;
  if (!tableExists) {
    throw new Error("Namespace fence table does not belong to the calling plugin");
  }

  const rows = Array.from(await tx.execute(sql<{ fenceMatches: boolean }>`
    SELECT (${comparisonSql(fence.expected)}) AS "fenceMatches"
    FROM ${sql.raw(quotedIdentifier(namespace, "namespace"))}.${sql.raw(
      quotedIdentifier(fence.table, "table"),
    )}
    WHERE ${comparisonSql(fence.lane)}
    FOR UPDATE
  `));
  if (!rows[0]) return "not_found";
  if (rows.length !== 1) {
    throw new Error("Namespace fence lane must identify exactly one row");
  }
  return rows[0].fenceMatches ? "match" : "mismatch";
}

function activityDetails(
  pluginKey: string,
  params: ConditionalUpdateParams,
  context?: WorkerHostCallContext,
) {
  const scope = context?.invocationScope;
  return {
    sourcePluginKey: pluginKey,
    expectedVersion: params.expectedVersion,
    namespaceFence: {
      table: params.namespaceFence.table,
      laneColumns: Object.keys(params.namespaceFence.lane).sort(),
      expectedColumns: Object.keys(params.namespaceFence.expected).sort(),
    },
    patchKeys: Object.keys(params.patch).sort(),
    initiatingActorType: scope?.actorType ?? null,
    initiatingActorId: scope?.actorAgentId ?? scope?.actorUserId ?? null,
    initiatingRunId: scope?.actorRunId ?? null,
  };
}

export function pluginConditionalIssueUpdateService(
  db: Db,
  pluginId: string,
  pluginKey: string,
) {
  const issues = issueService(db);

  return {
    async update(
      params: ConditionalUpdateParams,
      context?: WorkerHostCallContext,
    ): Promise<PluginConditionalIssueUpdateResult> {
      if (!Number.isSafeInteger(params.expectedVersion) || params.expectedVersion < 0) {
        throw new Error("expectedVersion must be a non-negative safe integer");
      }
      const patch = validateIssuePatch(params.patch);

      return await db.transaction(async (tx) => {
        const fenceResult = await lockAndCompareFence(
          tx,
          pluginId,
          params.namespaceFence,
        );
        if (fenceResult === "not_found") {
          return { applied: false, reason: "not_found" };
        }
        if (fenceResult === "mismatch") {
          return { applied: false, reason: "fence_mismatch" };
        }

        let updated;
        try {
          updated = await issues.update(params.issueId, {
            ...patch,
            expectedVersion: params.expectedVersion,
            expectedCompanyId: params.companyId,
            actorAgentId: context?.invocationScope?.actorAgentId ?? null,
            actorUserId: context?.invocationScope?.actorUserId ?? null,
          }, tx);
        } catch (error) {
          if (error instanceof IssueVersionConflictError) {
            return { applied: false, reason: "issue_version_mismatch" };
          }
          throw error;
        }
        if (!updated) return { applied: false, reason: "not_found" };

        await logActivity(tx as unknown as Db, {
          companyId: params.companyId,
          actorType: "plugin",
          actorId: pluginId,
          agentId: context?.invocationScope?.actorAgentId ?? null,
          runId: context?.invocationScope?.actorRunId ?? null,
          action: "issue.conditional_updated",
          entityType: "issue",
          entityId: updated.id,
          details: activityDetails(pluginKey, params, context),
        });
        return {
          applied: true,
          issue: requireVersionedIssue(updated),
        };
      });
    },
  };
}
