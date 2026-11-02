import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPendingMigrations, chatActions, createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "../packages/db/src/response-capture.js";
import { createGitHubWebhookIngress } from "../server/src/services/chat-channels/github/webhook-ingress.js";
import { captureIngressQueries, cleanupIngressFixture, githubIngressFixture, type CapturedQuery } from "../server/src/__tests__/helpers/github-webhook-ingress.js";
import { resolveExternalTestDatabaseUrl } from "../server/src/__tests__/helpers/external-test-database.js";
import { PROVIDER_EFFECT_STALE_MS } from "../server/src/services/chat-action-work.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const ref = process.argv.find(argument => argument.startsWith("--baseline-ref="))?.slice(15);
assert.ok(ref, "Pass --baseline-ref=<verified pre-fix commit>");
const baselineRevision = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourcePath = "server/src/services/chat-channels/github/webhook-ingress.ts";
const uncommittedChanges = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
const treatmentSourceSha256 = createHash("sha256").update(readFileSync(new URL(`../${sourcePath}`, import.meta.url))).digest("hex");
const directory = await fs.mkdtemp(path.join(root, "server/scripts/.github-ingress-baseline-"));
const baselinePath = path.join(directory, "webhook-ingress.ts");
const source = execFileSync("git", ["show", `${baselineRevision}:${sourcePath}`], { cwd: root, encoding: "utf8" });
// This PR changes no imported helper. Keep dependency code and database settings
// identical and load only the actual pre-fix service from the pinned commit.
await fs.writeFile(baselinePath, source.replace(/(from\s+|import\()(["'])(\.{1,2}\/[^"']+)\2/g,
  (_match, prefix: string, quote: string, specifier: string) => `${prefix}${quote}${path.resolve(root, path.dirname(sourcePath), specifier)}${quote}`));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
const keepAlive = setInterval(() => {}, 1000);
try {
  const baseline = (await import(pathToFileURL(baselinePath).href)).createGitHubWebhookIngress as typeof createGitHubWebhookIngress;
  const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TEST_DATABASE_URL");
  if (!externalUrl) database = await startEmbeddedPostgresTestDatabase("github-ingress-benchmark-");
  else await applyPendingMigrations(externalUrl);
  db = createDb(externalUrl ?? database!.connectionString);
  const queries: CapturedQuery[] = [];
  captureIngressQueries(db, queries);
  const f = await githubIngressFixture(db);
  const factories = { baseline, treatment: createGitHubWebhookIngress };
  const now = Date.now();
  const scenarios = [
    { name: "received", status: "received", result: null, updatedAt: new Date(now) },
    { name: "due-retry", status: "failed", result: { attempts: 2, retryable: true, retryAt: new Date(0).toISOString() }, updatedAt: new Date(now) },
    { name: "stale-processing", status: "processing", result: { attempts: 2 }, updatedAt: new Date(now - PROVIDER_EFFECT_STALE_MS - 60_000) },
    { name: "future-retry", status: "failed", result: { attempts: 2, retryable: true, retryAt: new Date(now + 3_600_000).toISOString() }, updatedAt: new Date(now) },
    { name: "fresh-processing", status: "processing", result: { attempts: 2 }, updatedAt: new Date(now) },
    { name: "processed", status: "processed", result: { attempts: 1, retryable: false }, updatedAt: new Date(now) },
  ];
  const results = [];
  for (const scenario of scenarios) {
    const samples: Record<string, number[]> = { baseline: [], treatment: [] };
    const contracts = new Map<string, unknown>();
    const measurements: Record<string, unknown> = {};
    for (let iteration = 0; iteration < 12; iteration++) {
      for (const name of iteration % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
        const action = await f.insertAction(scenario);
        const service = factories[name](db, f.options);
        queries.length = 0;
        f.calls.length = 0;
        const events: Array<Record<string, unknown>> = [], timestamp = Date.now();
        const capture = iteration === 11 ? createDatabaseResponseCapture({ start: timestamp - 1, end: timestamp + 59_000 }, event => events.push(event)) : undefined;
        if (capture) installDatabaseResponseCapture(db, { chatActions }, capture);
        const start = performance.now();
        const response = await service.processGitHubWebhookIngress(action.id);
        const elapsed = performance.now() - start;
        capture?.flush();
        const executed = [...queries];
        if (iteration >= 2) samples[name].push(elapsed);
        const settled = await f.readAction(action.id);
        const { id: _id, providerActionId: _providerActionId, createdAt: _createdAt, updatedAt: _updatedAt, ...state } = settled;
        const contract = { response: response ? { status: response.status, body: await response.text() } : null, state, calls: [...f.calls] };
        if (iteration === 0) contracts.set(name, contract);
        else assert.deepEqual(contract, contracts.get(name), `${scenario.name}/${name}: repeated service output`);
        if (iteration === 11) {
          const candidate = executed.find(query => query.sql.startsWith("select ") && query.sql.includes('from "chat_actions"'));
          assert.ok(candidate, "Capture the initial query generated by the real service");
          await db.$client.unsafe("update chat_actions set status=$2,result=$3::jsonb,payload=$4::jsonb,updated_at=$5 where id=$1::uuid", [action.id, scenario.status, JSON.stringify(scenario.result), JSON.stringify(f.payload), scenario.updatedAt.toISOString()]);
          const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate.sql}`, candidate.params as never[]);
          const positionalRows = await db.$client.unsafe(candidate.sql, candidate.params as never[]).values();
          measurements[name] = { queries: executed, initialQueryPlan: plan["QUERY PLAN"], initialReadJsonBytes: Buffer.byteLength(JSON.stringify(positionalRows)),
            responseValueBytes: events.find(event => event.event === "paperclip.db_response_capture.summary.v1")?.responseValueBytes,
            captureEvents: events };
        }
      }
    }
    assert.deepEqual(contracts.get("treatment"), contracts.get("baseline"), `${scenario.name}: complete service response, durable state, and replay request equality`);
    for (const name of ["baseline", "treatment"]) {
      const sorted = [...samples[name]!].sort((a, b) => a - b);
      measurements[name] = { ...measurements[name] as object, samplesMs: samples[name], medianMs: (sorted[4]! + sorted[5]!) / 2, minMs: sorted[0], maxMs: sorted[9] };
    }
    const before = measurements.baseline as { responseValueBytes: number };
    const after = measurements.treatment as { responseValueBytes: number };
    assert.ok(after.responseValueBytes < before.responseValueBytes * (scenario.name === "received" || scenario.name === "due-retry" || scenario.name === "stale-processing" ? 0.51 : 0.01),
      `${scenario.name}: successful claims must halve response values; skipped claims must eliminate the body`);
    results.push({ scenario: scenario.name, completeContractEqual: true, measurements });
  }
  await cleanupIngressFixture(db, f.companyId);
  const [version] = await db.$client.unsafe("select version() as version");
  const settings = await db.$client.unsafe("select name,setting,unit from pg_settings where name in ('shared_buffers','work_mem','jit') order by name");
  assert.equal(createHash("sha256").update(readFileSync(new URL(`../${sourcePath}`, import.meta.url))).digest("hex"), treatmentSourceSha256,
    "Treatment source must remain unchanged during the benchmark");
  console.log(JSON.stringify({ baselineRevision, treatmentRevision, sourcePath, treatmentSourceSha256, uncommittedChanges,
    note: "Synthetic local service timings; provider calls are captured locally. Response-value byte estimates exclude PG protocol/TLS overhead and JSONB whitespace. No hosted service or database was changed.",
    node: process.version, postgres: version.version, settings, bodyBytes: Buffer.byteLength(f.payload.body), results }, null, 2));
} finally {
  await db?.$client.end({ timeout: 0 });
  await database?.cleanup();
  await fs.rm(directory, { recursive: true, force: true });
  clearInterval(keepAlive);
}
