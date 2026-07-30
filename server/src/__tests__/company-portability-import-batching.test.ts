import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assets,
  createDb,
  documentRevisions,
  documents,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueLabels,
  issueRelations,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { workProductService } from "../services/work-products.js";
import type { ImportIssueWorkProductRow } from "../services/import-write-types.js";
import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";

// This suite proves the company-import writers batch their inserts: it runs a
// real import against embedded Postgres and counts the SQL insert statements
// issued per table. The non-benchmark test guards against a regression to the
// old one-insert-per-row pattern in normal CI; the benchmark (opt-in via
// PORTABILITY_IMPORT_BENCH=1) reports wall-clock and statement counts at scale.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Tables whose insert statements we count, keyed by a readable label.
const COUNTED_TABLES: Array<[string, unknown]> = [
  ["issues", issues],
  ["issue_labels", issueLabels],
  ["issue_comments", issueComments],
  ["documents", documents],
  ["document_revisions", documentRevisions],
  ["issue_documents", issueDocuments],
  ["issue_work_products", issueWorkProducts],
  ["assets", assets],
  ["issue_attachments", issueAttachments],
  ["issue_relations", issueRelations],
];

interface InsertCounts {
  total: number;
  byTable: Map<string, number>;
  reset: () => void;
}

/**
 * Patch a drizzle db so every `insert()` call (on the db and on any
 * transaction handed to `db.transaction`) is counted. Each `insert(table)`
 * call corresponds to exactly one SQL statement, so this counts statements.
 */
function instrumentInserts(db: Record<string, unknown>): InsertCounts {
  const counts: InsertCounts = {
    total: 0,
    byTable: new Map(),
    reset() {
      this.total = 0;
      this.byTable.clear();
    },
  };
  const labelFor = (table: unknown): string | null => {
    for (const [label, ref] of COUNTED_TABLES) {
      if (table === ref) return label;
    }
    return null;
  };
  const patchInsert = (target: Record<string, unknown>) => {
    const original = (target.insert as (table: unknown) => unknown).bind(target);
    target.insert = (table: unknown) => {
      counts.total += 1;
      const label = labelFor(table);
      if (label) counts.byTable.set(label, (counts.byTable.get(label) ?? 0) + 1);
      return original(table);
    };
  };
  patchInsert(db);
  const originalTransaction = (db.transaction as (fn: unknown, config?: unknown) => unknown).bind(db);
  db.transaction = (fn: (tx: Record<string, unknown>) => unknown, config?: unknown) =>
    originalTransaction((tx: Record<string, unknown>) => {
      patchInsert(tx);
      return fn(tx);
    }, config);
  return counts;
}

