import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, documents, issueComments, issueDocuments, issues, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { companySearchQuerySchema } from "@paperclipai/shared";
import { companySearchService } from "../services/company-search.js";
import { parseTaskSearch, taskSearchCtes, taskSearchScore } from "../services/task-search.js";
import { issueService } from "../services/issues.js";
import { searchQualityMetrics, taskSearchCases, taskSearchCorpus } from "./fixtures/task-search-corpus.js";

const support = await getEmbeddedPostgresTestSupport();
const baseline = process.env.SEARCH_EVAL_BASELINE === "1";

describe.skipIf(!support.supported)("task search relevance rubric (real PostgreSQL)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const keys = new Map<string, string>();
  const plans: Record<string, unknown> = {};
  const latency: Array<{ engine: string; q: string; firstMs: number; p95Ms: number; warmMs: number[] }> = [];
  let postgresVersion = "";
  const report: Array<{ engine: string; name: string; q: string; keys: string[]; ndcg5: number; reciprocalRank: number; ms: number }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-search-quality-");
    db = createDb(tempDb.connectionString);
    postgresVersion = String((await db.execute(sql`SELECT version()`))[0]!.version);
    await db.insert(companies).values({ id: companyId, name: "Search benchmark", issuePrefix: "EVAL" });
    for (const [index, entry] of taskSearchCorpus.entries()) {
      const id = randomUUID();
      keys.set(id, entry.key);
      const updatedAt = new Date(Date.UTC(2026, 0, 1) + index * 60_000);
      await db.insert(issues).values({ id, companyId, title: entry.title,
        identifier: "identifier" in entry ? entry.identifier : `EVAL-${index + 1}`,
        description: "description" in entry ? entry.description : null,
        status: "status" in entry ? entry.status : "todo", updatedAt, createdAt: updatedAt });
      if ("comments" in entry) {
        for (const body of entry.comments) await db.insert(issueComments).values({ companyId, issueId: id, body, updatedAt });
      }
      if ("document" in entry) {
        const documentId = randomUUID();
        await db.insert(documents).values({ id: documentId, companyId, title: entry.document.title, latestBody: entry.document.body, format: "markdown" });
        await db.insert(issueDocuments).values({ companyId, issueId: id, documentId, key: "plan" });
      }
    }
  });

  afterAll(async () => {
    const summary = ["full", "quick"].map((engine) => {
      const rows = report.filter((row) => row.engine === engine);
      const known = rows.filter((row) => Object.keys(taskSearchCases.find((item) => item.name === row.name)!.relevant).length > 0);
      return { engine, queries: rows.length, ndcg5: rows.reduce((sum, row) => sum + row.ndcg5, 0) / rows.length,
        mrr: known.reduce((sum, row) => sum + row.reciprocalRank, 0) / known.length };
    });
    console.log("SEARCH QUALITY", JSON.stringify(summary));
    if (process.env.SEARCH_EVAL_REPORT) await writeFile(process.env.SEARCH_EVAL_REPORT, JSON.stringify({
      environment: { postgresVersion, platform: platform(), release: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), warmSamples: 20 },
      summary, queries: report, latency, plans,
    }, null, 2));
    await tempDb?.cleanup();
  });

  for (const engine of ["full", "quick"] as const) {
    for (const testCase of taskSearchCases) {
      it(`${engine}: ${testCase.name}`, async () => {
        const start = performance.now();
        const rows = engine === "full"
          ? (await companySearchService(db).search(companyId, companySearchQuerySchema.parse({ q: testCase.q }))).results.filter((row) => row.type === "issue")
          : await issueService(db).list(companyId, { q: testCase.q, limit: 50 });
        const resultKeys = rows.map((row) => keys.get(row.id)!);
        report.push({ engine, name: testCase.name, q: testCase.q, keys: resultKeys, ...searchQualityMetrics(resultKeys, testCase.relevant), ms: performance.now() - start });
        if (baseline) return;
        if (testCase.first) expect(resultKeys[0], JSON.stringify(resultKeys)).toBe(testCase.first);
        for (const absent of testCase.absent ?? []) expect(resultKeys).not.toContain(absent);
        for (const [key, grade] of Object.entries(testCase.relevant)) if (grade === 3) expect(resultKeys.slice(0, 5)).toContain(key);
        if (Object.keys(testCase.relevant).length === 0) expect(resultKeys).toEqual([]);
      });
    }
  }
  it("meets the aggregate relevance gates", () => {
    if (baseline) return;
    for (const engine of ["full", "quick"]) {
      const rows = report.filter((row) => row.engine === engine);
      const known = rows.filter((row) => taskSearchCases.find((entry) => entry.name === row.name)!.q !== "quasarxylophone");
      expect(known.reduce((sum, row) => sum + row.reciprocalRank, 0) / known.length).toBeGreaterThanOrEqual(0.95);
      expect(rows.reduce((sum, row) => sum + row.ndcg5, 0) / rows.length).toBeGreaterThanOrEqual(0.90);
    }
  });

  it("handles empty quotes, literal punctuation, and oversized title words without errors", async () => {
    if (baseline) return;
    await db.insert(issues).values({ companyId, title: "x".repeat(300) });
    for (const q of ['""', "%", "_", "\\", "z".repeat(200)]) {
      const full = await companySearchService(db).search(companyId, companySearchQuerySchema.parse({ q }));
      const quick = await issueService(db).list(companyId, { q, limit: 50 });
      if (q === '""' || q.startsWith("z")) {
        expect(full.results).toEqual([]);
        expect(quick).toEqual([]);
      } else {
        for (const row of quick) expect(row.title).toContain(q);
      }
    }
  });

  it.runIf(process.env.SEARCH_EVAL_SCALE === "1")("measures 10k tasks / 30k comments", async () => {
    await db.execute(sql`
      INSERT INTO issues (company_id, title, description, identifier)
      SELECT ${companyId}, 'Routine deployment checkpoint ' || n,
        repeat('Review the build output and update the deployment checklist. ', 5), 'SCALE-' || n
      FROM generate_series(1, 10000) n
    `);
    await db.execute(sql`
      INSERT INTO issue_comments (company_id, issue_id, body)
      SELECT ${companyId}, id, repeat('Routine progress report: verified the output and recorded the findings. ', 5)
      FROM issues CROSS JOIN generate_series(1, 3) n
      WHERE company_id = ${companyId} AND identifier LIKE 'SCALE-%'
    `);
    await db.execute(sql`ANALYZE issues`);
    await db.execute(sql`ANALYZE issue_comments`);
    for (const engine of ["full", "quick"] as const) {
      for (const q of ["GitHub OAuth", "OAuth callback GitHub", "mibile api", "search", "quasarxylophone", "routine"]) {
        const durations: number[] = [];
        for (let i = 0; i < 21; i++) {
          const start = performance.now();
          if (engine === "full") await companySearchService(db).search(companyId, companySearchQuerySchema.parse({ q }));
          else await issueService(db).list(companyId, { q, limit: 20 });
          durations.push(performance.now() - start);
        }
        const warmMs = durations.slice(1);
        latency.push({ engine, q, firstMs: durations[0]!, p95Ms: [...warmMs].sort((a, b) => a - b)[18]!, warmMs });
      }
    }
    for (const q of ["GitHub OAuth", "mibile api", "routine"]) {
      const search = parseTaskSearch(q);
      if (!baseline) plans[q] = await db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        ${taskSearchCtes(companyId, search)}
        SELECT m.id, ${taskSearchScore(search)} AS score FROM matched m ORDER BY score DESC LIMIT 20
      `);
    }
    console.log("SEARCH LATENCY", JSON.stringify(latency.map(({ warmMs: _warmMs, ...row }) => row)));
  }, 120_000);

});
