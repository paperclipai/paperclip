import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import type { Sql } from "postgres";
import { ensurePostgresDatabase } from "./client.js";
import { formatDatabaseBackupResult, runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";

type SqlExecutor = {
  unsafe: Sql["unsafe"];
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type SubsidiaryDefinition = {
  slug: string;
  companyName: string;
  issuePrefix: string;
  projectNames: string[];
};

export type RecoveryMode = "dry-run" | "apply";

export type RecoveryOptions = {
  connectionString: string;
  companyScope?: string[];
  mode?: RecoveryMode;
  strict?: boolean;
  fromBackup?: string;
  backupDir?: string;
  sampleLimit?: number;
};

type SharedEntityConflict = {
  entityType: "labels" | "approvals" | "documents" | "assets";
  ids: string[];
};

type RootEntitySets = {
  agentIds: string[];
  projectIds: string[];
  projectWorkspaceIds: string[];
  executionWorkspaceIds: string[];
  issueIds: string[];
};

type SharedEntitySets = {
  labelIds: string[];
  approvalIds: string[];
  documentIds: string[];
  assetIds: string[];
};

type RecoveryContext = {
  root: RootEntitySets;
  shared: SharedEntitySets;
  runIds: string[];
  runtimeServiceIds: string[];
  budgetPolicyIds: string[];
  costEventIds: string[];
};

type TableRepairResult = {
  table: string;
  mismatchCount: number;
  sample: string[];
  appliedCount: number;
};

type BackupCountRow = {
  table: string;
  liveCount: number | null;
  backupCount: number | null;
  delta: number | null;
};

export type CompanyRecoveryReport = {
  slug: string;
  companyId: string;
  companyName: string;
  issuePrefix: string;
  rootCounts: Record<string, number>;
  conflicts: SharedEntityConflict[];
  tables: TableRepairResult[];
  backupCounts: BackupCountRow[];
};

export type HoldingMigrationRecoveryReport = {
  mode: RecoveryMode;
  strict: boolean;
  backupReferenceFile: string | null;
  preflightBackupSummary: string | null;
  companies: CompanyRecoveryReport[];
  totals: {
    companies: number;
    mismatches: number;
    applied: number;
    conflicts: number;
  };
};

const HOLDING_COMPANY_ID = "e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820";
const DEFAULT_BACKUP_DIR = path.resolve(process.cwd(), "data", "backups");
const DEFAULT_SAMPLE_LIMIT = 10;

export const SUBSIDIARY_DEFINITIONS: readonly SubsidiaryDefinition[] = [
  { slug: "mersin-steel", companyName: "MersinSteel", issuePrefix: "MST", projectNames: ["MersinSteel MaliPanel", "MersinSteel"] },
  { slug: "navico", companyName: "Navico", issuePrefix: "NAV", projectNames: ["Navico Fleet Management", "Navico"] },
  { slug: "emir", companyName: "Emir", issuePrefix: "EMR", projectNames: ["Emir GTIP", "Emir"] },
  { slug: "ksatlas", companyName: "KsAtlas", issuePrefix: "KSA", projectNames: ["KsAtlas Muhasebe", "KsAtlas"] },
  { slug: "celal-isinlik", companyName: "Celal Isinlik", issuePrefix: "CEL", projectNames: ["Celal Isinlik"] },
  { slug: "hukukbank", companyName: "HukukBank", issuePrefix: "HKB", projectNames: ["HukukBank"] },
  { slug: "ekstrai", companyName: "EkstreAI", issuePrefix: "EKS", projectNames: ["EkstreAI"] },
  { slug: "psikoruya", companyName: "PsikoRuya", issuePrefix: "PSI", projectNames: ["PsikoRuya"] },
  { slug: "transaktas", companyName: "Transaktas", issuePrefix: "TRN", projectNames: ["Transaktas"] },
  { slug: "vito", companyName: "Vito", issuePrefix: "VIT", projectNames: ["Vito"] },
  { slug: "mission-control", companyName: "Mission Control", issuePrefix: "MSC", projectNames: ["Mission Control"] },
  { slug: "vitalix", companyName: "Vitalix", issuePrefix: "VTL", projectNames: ["Vitalix"] },
  { slug: "private-bank", companyName: "Private Bank", issuePrefix: "PRV", projectNames: ["Private Bank"] },
] as const;

const BACKUP_COUNT_TABLES = [
  "projects",
  "project_workspaces",
  "execution_workspaces",
  "issues",
  "agents",
  "issue_comments",
  "issue_documents",
  "issue_attachments",
  "issue_read_states",
  "issue_work_products",
  "issue_approvals",
  "approvals",
  "approval_comments",
  "heartbeat_runs",
  "heartbeat_run_events",
  "agent_runtime_state",
  "agent_task_sessions",
  "agent_wakeup_requests",
  "agent_config_revisions",
  "artifacts",
  "documents",
  "document_revisions",
  "assets",
  "cost_events",
  "finance_events",
  "workspace_runtime_services",
  "workspace_operations",
  "project_goals",
  "labels",
  "budget_policies",
  "budget_incidents",
  "activity_log",
] as const;

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlArray(values: readonly string[]): string {
  if (values.length === 0) return "(NULL)";
  return `(${values.map((value) => quoteLiteral(value)).join(", ")})`;
}

export function selectSubsidiariesForScope(scope: string[] | undefined): readonly SubsidiaryDefinition[] {
  if (!scope || scope.length === 0 || scope.includes("all")) return SUBSIDIARY_DEFINITIONS;
  const wanted = new Set(scope.map((value) => value.trim().toLowerCase()).filter(Boolean));
  return SUBSIDIARY_DEFINITIONS.filter((definition) =>
    wanted.has(definition.issuePrefix.toLowerCase())
    || wanted.has(definition.slug.toLowerCase())
    || wanted.has(definition.companyName.toLowerCase()),
  );
}

function parseArgs(argv: string[]): RecoveryOptions {
  const scope: string[] = [];
  const options: RecoveryOptions = {
    connectionString: process.env.DATABASE_URL ?? "",
    mode: "dry-run",
    strict: false,
    sampleLimit: DEFAULT_SAMPLE_LIMIT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (!arg) continue;
    if (arg === "--apply") {
      options.mode = "apply";
      continue;
    }
    if (arg === "--dry-run") {
      options.mode = "dry-run";
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--database-url" && next) {
      options.connectionString = next;
      index += 1;
      continue;
    }
    if (arg === "--from-backup" && next) {
      options.fromBackup = next;
      index += 1;
      continue;
    }
    if (arg === "--backup-dir" && next) {
      options.backupDir = next;
      index += 1;
      continue;
    }
    if (arg === "--company-scope" && next) {
      scope.push(...next.split(","));
      index += 1;
      continue;
    }
    if (arg === "--sample-limit" && next) {
      options.sampleLimit = Math.max(1, Number.parseInt(next, 10) || DEFAULT_SAMPLE_LIMIT);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }
  }

  if (scope.length > 0) options.companyScope = scope;
  return options;
}

function printHelpAndExit(): never {
  console.log([
    "Usage: tsx packages/db/src/recover-holding-migration.ts [options]",
    "",
    "Options:",
    "  --dry-run                  Preview only (default)",
    "  --apply                    Apply updates in transactions",
    "  --strict                   Abort on ambiguous shared-entity ownership",
    "  --database-url <url>       Override DATABASE_URL",
    "  --from-backup <path>       Compare live counts against a backup snapshot",
    "  --backup-dir <path>        Write a fresh preflight backup before apply",
    "  --company-scope <scope>    all|VTL|NAV|slug,name (comma separated)",
    "  --sample-limit <n>         Number of sample ids per table in report",
  ].join("\n"));
  process.exit(0);
}

function assertConnectionString(connectionString: string): string {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required. Pass --database-url or export DATABASE_URL.");
  }
  return connectionString;
}

async function queryIds(sql: SqlExecutor, query: string): Promise<string[]> {
  const rows = await sql.unsafe<{ id: string }[]>(query);
  return rows.map((row) => row.id);
}

async function queryGroupedLinkedCompanies(
  sql: SqlExecutor,
  query: string,
): Promise<Map<string, Set<string>>> {
  const rows = await sql.unsafe<{ id: string; company_id: string }[]>(query);
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = out.get(row.id) ?? new Set<string>();
    set.add(row.company_id);
    out.set(row.id, set);
  }
  return out;
}