// The `.paperclip.yaml` extension is consumed by the importer's own hand-rolled
// block-YAML parser (not a general YAML/JSON reader), so render it with the same
// block algorithm the exporter uses to guarantee a round-trip-compatible bundle.
function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function isRenderableScalar(value: unknown): boolean {
  return (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
    || (Array.isArray(value) && value.length === 0)
    || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

function renderYamlBlock(value: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      if (isRenderableScalar(entry)) {
        lines.push(`${indent}- ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      if (isRenderableScalar(entry)) {
        lines.push(`${indent}${key}: ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }
  return [`${indent}${renderYamlScalar(value)}`];
}

function renderPaperclipYaml(value: Record<string, unknown>): string {
  return `${renderYamlBlock(value, 0).join("\n")}\n`;
}

interface SyntheticBundleOptions {
  issueCount: number;
  commentsPerIssue: number;
  documentsPerIssue: number;
}

/** Build an inline import bundle with the requested shape, valid at schemaVersion 6. */
function buildSyntheticBundle(options: SyntheticBundleOptions): {
  rootPath: string;
  files: Record<string, CompanyPortabilityFileEntry>;
} {
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  files["COMPANY.md"] = ['---', 'schema: "agentcompanies/v1"', 'name: "Batching Bench Co"', '---', '', 'Synthetic import bundle.', ''].join("\n");

  const tasks: Record<string, unknown> = {};
  for (let i = 1; i <= options.issueCount; i += 1) {
    const slug = `task-${String(i).padStart(4, "0")}`;
    files[`tasks/${slug}/TASK.md`] = ['---', `name: "Task ${i}"`, "kind: task", '---', '', `Description body for task ${i}. `.repeat(6), ''].join("\n");

    const comments = [];
    for (let c = 0; c < options.commentsPerIssue; c += 1) {
      comments.push({
        body: `Comment ${c + 1} on task ${i}. `.repeat(4),
        authorType: "system",
      });
    }
    const taskDocuments = [];
    for (let d = 0; d < options.documentsPerIssue; d += 1) {
      const key = d === 0 ? "spec" : `doc-${d + 1}`;
      const docPath = `tasks/${slug}/documents/${key}.md`;
      files[docPath] = `# ${key}\n\n${`Document body for task ${i} ${key}. `.repeat(8)}`;
      taskDocuments.push({ key, title: key, format: "markdown", path: docPath });
    }

    tasks[slug] = {
      status: "todo",
      priority: "medium",
      comments,
      documents: taskDocuments,
    };
  }

  files[".paperclip.yaml"] = renderPaperclipYaml({ schemaVersion: 6, tasks });

  return { rootPath: "batching-bench", files };
}

describeEmbeddedPostgres("company import batches inserts", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let counts!: InsertCounts;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-import-batching-");
    db = createDb(tempDb.connectionString);
    counts = instrumentInserts(db as unknown as Record<string, unknown>);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    counts.reset();
  });

  it("imports many issues with a bounded number of issue-insert statements", async () => {
    const issueCount = 50;
    const commentsPerIssue = 2;
    const documentsPerIssue = 1;
    const bundle = buildSyntheticBundle({ issueCount, commentsPerIssue, documentsPerIssue });
    const portability = companyPortabilityService(db);

    const result = await portability.importBundle(
      {
        source: { type: "inline", rootPath: bundle.rootPath, files: bundle.files },
        include: { company: true, agents: false, projects: false, issues: true },
        target: { mode: "new_company", newCompanyName: "Batching Regression Co" },
        collisionStrategy: "rename",
      },
      "user-batching-regression",
    );

    const companyId = result.company.id;
    const issueInserts = counts.byTable.get("issues") ?? 0;
    const commentInserts = counts.byTable.get("issue_comments") ?? 0;

    // The whole point: a 50-issue import must not issue one insert per issue.
    expect(issueInserts).toBeLessThan(issueCount);
    // 50 issues fit in a single chunk; the exact number is small and stable.
    expect(issueInserts).toBeLessThanOrEqual(2);
    expect(commentInserts).toBeLessThanOrEqual(2);

    // And the data must actually land, unchanged in shape.
    const [{ issueRows }] = await db
      .select({ issueRows: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    const [{ commentRows }] = await db
      .select({ commentRows: sql<number>`count(*)::int` })
      .from(issueComments)
      .where(eq(issueComments.companyId, companyId));
    // Count the issue-document links so company-bootstrap routine documents
    // (seeded on company creation) don't skew the imported-document count.
    const [{ documentLinkRows }] = await db
      .select({ documentLinkRows: sql<number>`count(*)::int` })
      .from(issueDocuments)
      .where(eq(issueDocuments.companyId, companyId));

    expect(issueRows).toBe(issueCount);
    expect(commentRows).toBe(issueCount * commentsPerIssue);
    expect(documentLinkRows).toBe(issueCount * documentsPerIssue);
    expect(result.warnings).toEqual([]);

    // Identifiers are a contiguous range allocated from the company counter.
    const identifiers = await db
      .select({ identifier: issues.identifier })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    const uniqueIdentifiers = new Set(identifiers.map((row) => row.identifier));
    expect(uniqueIdentifiers.size).toBe(issueCount);
  });

  it("rolls back the whole work-product batch when a later chunk fails", async () => {
    // Seed a real company + issue to hang work products off of.
    const bundle = buildSyntheticBundle({ issueCount: 1, commentsPerIssue: 0, documentsPerIssue: 0 });
    const portability = companyPortabilityService(db);
    const seeded = await portability.importBundle(
      {
        source: { type: "inline", rootPath: bundle.rootPath, files: bundle.files },
        include: { company: true, agents: false, projects: false, issues: true },
        target: { mode: "new_company", newCompanyName: "Work Product Atomicity Co" },
        collisionStrategy: "rename",
      },
      "user-work-product-atomicity",
    );
    const companyId = seeded.company.id;
    const [issueRow] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .limit(1);
    expect(issueRow?.id).toBeTruthy();

    const buildRow = (issueId: string, index: number): ImportIssueWorkProductRow => ({
      companyId,
      issueId,
      projectId: null,
      type: "pull_request",
      provider: "github",
      externalId: null,
      title: `Work product ${index}`,
      url: null,
      status: "open",
      reviewState: "none",
      isPrimary: false,
      healthStatus: "unknown",
      summary: null,
      metadata: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      createdByRunId: null,
      sourceTrust: null,
    });

    // 501 rows span two chunks (chunk size is 500). The first 500 are valid;
    // the 501st points at a non-existent issue so the *second* chunk's insert
    // fails after the first chunk already ran. Without a wrapping transaction
    // the first 500 would have committed; with it, nothing may persist.
    const rows: ImportIssueWorkProductRow[] = [];
    for (let i = 0; i < 500; i += 1) rows.push(buildRow(issueRow!.id, i));
    rows.push(buildRow(randomUUID(), 500));

    await expect(workProductService(db).createManyForImport(rows)).rejects.toThrow();

    const [{ workProductRows }] = await db
      .select({ workProductRows: sql<number>`count(*)::int` })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.companyId, companyId));
    expect(workProductRows).toBe(0);
  });

  const benchmark = process.env.PORTABILITY_IMPORT_BENCH === "1" ? it : it.skip;
  benchmark(
    "benchmark: large import stays in the tens of statements, not thousands",
    async () => {
      const issueCount = 500;
      const commentsPerIssue = 5;
      const documentsPerIssue = 1;
      const bundle = buildSyntheticBundle({ issueCount, commentsPerIssue, documentsPerIssue });
      const totalRows =
        issueCount + issueCount * commentsPerIssue + issueCount * documentsPerIssue * 3;
      const portability = companyPortabilityService(db);

      const startedAt = performance.now();
      const result = await portability.importBundle(
        {
          source: { type: "inline", rootPath: bundle.rootPath, files: bundle.files },
          include: { company: true, agents: false, projects: false, issues: true },
          target: { mode: "new_company", newCompanyName: "Batching Benchmark Co" },
          collisionStrategy: "rename",
        },
        "user-batching-benchmark",
      );
      const elapsedMs = performance.now() - startedAt;

      const perTable = Object.fromEntries(counts.byTable);
      // Analytical "before": the old path inserted one row per statement.
      const beforeStatements = totalRows;
      const afterStatements = counts.total;

      // eslint-disable-next-line no-console
      console.log(
        `[import-batching-bench] ${issueCount} issues x ${commentsPerIssue} comments x ${documentsPerIssue} doc\n`
          + `  wall-clock: ${elapsedMs.toFixed(0)}ms\n`
          + `  insert statements (after batching): ${afterStatements}\n`
          + `  insert statements (before, one per row): ~${beforeStatements}\n`
          + `  reduction: ${(beforeStatements / Math.max(1, afterStatements)).toFixed(0)}x\n`
          + `  per-table insert statements: ${JSON.stringify(perTable)}`,
      );

      const companyId = result.company.id;
      const [{ issueRows }] = await db
        .select({ issueRows: sql<number>`count(*)::int` })
        .from(issues)
        .where(eq(issues.companyId, companyId));
      expect(issueRows).toBe(issueCount);

      // Two orders of magnitude fewer statements than the per-row baseline.
      expect(afterStatements * 50).toBeLessThan(beforeStatements);
      expect(counts.byTable.get("issues") ?? 0).toBeLessThanOrEqual(2);
    },
    120_000,
  );
});
