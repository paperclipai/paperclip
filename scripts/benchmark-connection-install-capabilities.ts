import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agents, companies, companyMemberships, createDb, principalPermissionGrants,
  startEmbeddedPostgresTestDatabase, toolApplications, toolConnections, toolConnectionInstalls, type Db,
} from "../packages/db/src/index.js";
import { connectionManagementService } from "../server/src/services/connection-management.js";
import type { AuthorizationActor } from "../server/src/services/authorization.js";

// Run explicitly; this benchmark never reads DATABASE_URL or contacts a hosted DB.
// node --import ./server/node_modules/tsx/dist/esm/index.mjs scripts/benchmark-connection-install-capabilities.ts --baseline-ref=<pre-fix SHA>
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Supply an explicit pre-fix --baseline-ref");
const repository = fileURLToPath(new URL("../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`);
const treatmentRevision = git("rev-parse", "HEAD");
const servicePath = "server/src/services/connection-management.ts";
const routePath = "server/src/routes/tool-access.ts";
const runtimeChanges = git("diff", baselineRevision, "--name-only", "--", "server/src", "packages/db/src", "packages/shared/src")
  .split("\n").filter(Boolean).filter(name => !name.includes("/__tests__/") && !/\.test\.[cm]?ts$/.test(name));
assert.deepEqual(runtimeChanges.filter(name => name !== servicePath && name !== routePath), [],
  "Baseline imports current dependencies: isolate any additional changed runtime dependencies first");
assert.equal(git("diff", baselineRevision, "--", "pnpm-lock.yaml"), "", "Dependency lock must match the pinned baseline");
const oldSource = execFileSync("git", ["show", `${baselineRevision}:${servicePath}`], { cwd: repository, encoding: "utf8" });
const requireFromServer = createRequire(new URL("../server/package.json", import.meta.url));
const serviceUrl = new URL(`../${servicePath}`, import.meta.url);
const rewritten = oldSource.replace(/from "([^"]+)"/g, (_match, specifier: string) => {
  const resolved = specifier.startsWith(".")
    ? fileURLToPath(new URL(specifier, serviceUrl))
    : requireFromServer.resolve(specifier).replace(/\.cjs$/, ".js");
  return `from ${JSON.stringify(resolved)}`;
});
const baselineDirectory = await mkdtemp(path.join(tmpdir(), "connection-install-baseline-"));
const baselineFile = path.join(baselineDirectory, "connection-management.mts");
await writeFile(baselineFile, rewritten);
const baselineModule = await import(pathToFileURL(baselineFile).href) as typeof import("../server/src/services/connection-management.js");

type Statement = { sql: string; params: unknown[]; calls: number; rows: number };
type Counts = { calls: number; rows: number; statements: Map<string, Statement> };
let activeCounts: Counts | undefined;
function instrument(db: Db): Db {
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== "select") return Reflect.get(target, key, receiver);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields);
      const from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const query = from(...args), execute = query.execute.bind(query);
        query.execute = (async (...executeArgs: Parameters<typeof execute>) => {
          const counts = activeCounts;
          const compiled = counts ? query.toSQL() : undefined;
          const result = await execute(...executeArgs);
          if (counts && compiled) {
            counts.calls++;
            const rows = Array.isArray(result) ? result.length : 0;
            counts.rows += rows;
            const statement = counts.statements.get(compiled.sql) ?? { ...compiled, calls: 0, rows: 0 };
            statement.calls++;
            statement.rows += rows;
            counts.statements.set(compiled.sql, statement);
          }
          return result;
        }) as typeof execute;
        return query;
      }) as typeof builder.from;
      return builder;
    };
  } });
}
function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samplesMs: samples, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) };
}