async function listExistingTables(sql: SqlExecutor): Promise<Set<string>> {
  const rows = await sql.unsafe<{ table_name: string }[]>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  return new Set(rows.map((row) => row.table_name));
}

function splitSharedEntityOwnership(
  linkedCompanies: Map<string, Set<string>>,
  targetCompanyId: string,
): { safe: string[]; conflicts: string[] } {
  const safe: string[] = [];
  const conflicts: string[] = [];
  for (const [id, companies] of linkedCompanies) {
    if (companies.size === 1 && companies.has(targetCompanyId)) {
      safe.push(id);
    } else if (companies.size > 0) {
      conflicts.push(id);
    }
  }
  return { safe, conflicts };
}

async function resolveCompanyId(sql: SqlExecutor, definition: SubsidiaryDefinition, strict: boolean): Promise<string | null> {
  const rows = await sql.unsafe<{ id: string }[]>(
    `
      SELECT id
      FROM companies
      WHERE parent_company_id = ${quoteLiteral(HOLDING_COMPANY_ID)}
        AND (
          issue_prefix = ${quoteLiteral(definition.issuePrefix)}
          OR lower(name) = lower(${quoteLiteral(definition.companyName)})
        )
      ORDER BY created_at ASC
      LIMIT 2
    `,
  );
  if (rows.length === 0) {
    if (strict) {
      throw new Error(`Missing subsidiary company for ${definition.issuePrefix}/${definition.slug}`);
    }
    return null;
  }
  if (rows.length > 1 && strict) {
    throw new Error(`Multiple subsidiary company matches for ${definition.issuePrefix}/${definition.slug}`);
  }
  return rows[0]?.id ?? null;
}

