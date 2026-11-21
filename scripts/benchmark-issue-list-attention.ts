import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, agents, companies, heartbeatRuns, issueRelations, issues } from "../packages/db/src/index.js";
import { issueService } from "../server/src/services/issues.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baselineRef = arg("baseline-ref");
assert.ok(baselineRef, "Pass a pinned --baseline-ref=<commit>");
const baselineRevision = execFileSync("git", ["rev-parse", `${baselineRef}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const sampleCount = Number(arg("samples") ?? 5);
const rootCount = Number(arg("roots") ?? 24);
const unrelatedCount = Number(arg("unrelated") ?? 1500);
const evidenceDir = arg("evidence-dir");
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.issue-attention-baseline-"));
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
try {
  const source = execFileSync("git", ["show", `${baselineRevision}:server/src/services/issues.ts`], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
    .replace(/from "(\.{1,2}\/[^"]+)"/g, (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, pathToFileURL(path.join(root, "server/src/services/issues.ts")))))}`);
  await fs.writeFile(path.join(baselineDir, "issues.ts"), source);
  const baseline = await import(pathToFileURL(path.join(baselineDir, "issues.ts")).href) as typeof import("../server/src/services/issues.js");
  database = await startEmbeddedPostgresTestDatabase("issue-attention-benchmark-");
  db = createDb(database.connectionString, { maxConnections: 8 });
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic attention", issuePrefix: "BENCHATT" });
  const [agent] = await db.insert(agents).values({ companyId, name: "Synthetic worker", adapterType: "process", status: "active" }).returning();
  const ids = Array.from({ length: rootCount }, () => randomUUID());
  const children = ids.map(parentId => ({ id: randomUUID(), parentId }));
  const at = new Date("2026-01-01T00:00:00Z");
  await db.insert(issues).values(ids.map((id, i) => ({ id, companyId, title: `Root ${i}`, status: "blocked", assigneeAgentId: agent!.id, createdAt: at, updatedAt: at })));
  await db.insert(issues).values(children.map((child, i) => ({ ...child, companyId, title: `Child ${i}`, status: "in_progress", assigneeAgentId: agent!.id, description: randomUUID().repeat(500), createdAt: at, updatedAt: at })));
  await db.insert(heartbeatRuns).values(children.map(child => ({ companyId, agentId: agent!.id, status: "running", contextSnapshot: { issueId: child.id } })));
  for (let offset = 0; offset < unrelatedCount; offset += 250) {
    await db.insert(issues).values(Array.from({ length: Math.min(250, unrelatedCount - offset) }, (_, i) => ({
      companyId,
      title: `Unrelated work ${offset + i}`,
      status: "in_review" as const,
      assigneeAgentId: agent!.id,
      createdAt: at,
      updatedAt: at,
    })));
  }
  await db.insert(issueRelations).values(children.map(child => ({
    companyId, issueId: child.id, relatedIssueId: child.parentId, type: "blocks" as const,
  })));
  const client = db.$client as any;
  const unsafe = client.unsafe.bind(client);
  let reads = 0;
  client.unsafe = (text: string, params?: unknown[], options?: unknown) => {
    if (/^\s*(select|with)\b/i.test(text)) reads++;
    return unsafe(text, params, options);
  };
  const arms = { baseline: baseline.issueService(db), treatment: issueService(db) };
  const report: Record<string, unknown> = {};
  for (const projection of ["rows", "index"] as const) {
    const timings = { baseline: [] as number[], treatment: [] as number[] };
    const queryCounts = { baseline: [] as number[], treatment: [] as number[] };
    let reference: unknown;
    for (let i = -2; i < sampleCount; i++) {
      for (const arm of (i % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"]) as Array<keyof typeof arms>) {
        reads = 0;
        const start = performance.now();
        const result = await arms[arm].list(companyId, { issueIds: ids, listProjection: projection, includeBlockedInboxAttention: true, includeLiveDescendantSummary: true, limit: rootCount });
        const elapsed = performance.now() - start;
        const serialized = JSON.parse(JSON.stringify(result));
        if (reference === undefined) reference = serialized;
        else assert.deepEqual(serialized, reference, `${projection}/${arm}: full ordered payload differs`);
        if (i >= 0) { timings[arm].push(elapsed); queryCounts[arm].push(reads); }
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    report[projection] = { timings, queryCounts, mediansMs: { baseline: median(timings.baseline), treatment: median(timings.treatment) }, reduction: 1 - median(timings.treatment) / median(timings.baseline), completePayloadsEqual: true };
  }
  const result = { baselineRevision, rootCount, unrelatedCount, sampleCount, databaseVersion: (await client.unsafe("select version()"))[0].version, report };
  if (evidenceDir) { await fs.mkdir(evidenceDir, { recursive: true }); await fs.writeFile(path.join(evidenceDir, "issue-list-attention.json"), JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db?.$client.end({ timeout: 1 });
  await database?.cleanup();
  clearInterval(keepAlive);
  await fs.rm(baselineDir, { recursive: true, force: true });
}