const keepAlive = setInterval(() => {}, 1_000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
try {
  database = await startEmbeddedPostgresTestDatabase("connection-install-benchmark-");
  db = createDb(database.connectionString);
  const observedDb = instrument(db);
  const old = baselineModule.connectionManagementService(observedDb);
  const treatment = connectionManagementService(observedDb);
  assert.equal(typeof treatment.describeAgentInstallCapabilities, "function", "Implement the production batch first");
  const results = [];
  for (const n of [1, 8, 32, 100]) {
    for (const installs of ["company", "partial"] as const) {
      const companyId = randomUUID(), connectionId = randomUUID(), applicationId = randomUUID(), userId = randomUUID();
      const candidateIds = Array.from({ length: n }, () => randomUUID());
      await db.insert(companies).values({ id: companyId, name: `Capability benchmark ${n} ${installs}`, issuePrefix: `B${results.length}` });
      await db.insert(agents).values(candidateIds.map((id, index) => ({ id, companyId, name: `Agent ${index}`, adapterType: "process" })));
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
        permissionKey: "tools:manage_profiles", scope: { targetAgentIds: candidateIds } });
      await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Synthetic benchmark", type: "mcp_http" });
      await db.insert(toolConnections).values({ id: connectionId, applicationId, companyId, uid: connectionId,
        name: "Synthetic benchmark", transport: "mcp_remote", authKind: "none", config: { provider: "fixture" } });
      await db.insert(toolConnectionInstalls).values(installs === "company"
        ? [{ companyId, connectionId, targetType: "company", targetId: companyId }]
        : candidateIds.slice(0, Math.max(1, Math.floor(n / 4))).map(targetId => ({ companyId, connectionId, targetType: "agent" as const, targetId })));
      await db.$client.unsafe("ANALYZE");
      const actor: AuthorizationActor = { type: "board", source: "cloud_tenant", userId };
      const resource = { type: "connection_management" as const, companyId, connectionId, operation: "configure", readOnly: false };
      const baseline = async () => {
        const capabilities = [];
        for (const targetAgentId of candidateIds) capabilities.push(await old.capability(actor, "connections:profiles", { ...resource, targetAgentId }));
        return capabilities;
      };
      const batch = () => treatment.describeAgentInstallCapabilities(actor, resource, candidateIds);
      const samples = { baseline: [] as number[], treatment: [] as number[] };
      const counters: Record<string, { calls: number; rows: number }> = {};
      let captured: Record<string, Statement[]> = {};
      for (let iteration = 0; iteration < 7; iteration++) {
        const order = iteration % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const;
        const outputs: Record<string, unknown> = {};
        for (const name of order) {
          activeCounts = { calls: 0, rows: 0, statements: new Map() };
          const start = performance.now();
          outputs[name] = await (name === "baseline" ? baseline() : batch());
          const elapsed = performance.now() - start;
          const counts = activeCounts;
          activeCounts = undefined;
          if (iteration >= 2) samples[name].push(elapsed);
          const previous = counters[name];
          const current = { calls: counts.calls, rows: counts.rows };
          if (previous) assert.deepEqual(current, previous, "Stable fixture must generate stable work counts");
          counters[name] = current;
          if (iteration === 6) captured[name] = [...counts.statements.values()];
        }
        assert.deepEqual(outputs.treatment, outputs.baseline, `${installs} N=${n}: full positional capabilities`);
        assert.equal((outputs.baseline as Array<{ allowed: boolean }>).length, n);
        assert.ok((outputs.baseline as Array<{ allowed: boolean }>).every(capability => capability.allowed), "The benchmark must exercise every authorized retained target");
      }
      assert.ok(counters.treatment.calls < counters.baseline.calls || n === 1, "Batch must remove repeated SQL");
      // This is a call-fan-out change. Individual statement plans are controls,
      // not the explanation of the gain; capture them outside measured samples.
      const plans = [];
      for (const statement of captured.treatment) {
        const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.params as never[]);
        plans.push({ ...statement, plan: plan["QUERY PLAN"] });
      }
      const before = summary(samples.baseline), after = summary(samples.treatment);
      const targetLookups = (statements: Statement[]) => statements.filter(statement => statement.sql.includes('"agents"."id" =')).reduce((sum, statement) => sum + statement.calls, 0);
      const expectedRetained = installs === "company" ? n : Math.max(1, Math.floor(n / 4));
      assert.equal(targetLookups(captured.baseline), n * expectedRetained + n - expectedRetained);
      assert.equal(targetLookups(captured.treatment), n);
      const result = { n, installs, principal: "cloud noncreator member with target-scoped grant", completePositionalEquality: true,
        baseline: { ...before, ...counters.baseline, targetLookups: targetLookups(captured.baseline) },
        treatment: { ...after, ...counters.treatment, targetLookups: targetLookups(captured.treatment) },
        speedup: before.medianMs! / after.medianMs!, statements: captured, treatmentPlans: plans };
      results.push(result);
      console.error(JSON.stringify({ n, installs, baselineMs: before.medianMs, treatmentMs: after.medianMs, counts: counters }));
    }
  }
  const [version] = await db.$client.unsafe("SELECT version() AS version");
  const settings = await db.$client.unsafe("SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','jit') ORDER BY name");
  console.log(JSON.stringify({ baselineRevision, treatmentRevision,
    benchmarkSourceSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
    treatmentSourceSha256: createHash("sha256").update(await readFile(new URL(`../${servicePath}`, import.meta.url))).digest("hex"),
    uncommittedDiffSha256: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
    dependencyLockfileSha256: createHash("sha256").update(await readFile(new URL("../pnpm-lock.yaml", import.meta.url))).digest("hex"),
    baselineIsolation: { copiedModule: servicePath, imports: "Absolute current paths; all other server/shared/db runtime sources and lockfile verified unchanged from baseline", runtimeChanges },
    node: process.version, postgres: version.version, settings, warmups: 2, samples: 5, alternatingOrder: true,
    measurement: "Real service evaluation with real local PostgreSQL; select statement executions and returned Drizzle rows; no simulated transport latency",
    limits: "Descriptive service batch only; no hosted latency attribution, agent fast path, route timing, concurrent revocation, or subtree hierarchy scaling claim",
    results }, null, 2));
} finally {
  activeCounts = undefined;
  try {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    await rm(baselineDirectory, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