async function collectRootEntitySets(
  sql: SqlExecutor,
  definition: SubsidiaryDefinition,
): Promise<RootEntitySets> {
  const agentIds = await queryIds(
    sql,
    `
      SELECT id
      FROM agents
      WHERE metadata->>'project' = ${quoteLiteral(definition.slug)}
    `,
  );

  const projectIds = await queryIds(
    sql,
    `
      SELECT DISTINCT p.id
      FROM projects p
      LEFT JOIN agents lead ON lead.id = p.lead_agent_id
      WHERE (
        lead.metadata->>'project' = ${quoteLiteral(definition.slug)}
        OR lower(p.name) IN ${sqlArray(definition.projectNames.map((name) => name.toLowerCase()))}
      )
    `,
  );

  const projectWorkspaceIds = projectIds.length === 0
    ? []
    : await queryIds(
      sql,
      `
        SELECT id
        FROM project_workspaces
        WHERE project_id IN ${sqlArray(projectIds)}
      `,
    );

  const executionWorkspaceIds = (projectIds.length === 0 && projectWorkspaceIds.length === 0)
    ? []
    : await queryIds(
      sql,
      `
        SELECT DISTINCT id
        FROM execution_workspaces
        WHERE ${
          [
            projectIds.length > 0 ? `project_id IN ${sqlArray(projectIds)}` : null,
            projectWorkspaceIds.length > 0 ? `project_workspace_id IN ${sqlArray(projectWorkspaceIds)}` : null,
          ].filter(Boolean).join(" OR ") || "false"
        }
      `,
    );

  const issuePredicates = [
    projectIds.length > 0 ? `project_id IN ${sqlArray(projectIds)}` : null,
    projectWorkspaceIds.length > 0 ? `project_workspace_id IN ${sqlArray(projectWorkspaceIds)}` : null,
    executionWorkspaceIds.length > 0 ? `execution_workspace_id IN ${sqlArray(executionWorkspaceIds)}` : null,
    agentIds.length > 0 ? `assignee_agent_id IN ${sqlArray(agentIds)}` : null,
    agentIds.length > 0 ? `created_by_agent_id IN ${sqlArray(agentIds)}` : null,
  ].filter(Boolean);

  const issueIds = issuePredicates.length === 0
    ? []
    : await queryIds(
      sql,
      `
        SELECT DISTINCT id
        FROM issues
        WHERE ${issuePredicates.join(" OR ")}
      `,
    );

  return {
    agentIds,
    projectIds,
    projectWorkspaceIds,
    executionWorkspaceIds,
    issueIds,
  };
}

