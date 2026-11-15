import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agents, companies, createDb, startEmbeddedPostgresTestDatabase,
  toolApplications, toolCatalogEntries, toolConnections, toolPolicies,
} from "../packages/db/src/index.js";
import { toolAccessService } from "../server/src/services/tool-access.js";
import { toolAccessPolicyService } from "../server/src/services/tool-access-policy.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Supply an explicit pre-fix --baseline-ref=<SHA>");
const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9);
const repository = fileURLToPath(new URL("../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`);
const servicePath = "server/src/services/tool-access.ts";
const policyPath = "server/src/services/tool-access/catalog/default-access.ts";
const runtimeChanges = git("diff", baselineRevision, "--name-only", "--", "server/src", "packages/db/src", "packages/shared/src")
  .split("\n").filter(Boolean).filter(name => !name.includes("/__tests__/") && !/\.test\.[cm]?ts$/.test(name));
assert.deepEqual(runtimeChanges.filter(name => ![servicePath, policyPath].includes(name)), [],
  "Isolate additional changed runtime dependencies before measuring");
assert.equal(git("diff", baselineRevision, "--", "pnpm-lock.yaml"), "", "Dependencies must match the pinned baseline");
const requireFromServer = createRequire(new URL("../server/package.json", import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), "app-permission-baseline-"));
function baselineSource(sourcePath: string) {
  const source = execFileSync("git", ["show", `${baselineRevision}:${sourcePath}`], { cwd: repository, encoding: "utf8" });
  return source.replace(/from "([^"]+)"/g, (_match, specifier: string) => {
    const resolved = sourcePath === servicePath && specifier === "./tool-access/catalog/default-access.js"
      ? path.join(scratch, "default-access.mts")
      : specifier.startsWith(".")
        ? fileURLToPath(new URL(specifier, new URL(sourcePath, pathToFileURL(`${repository}/`))))
        : requireFromServer.resolve(specifier).replace(/\.cjs$/, ".js");
    return `from ${JSON.stringify(resolved)}`;
  });
}
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
try {
  await writeFile(path.join(scratch, "default-access.mts"), baselineSource(policyPath));
  await writeFile(path.join(scratch, "tool-access.mts"), baselineSource(servicePath));
  const baseline = await import(pathToFileURL(path.join(scratch, "tool-access.mts")).href) as { toolAccessService: typeof toolAccessService };
  database = await startEmbeddedPostgresTestDatabase("app-permission-benchmark-");
  const client = db = createDb(database.connectionString);
  type Statement = { sql: string; params: unknown[] };
  let captured: Statement[] | undefined;
  client.$client.options.debug = (_connection, sql, params) => {
    captured?.push({ sql, params: [...params] });
  };
  const fixtures = [];
  for (const [label, factory] of [["baseline", baseline.toolAccessService], ["treatment", toolAccessService]] as const) {
    const [company] = await client.insert(companies).values({ name: "Benchmark", issuePrefix: `B${randomUUID().slice(0, 6)}` }).returning();
    const roster = await client.insert(agents).values(Array.from({ length: 4 }, (_, i) => ({ companyId: company.id, name: `Agent ${i}` }))).returning();
    const [application] = await client.insert(toolApplications).values({ companyId: company.id, name: "App", type: "mcp_http" }).returning();
    const [connection] = await client.insert(toolConnections).values({ companyId: company.id, applicationId: application.id,
      uid: randomUUID(), name: "App connection", transport: "mcp_remote", status: "active", enabled: true }).returning();
    const catalog = await client.insert(toolCatalogEntries).values(Array.from({ length: 100 }, (_, i) => ({
      companyId: company.id, applicationId: application.id, connectionId: connection.id,
      name: `action_${i}`, toolName: `action_${i}`, riskLevel: "write" as const, status: "active" as const,
      versionHash: `v${i}`, schemaHash: `s${i}`,
    }))).returning();
    const service = factory(client);
    const save = (agentIds: string[]) => service.finishGalleryAppConnection(company.id, connection.id, {
      access: { agentIds }, enabledCatalogEntryIds: catalog.map(entry => entry.id),
      askFirstCatalogEntryIds: catalog.slice(1).map(entry => entry.id),
    });
    const initial = await save(roster.slice(0, 3).map(agent => agent.id));
    await client.insert(toolPolicies).values(Array.from({ length: 500 }, (_, i) => ({
      companyId: company.id, name: `Retired ${i}`, policyType: "require_approval" as const, enabled: false,
      config: { source: "app_gallery_finish", connectionId: connection.id, catalogEntryId: randomUUID() },
    })));
    const ids = new Map([[company.id, "company"], [connection.id, "connection"], [application.id, "application"], [initial.profile.id, "profile"],
      ...roster.map((agent, i) => [agent.id, `agent_${i}`] as [string, string]),
      ...catalog.map((entry, i) => [entry.id, `catalog_${i}`] as [string, string])]);
    function normalize(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (typeof value === "string") return ids.get(value) ?? value.replaceAll(connection.id, "connection").replaceAll(connection.id.slice(0, 8), "connection");
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !["id", "createdAt", "updatedAt"].includes(key)).map(([key, nested]) => [key, normalize(nested)]));
      return value;
    }
    fixtures.push({ label, save: () => save(roster.map(agent => agent.id)),
      reset: () => save(roster.slice(0, 3).map(agent => agent.id)), normalize,
      company, roster, connection, catalog, samples: [] as number[], statements: [] as Statement[], result: initial });
  }
  for (let i = 0; i < 2; i++) for (const fixture of fixtures) {
    await fixture.reset();
    await fixture.save();
  }
  for (let i = 0; i < 6; i++) {
    for (const fixture of i % 2 ? [...fixtures].reverse() : fixtures) {
      await fixture.reset();
      captured = [];
      const started = performance.now();
      fixture.result = await fixture.save();
      fixture.samples.push(performance.now() - started);
      fixture.statements = captured;
      captured = undefined;
    }
  }
  const snapshot = (fixture: typeof fixtures[number]) => fixture.normalize({
    profile: fixture.result.profile, entries: fixture.result.profileEntries,
    bindings: fixture.result.profileBindings, policies: fixture.result.policies,
  });
  assert.deepEqual(snapshot(fixtures[0]), snapshot(fixtures[1]), "Complete saved profile/entry/binding/policy values must match except generated IDs and write timestamps");
  const policy = toolAccessPolicyService(client);
  for (const fixture of fixtures) {
    for (const [entry, expected] of [[fixture.catalog[0], "allow"], [fixture.catalog[1], "require_approval"]] as const) {
      const result = await policy.decide({ companyId: fixture.company.id,
        actor: { actorType: "agent", actorId: fixture.roster[3].id, agentId: fixture.roster[3].id },
        request: { connectionId: fixture.connection.id, catalogEntryId: entry.id, toolName: entry.toolName, arguments: {} } });
      assert.equal(result.decision, expected);
    }
  }
  const measurements = fixtures.map(fixture => {
    const sorted = [...fixture.samples].sort((a, b) => a - b);
    const policyWrites = fixture.statements.filter(statement => /^(insert into|update|delete from) "tool_policies"/i.test(statement.sql));
    return { label: fixture.label, samplesMs: fixture.samples, medianMs: (sorted[2] + sorted[3]) / 2,
      minMs: sorted[0], maxMs: sorted.at(-1), queriesPerSave: fixture.statements.length, policyWritesPerSave: policyWrites.length };
  });
  assert.equal(measurements[1].policyWritesPerSave, 0, "Unchanged policies must not be written");
  assert.ok(measurements[1].queriesPerSave < measurements[0].queriesPerSave / 5, "Remove at least 80% of round trips on this fixture");
  const plans = [];
  for (const fixture of fixtures) {
    const select = fixture.statements.find(statement => /^select .* from "tool_policies" where /i.test(statement.sql));
    if (select) plans.push({ label: fixture.label, sql: select.sql,
      plan: await client.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${select.sql}`, select.params as never[]) });
  }
  const report = { baselineRevision, treatmentRevision: git("rev-parse", "HEAD"), treatmentDiff: git("diff", "--", servicePath, policyPath),
    postgres: await client.$client`select version(), current_setting('shared_buffers') as shared_buffers`,
    fixture: { actions: 100, askFirst: 99, disabledPolicies: 500, agentsBefore: 3, agentsAfter: 4, warmups: 2, samples: 6, order: "alternating", reset: "restore three-agent selection outside each timed sample" },
    measurements, speedup: measurements[0].medianMs / measurements[1].medianMs,
    correctness: "Complete profile, entries, bindings, and policies match after mapping fixture IDs and excluding generated row IDs and write timestamps. Allowed and Ask first decisions match for the added agent.",
    scope: "Local assembled-service timings with disposable PostgreSQL. Hosted endpoint latency is unverified.",
    plans, statements: fixtures.map(fixture => ({ label: fixture.label, statements: fixture.statements })) };
  if (output) await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, treatmentDiff: undefined, statements: undefined, plans: undefined }, null, 2));
} finally {
  clearInterval(keepAlive);
  await db?.$client.end();
  await database?.cleanup();
  await rm(scratch, { recursive: true, force: true });
}