async function collectSharedEntitySets(
  sql: SqlExecutor,
  targetCompanyId: string,
  root: RootEntitySets,
): Promise<{ shared: SharedEntitySets; conflicts: SharedEntityConflict[] }> {
  const conflicts: SharedEntityConflict[] = [];

  const labelIds = root.issueIds.length === 0
    ? []
    : await queryIds(
      sql,
      `SELECT DISTINCT label_id AS id FROM issue_labels WHERE issue_id IN ${sqlArray(root.issueIds)}`,
    );
  const labelOwnership = labelIds.length === 0
    ? new Map<string, Set<string>>()
    : await queryGroupedLinkedCompanies(
      sql,
      `
        SELECT il.label_id AS id, i.company_id
        FROM issue_labels il
        INNER JOIN issues i ON i.id = il.issue_id
        WHERE il.label_id IN ${sqlArray(labelIds)}
      `,
    );
  const labelSplit = splitSharedEntityOwnership(labelOwnership, targetCompanyId);
  if (labelSplit.conflicts.length > 0) conflicts.push({ entityType: "labels", ids: labelSplit.conflicts });

  const approvalIds = root.issueIds.length === 0
    ? []
    : await queryIds(
      sql,
      `SELECT DISTINCT approval_id AS id FROM issue_approvals WHERE issue_id IN ${sqlArray(root.issueIds)}`,
    );
  const approvalOwnership = approvalIds.length === 0
    ? new Map<string, Set<string>>()
    : await queryGroupedLinkedCompanies(
      sql,
      `
        SELECT ia.approval_id AS id, i.company_id
        FROM issue_approvals ia
        INNER JOIN issues i ON i.id = ia.issue_id
        WHERE ia.approval_id IN ${sqlArray(approvalIds)}
      `,
    );
  const approvalSplit = splitSharedEntityOwnership(approvalOwnership, targetCompanyId);
  if (approvalSplit.conflicts.length > 0) conflicts.push({ entityType: "approvals", ids: approvalSplit.conflicts });

  const documentIds = root.issueIds.length === 0
    ? []
    : await queryIds(
      sql,
      `SELECT DISTINCT document_id AS id FROM issue_documents WHERE issue_id IN ${sqlArray(root.issueIds)}`,
    );
  const documentOwnership = documentIds.length === 0
    ? new Map<string, Set<string>>()
    : await queryGroupedLinkedCompanies(
      sql,
      `
        SELECT idoc.document_id AS id, i.company_id
        FROM issue_documents idoc
        INNER JOIN issues i ON i.id = idoc.issue_id
        WHERE idoc.document_id IN ${sqlArray(documentIds)}
      `,
    );
  const documentSplit = splitSharedEntityOwnership(documentOwnership, targetCompanyId);
  if (documentSplit.conflicts.length > 0) conflicts.push({ entityType: "documents", ids: documentSplit.conflicts });

  const assetIds = root.issueIds.length === 0
    ? []
    : await queryIds(
      sql,
      `SELECT DISTINCT asset_id AS id FROM issue_attachments WHERE issue_id IN ${sqlArray(root.issueIds)}`,
    );
  const assetOwnership = assetIds.length === 0
    ? new Map<string, Set<string>>()
    : await queryGroupedLinkedCompanies(
      sql,
      `
        SELECT ia.asset_id AS id, i.company_id
        FROM issue_attachments ia
        INNER JOIN issues i ON i.id = ia.issue_id
        WHERE ia.asset_id IN ${sqlArray(assetIds)}
      `,
    );
  const assetSplit = splitSharedEntityOwnership(assetOwnership, targetCompanyId);
  if (assetSplit.conflicts.length > 0) conflicts.push({ entityType: "assets", ids: assetSplit.conflicts });

  return {
    shared: {
      labelIds: labelSplit.safe,
      approvalIds: approvalSplit.safe,
      documentIds: documentSplit.safe,
      assetIds: assetSplit.safe,
    },
    conflicts,
  };
}

async function collectDependentContext(
  sql: SqlExecutor,
  existingTables: ReadonlySet<string>,
  root: RootEntitySets,
  shared: SharedEntitySets,
): Promise<RecoveryContext> {
  const runIds = !existingTables.has("heartbeat_runs") || root.agentIds.length === 0
    ? []
    : await queryIds(
      sql,
      `SELECT id FROM heartbeat_runs WHERE agent_id IN ${sqlArray(root.agentIds)}`,
    );

  const runtimeServicePredicates = [
    root.projectIds.length > 0 ? `project_id IN ${sqlArray(root.projectIds)}` : null,
    root.projectWorkspaceIds.length > 0 ? `project_workspace_id IN ${sqlArray(root.projectWorkspaceIds)}` : null,
    root.executionWorkspaceIds.length > 0 ? `execution_workspace_id IN ${sqlArray(root.executionWorkspaceIds)}` : null,
    root.issueIds.length > 0 ? `issue_id IN ${sqlArray(root.issueIds)}` : null,
    root.agentIds.length > 0 ? `owner_agent_id IN ${sqlArray(root.agentIds)}` : null,
    runIds.length > 0 ? `started_by_run_id IN ${sqlArray(runIds)}` : null,
  ].filter(Boolean);

  const runtimeServiceIds = !existingTables.has("workspace_runtime_services") || runtimeServicePredicates.length === 0
    ? []
    : await queryIds(
      sql,
      `
        SELECT DISTINCT id
        FROM workspace_runtime_services
        WHERE ${runtimeServicePredicates.join(" OR ")}
      `,
    );

  const budgetPolicyPredicates = [
    root.agentIds.length > 0 ? `(scope_type = 'agent' AND scope_id IN ${sqlArray(root.agentIds)})` : null,
    root.projectIds.length > 0 ? `(scope_type = 'project' AND scope_id IN ${sqlArray(root.projectIds)})` : null,
    root.issueIds.length > 0 ? `(scope_type = 'issue' AND scope_id IN ${sqlArray(root.issueIds)})` : null,
  ].filter(Boolean);

  const budgetPolicyIds = !existingTables.has("budget_policies") || budgetPolicyPredicates.length === 0
    ? []
    : await queryIds(
      sql,
      `
        SELECT DISTINCT id
        FROM budget_policies
        WHERE ${budgetPolicyPredicates.join(" OR ")}
      `,
    );

  const costEventPredicates = [
    root.agentIds.length > 0 ? `agent_id IN ${sqlArray(root.agentIds)}` : null,
    root.projectIds.length > 0 ? `project_id IN ${sqlArray(root.projectIds)}` : null,
    root.issueIds.length > 0 ? `issue_id IN ${sqlArray(root.issueIds)}` : null,
    runIds.length > 0 ? `heartbeat_run_id IN ${sqlArray(runIds)}` : null,
  ].filter(Boolean);

  const costEventIds = !existingTables.has("cost_events") || costEventPredicates.length === 0
    ? []
    : await queryIds(
      sql,
      `
        SELECT DISTINCT id
        FROM cost_events
        WHERE ${costEventPredicates.join(" OR ")}
      `,
    );

  return {
    root,
    shared,
    runIds,
    runtimeServiceIds,
    budgetPolicyIds,
    costEventIds,
  };
}

async function countAndSample(
  sql: SqlExecutor,
  table: string,
  sampleExpr: string,
  whereClause: string,
  sampleLimit: number,
): Promise<{ mismatchCount: number; sample: string[] }> {
  const countRows = await sql.unsafe<{ count: string }[]>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${whereClause}`,
  );
  const mismatchCount = Number.parseInt(countRows[0]?.count ?? "0", 10);
  if (mismatchCount === 0) return { mismatchCount, sample: [] };
  const sampleRows = await sql.unsafe<{ sample: string }[]>(
    `SELECT ${sampleExpr} AS sample FROM ${table} WHERE ${whereClause} ORDER BY 1 LIMIT ${sampleLimit}`,
  );
  return { mismatchCount, sample: sampleRows.map((row) => row.sample) };
}

async function applyUpdate(
  sql: SqlExecutor,
  table: string,
  companyId: string,
  whereClause: string,
): Promise<number> {
  const rows = await sql.unsafe<{ count: string }[]>(
    `
      WITH moved AS (
        UPDATE ${table}
        SET company_id = ${quoteLiteral(companyId)}
        WHERE ${whereClause}
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM moved
    `,
  );
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}

async function repairTable(
  sql: SqlExecutor,
  mode: RecoveryMode,
  companyId: string,
  table: string,
  sampleExpr: string,
  whereClause: string,
  sampleLimit: number,
): Promise<TableRepairResult> {
  const { mismatchCount, sample } = await countAndSample(sql, table, sampleExpr, whereClause, sampleLimit);
  const appliedCount = mismatchCount > 0 && mode === "apply"
    ? await applyUpdate(sql, table, companyId, whereClause)
    : 0;
  return { table, mismatchCount, sample, appliedCount };
}

async function collectBackupCounts(
  backupSql: SqlExecutor | null,
  backupTables: ReadonlySet<string> | null,
  liveSql: SqlExecutor,
  liveTables: ReadonlySet<string>,
  companyId: string,
): Promise<BackupCountRow[]> {
  const rows: BackupCountRow[] = [];
  for (const table of BACKUP_COUNT_TABLES) {
    const liveCount = liveTables.has(table)
      ? Number.parseInt((await liveSql.unsafe<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE company_id = ${quoteLiteral(companyId)}`,
      ))[0]?.count ?? "0", 10)
      : null;
    if (!backupSql) {
      rows.push({ table, liveCount, backupCount: null, delta: null });
      continue;
    }
    const backupCount = backupTables?.has(table)
      ? Number.parseInt((await backupSql.unsafe<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE company_id = ${quoteLiteral(companyId)}`,
      ))[0]?.count ?? "0", 10)
      : null;
    rows.push({
      table,
      liveCount,
      backupCount,
      delta: liveCount === null || backupCount === null ? null : liveCount - backupCount,
    });
  }
  return rows;
}

async function recoverSubsidiary(
  sql: SqlExecutor,
  existingTables: ReadonlySet<string>,
  definition: SubsidiaryDefinition,
  mode: RecoveryMode,
  strict: boolean,
  sampleLimit: number,
  backupSql: SqlExecutor | null,
  backupTables: ReadonlySet<string> | null,
): Promise<CompanyRecoveryReport | null> {
  const companyId = await resolveCompanyId(sql, definition, strict);
  if (!companyId) return null;

  const root = await collectRootEntitySets(sql, definition);
  const sharedResult = await collectSharedEntitySets(sql, companyId, root);
  if (strict && sharedResult.conflicts.length > 0) {
    const summary = sharedResult.conflicts
      .map((conflict) => `${conflict.entityType}:${conflict.ids.join(",")}`)
      .join("; ");
    throw new Error(`Strict mode abort for ${definition.issuePrefix}: ${summary}`);
  }

  const context = await collectDependentContext(sql, existingTables, root, sharedResult.shared);
  const tables: TableRepairResult[] = [];

  const rootCounts: Record<string, number> = {
    agents: context.root.agentIds.length,
    projects: context.root.projectIds.length,
    projectWorkspaces: context.root.projectWorkspaceIds.length,
    executionWorkspaces: context.root.executionWorkspaceIds.length,
    issues: context.root.issueIds.length,
    heartbeatRuns: context.runIds.length,
  };

  const companyMismatch = (ids: readonly string[], column = "id") =>
    `${column} IN ${sqlArray(ids)} AND company_id <> ${quoteLiteral(companyId)}`;

  if (context.root.agentIds.length > 0) {
    tables.push(await repairTable(sql, mode, companyId, "agents", "id::text", companyMismatch(context.root.agentIds), sampleLimit));
    if (existingTables.has("agent_runtime_state")) tables.push(await repairTable(sql, mode, companyId, "agent_runtime_state", "agent_id::text", companyMismatch(context.root.agentIds, "agent_id"), sampleLimit));
    if (existingTables.has("agent_task_sessions")) tables.push(await repairTable(sql, mode, companyId, "agent_task_sessions", "id::text", companyMismatch(context.root.agentIds, "agent_id"), sampleLimit));
    if (existingTables.has("agent_wakeup_requests")) tables.push(await repairTable(sql, mode, companyId, "agent_wakeup_requests", "id::text", companyMismatch(context.root.agentIds, "agent_id"), sampleLimit));
    if (existingTables.has("agent_config_revisions")) tables.push(await repairTable(sql, mode, companyId, "agent_config_revisions", "id::text", companyMismatch(context.root.agentIds, "agent_id"), sampleLimit));
  }

  if (context.root.projectIds.length > 0) {
    tables.push(await repairTable(sql, mode, companyId, "projects", "id::text", companyMismatch(context.root.projectIds), sampleLimit));
    tables.push(await repairTable(sql, mode, companyId, "project_workspaces", "id::text", companyMismatch(context.root.projectIds, "project_id"), sampleLimit));
    tables.push(await repairTable(sql, mode, companyId, "execution_workspaces", "id::text", companyMismatch(context.root.projectIds, "project_id"), sampleLimit));
    if (existingTables.has("project_goals")) tables.push(await repairTable(sql, mode, companyId, "project_goals", "project_id::text || ':' || goal_id::text", companyMismatch(context.root.projectIds, "project_id"), sampleLimit));
  }

  if (context.root.projectWorkspaceIds.length > 0) {
    tables.push(await repairTable(sql, mode, companyId, "execution_workspaces", "id::text", companyMismatch(context.root.projectWorkspaceIds, "project_workspace_id"), sampleLimit));
  }

  if (context.root.issueIds.length > 0) {
    tables.push(await repairTable(sql, mode, companyId, "issues", "id::text", companyMismatch(context.root.issueIds), sampleLimit));
    if (existingTables.has("issue_comments")) tables.push(await repairTable(sql, mode, companyId, "issue_comments", "id::text", companyMismatch(context.root.issueIds, "issue_id"), sampleLimit));
    if (existingTables.has("issue_documents")) tables.push(await repairTable(sql, mode, companyId, "issue_documents", "id::text", companyMismatch(context.root.issueIds, "issue_id"), sampleLimit));
    if (existingTables.has("issue_attachments")) tables.push(await repairTable(sql, mode, companyId, "issue_attachments", "id::text", companyMismatch(context.root.issueIds, "issue_id"), sampleLimit));
    if (existingTables.has("issue_read_states")) tables.push(await repairTable(sql, mode, companyId, "issue_read_states", "id::text", companyMismatch(context.root.issueIds, "issue_id"), sampleLimit));
    if (existingTables.has("issue_work_products")) tables.push(await repairTable(sql, mode, companyId, "issue_work_products", "id::text", companyMismatch(context.root.issueIds, "issue_id"), sampleLimit));
    if (existingTables.has("issue_approvals")) tables.push(await repairTable(sql, mode, companyId, "issue_approvals", "issue_id::text || ':' || approval_id::text", companyMismatch(context.root.issueIds, "issue_id"), sampleLimit));
    if (existingTables.has("issue_labels")) tables.push(await repairTable(sql, mode, companyId, "issue_labels", "issue_id::text || ':' || label_id::text", companyMismatch(context.root.issueIds, "issue_id"), sampleLimit));
  }

  if (context.shared.documentIds.length > 0) {
    if (existingTables.has("documents")) tables.push(await repairTable(sql, mode, companyId, "documents", "id::text", companyMismatch(context.shared.documentIds), sampleLimit));
    if (existingTables.has("document_revisions")) tables.push(await repairTable(sql, mode, companyId, "document_revisions", "id::text", companyMismatch(context.shared.documentIds, "document_id"), sampleLimit));
  }

  if (context.shared.assetIds.length > 0) {
    if (existingTables.has("assets")) tables.push(await repairTable(sql, mode, companyId, "assets", "id::text", companyMismatch(context.shared.assetIds), sampleLimit));
  }

  if (context.shared.approvalIds.length > 0) {
    if (existingTables.has("approvals")) tables.push(await repairTable(sql, mode, companyId, "approvals", "id::text", companyMismatch(context.shared.approvalIds), sampleLimit));
    if (existingTables.has("approval_comments")) tables.push(await repairTable(sql, mode, companyId, "approval_comments", "id::text", companyMismatch(context.shared.approvalIds, "approval_id"), sampleLimit));
  }

  if (context.shared.labelIds.length > 0) {
    if (existingTables.has("labels")) tables.push(await repairTable(sql, mode, companyId, "labels", "id::text", companyMismatch(context.shared.labelIds), sampleLimit));
  }

  if (context.runIds.length > 0) {
    if (existingTables.has("heartbeat_runs")) tables.push(await repairTable(sql, mode, companyId, "heartbeat_runs", "id::text", companyMismatch(context.runIds), sampleLimit));
    if (existingTables.has("heartbeat_run_events")) tables.push(await repairTable(sql, mode, companyId, "heartbeat_run_events", "id::text", companyMismatch(context.runIds, "run_id"), sampleLimit));
  }

  if (context.runtimeServiceIds.length > 0) {
    if (existingTables.has("workspace_runtime_services")) tables.push(await repairTable(sql, mode, companyId, "workspace_runtime_services", "id::text", companyMismatch(context.runtimeServiceIds), sampleLimit));
    if (existingTables.has("issue_work_products")) tables.push(await repairTable(sql, mode, companyId, "issue_work_products", "id::text", companyMismatch(context.runtimeServiceIds, "runtime_service_id"), sampleLimit));
  }

  if (context.root.executionWorkspaceIds.length > 0) {
    if (existingTables.has("workspace_operations")) tables.push(await repairTable(sql, mode, companyId, "workspace_operations", "id::text", companyMismatch(context.root.executionWorkspaceIds, "execution_workspace_id"), sampleLimit));
  }

  if (context.costEventIds.length > 0) {
    if (existingTables.has("cost_events")) tables.push(await repairTable(sql, mode, companyId, "cost_events", "id::text", companyMismatch(context.costEventIds), sampleLimit));
    if (existingTables.has("finance_events")) tables.push(await repairTable(sql, mode, companyId, "finance_events", "id::text", companyMismatch(context.costEventIds, "cost_event_id"), sampleLimit));
  }

  if (context.budgetPolicyIds.length > 0) {
    if (existingTables.has("budget_policies")) tables.push(await repairTable(sql, mode, companyId, "budget_policies", "id::text", companyMismatch(context.budgetPolicyIds), sampleLimit));
    if (existingTables.has("budget_incidents")) tables.push(await repairTable(sql, mode, companyId, "budget_incidents", "id::text", companyMismatch(context.budgetPolicyIds, "policy_id"), sampleLimit));
  }

  const artifactPredicates = [
    context.root.agentIds.length > 0 ? `agent_id IN ${sqlArray(context.root.agentIds)}` : null,
    context.root.issueIds.length > 0 ? `issue_id IN ${sqlArray(context.root.issueIds)}` : null,
    context.runIds.length > 0 ? `heartbeat_run_id IN ${sqlArray(context.runIds)}` : null,
  ].filter(Boolean);
  if (existingTables.has("artifacts") && artifactPredicates.length > 0) {
    tables.push(await repairTable(
      sql,
      mode,
      companyId,
      "artifacts",
      "id::text",
      `(${artifactPredicates.join(" OR ")}) AND company_id <> ${quoteLiteral(companyId)}`,
      sampleLimit,
    ));
  }

  const financePredicates = [
    context.root.agentIds.length > 0 ? `agent_id IN ${sqlArray(context.root.agentIds)}` : null,
    context.root.projectIds.length > 0 ? `project_id IN ${sqlArray(context.root.projectIds)}` : null,
    context.root.issueIds.length > 0 ? `issue_id IN ${sqlArray(context.root.issueIds)}` : null,
    context.runIds.length > 0 ? `heartbeat_run_id IN ${sqlArray(context.runIds)}` : null,
  ].filter(Boolean);
  if (existingTables.has("finance_events") && financePredicates.length > 0) {
    tables.push(await repairTable(
      sql,
      mode,
      companyId,
      "finance_events",
      "id::text",
      `(${financePredicates.join(" OR ")}) AND company_id <> ${quoteLiteral(companyId)}`,
      sampleLimit,
    ));
  }

  const activityPredicates = [
    context.root.agentIds.length > 0 ? `agent_id IN ${sqlArray(context.root.agentIds)}` : null,
    context.runIds.length > 0 ? `run_id IN ${sqlArray(context.runIds)}` : null,
    context.root.issueIds.length > 0 ? `(entity_type = 'issue' AND entity_id IN ${sqlArray(context.root.issueIds)})` : null,
    context.root.projectIds.length > 0 ? `(entity_type = 'project' AND entity_id IN ${sqlArray(context.root.projectIds)})` : null,
    context.root.projectWorkspaceIds.length > 0 ? `(entity_type = 'project_workspace' AND entity_id IN ${sqlArray(context.root.projectWorkspaceIds)})` : null,
    context.root.executionWorkspaceIds.length > 0 ? `(entity_type = 'execution_workspace' AND entity_id IN ${sqlArray(context.root.executionWorkspaceIds)})` : null,
    context.shared.approvalIds.length > 0 ? `(entity_type = 'approval' AND entity_id IN ${sqlArray(context.shared.approvalIds)})` : null,
  ].filter(Boolean);
  if (existingTables.has("activity_log") && activityPredicates.length > 0) {
    tables.push(await repairTable(
      sql,
      mode,
      companyId,
      "activity_log",
      "id::text",
      `(${activityPredicates.join(" OR ")}) AND company_id <> ${quoteLiteral(companyId)}`,
      sampleLimit,
    ));
  }

  const backupCounts = await collectBackupCounts(backupSql, backupTables, sql, existingTables, companyId);
  return {
    slug: definition.slug,
    companyId,
    companyName: definition.companyName,
    issuePrefix: definition.issuePrefix,
    rootCounts,
    conflicts: sharedResult.conflicts,
    tables: tables.filter((result, index, results) => {
      const current = results.findIndex((entry) => entry.table === result.table && JSON.stringify(entry.sample) === JSON.stringify(result.sample) && entry.mismatchCount === result.mismatchCount && entry.appliedCount === result.appliedCount);
      return current === index;
    }),
    backupCounts,
  };
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a port for backup restore")));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function withRestoredBackupSql<T>(
  backupFile: string,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-recovery-backup-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C.UTF-8", "--username=paperclip"],
    onLog: () => {},
    onError: () => {},
  });

  try {
    await instance.initialise();
    await instance.start();
    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await runDatabaseRestore({ connectionString, backupFile });
    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  } finally {
    await instance.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

export async function runHoldingMigrationRecovery(
  options: RecoveryOptions,
): Promise<HoldingMigrationRecoveryReport> {
  const connectionString = assertConnectionString(options.connectionString);
  const mode = options.mode ?? "dry-run";
  const strict = options.strict === true;
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const selectedDefinitions = selectSubsidiariesForScope(options.companyScope);
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

  let preflightBackupSummary: string | null = null;
  try {
    await sql`SELECT 1`;

    if (mode === "apply") {
      const backupDir = options.backupDir ?? (options.fromBackup ? path.dirname(path.resolve(options.fromBackup)) : DEFAULT_BACKUP_DIR);
      const backupResult = await runDatabaseBackup({
        connectionString,
        backupDir,
        retentionDays: 7,
        filenamePrefix: "paperclip-recovery-preflight",
      });
      preflightBackupSummary = formatDatabaseBackupResult(backupResult);
    }

    const buildReport = async (backupSql: Sql | null) => {
      const liveTables = await listExistingTables(sql);
      const backupTables = backupSql ? await listExistingTables(backupSql) : null;
      const companies: CompanyRecoveryReport[] = [];
      if (mode === "apply") {
        await sql.begin(async (tx) => {
          for (const definition of selectedDefinitions) {
            const report = await recoverSubsidiary(tx, liveTables, definition, mode, strict, sampleLimit, backupSql, backupTables);
            if (report) companies.push(report);
          }
        });
      } else {
        for (const definition of selectedDefinitions) {
          const report = await recoverSubsidiary(sql, liveTables, definition, mode, strict, sampleLimit, backupSql, backupTables);
          if (report) companies.push(report);
        }
      }

      const totals = companies.reduce(
        (acc, company) => {
          acc.companies += 1;
          acc.conflicts += company.conflicts.reduce((sum, conflict) => sum + conflict.ids.length, 0);
          for (const table of company.tables) {
            acc.mismatches += table.mismatchCount;
            acc.applied += table.appliedCount;
          }
          return acc;
        },
        { companies: 0, mismatches: 0, applied: 0, conflicts: 0 },
      );

      return {
        mode,
        strict,
        backupReferenceFile: options.fromBackup ?? null,
        preflightBackupSummary,
        companies,
        totals,
      } satisfies HoldingMigrationRecoveryReport;
    };

    if (options.fromBackup) {
      return await withRestoredBackupSql(path.resolve(options.fromBackup), buildReport);
    }
    return await buildReport(null);
  } finally {
    await sql.end();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runHoldingMigrationRecovery(options);
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
