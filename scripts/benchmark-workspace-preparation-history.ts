/**
 * Disposable synthetic PostgreSQL + real Git proof. Never accepts DATABASE_URL.
 * pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-preparation-history.ts \
 *   --baseline-ref=df80616d98119cbf5abd40549794d9980a5fabf6 --output=/tmp/workspace-history.json
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import {
  addReadyWorkspaceHistoryRepository, createWorkspacePreparationHistoryFixture,
} from "../server/src/__tests__/helpers/workspace-preparation-history-fixture.js";
import * as treatment from "../server/src/services/execution-workspace-repositories.js";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const { drizzle } = require("drizzle-orm/postgres-js");
const argument = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baselineRef = argument("baseline-ref") ?? "df80616d98119cbf5abd40549794d9980a5fabf6";
const baselineRevision = execFileSync("git", ["rev-parse", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const samples = Number(argument("samples") ?? 5), warmups = Number(argument("warmups") ?? 2);
assert.ok(Number.isInteger(samples) && samples >= 5, "At least five measured samples are required");
assert.ok(Number.isInteger(warmups) && warmups >= 2, "At least two warmups are required");
const selectedSizes = (argument("sizes") ?? "small,stress").split(",");
assert.ok(selectedSizes.length && selectedSizes.every(size => size === "small" || size === "stress"));
process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const originalSourceRoot = path.join(repositoryRoot, "server", "src");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-history-"));
const baselineDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-history-baseline-"));
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;

type Fixture = Awaited<ReturnType<typeof createWorkspacePreparationHistoryFixture>>;
type Observation = {
  ms: number; queries: string[]; queryFingerprints: string[]; realpaths: string[];
  retiredTableQueries: number; historicalReaderQueries: number; companyInventories: number;
};

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(path.join(directory, entry.name))
    : Promise.resolve([path.join(directory, entry.name)])))).flat();
}

async function loadBaseline() {
  // Snapshot the complete relative server dependency graph. Holding just the top-level old
  // service while importing a changed authorization helper would invalidate the comparison.
  const archive = execFileSync("git", ["archive", "--format=tar", baselineRevision, "server/src", "server/package.json"], {
    cwd: repositoryRoot, maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", baselineDirectory], { input: archive });
  // Resolve unchanged workspace dependencies without writing a checkout or package-manager files.
  await fs.symlink(path.join(repositoryRoot, "server", "node_modules"), path.join(baselineDirectory, "node_modules"), "dir");
  const snapshotSource = path.join(baselineDirectory, "server", "src");
  for (const file of await sourceFiles(snapshotSource)) {
    if (!/\.[cm]?[jt]s$/.test(file)) continue;
    const original = path.join(originalSourceRoot, path.relative(snapshotSource, file));
    const source = await fs.readFile(file, "utf8");
    const rewritten = source.replace(/((?:from\s*|import\s*\(|import\s*|new\s+URL\s*\(\s*)["'])(\.{1,2}\/[^"']+)(["'])/g,
      (match, prefix: string, specifier: string, suffix: string) => {
        const destination = path.resolve(path.dirname(original), specifier);
        return destination.startsWith(`${originalSourceRoot}${path.sep}`) ? match : `${prefix}${destination}${suffix}`;
      });
    if (source !== rewritten) await fs.writeFile(file, rewritten);
  }
  return import(pathToFileURL(path.join(snapshotSource, "services", "execution-workspace-repositories.ts")).href);
}

async function observe(action: (recorded: Db) => Promise<unknown>,
  prepare?: (recorded: Db) => Promise<() => Promise<unknown>>): Promise<Observation> {
  assert.ok(db);
  const queries: string[] = [], realpaths: string[] = [];
  const recorded = drizzle(db.$client, { schema: db._.fullSchema,
    logger: { logQuery: (query: string) => queries.push(query) } }) as Db;
  const actualRealpath = fs.realpath;
  fs.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
    realpaths.push(String(args[0]));
    return actualRealpath(...args);
  }) as typeof fs.realpath;
  let start = performance.now();
  try {
    const prepared = prepare ? await prepare(recorded) : undefined;
    queries.length = 0; realpaths.length = 0;
    start = performance.now();
    if (prepared) await prepared(); else await action(recorded);
  }
  finally { fs.realpath = actualRealpath; }
  return { ms: performance.now() - start, queries, realpaths,
    queryFingerprints: [...new Set(queries.map(query => createHash("sha256").update(query).digest("hex")))],
    retiredTableQueries: queries.filter(query => /execution_workspace_repository_(?:access|roots)/.test(query)).length,
    historicalReaderQueries: queries.filter(query => /from "heartbeat_runs"/.test(query) && /\bin\s*\(/i.test(query)).length,
    companyInventories: queries.filter(query => /from "(?:execution_workspaces|project_workspaces)"/.test(query)
      && !/"(?:execution_workspaces|project_workspaces)"\."id"\s*=/.test(query)).length,
  };
}

function stats(observations: Observation[]) {
  const ordered = observations.map(item => item.ms).sort((a, b) => a - b);
  return { samplesMs: observations.map(item => item.ms), medianMs: ordered[Math.floor(ordered.length / 2)],
    minMs: ordered[0], maxMs: ordered.at(-1), queryCounts: observations.map(item => item.queries.length),
    realpathCounts: observations.map(item => item.realpaths.length),
    retiredTableQueries: observations.map(item => item.retiredTableQueries),
    historicalReaderQueries: observations.map(item => item.historicalReaderQueries),
    companyInventories: observations.map(item => item.companyInventories),
    realpaths: [...new Set(observations.flatMap(item => item.realpaths))],
    sql: [...new Set(observations.flatMap(item => item.queries))],
    queryFingerprints: [...new Set(observations.flatMap(item => item.queryFingerprints))] };
}

try {
  const baseline = await loadBaseline();
  database = await startEmbeddedPostgresTestDatabase("workspace-preparation-history-benchmark-");
  db = createDb(database.connectionString, { maxConnections: 5 });
  await db.$client.unsafe("set statement_timeout = '120s'");
  const results: Array<{ size: string; phase: string; baseline: ReturnType<typeof stats>; treatment: ReturnType<typeof stats> }> = [];
  const fixtureSummary = [];
  const sqlPlans: Array<{ size: string; phase: string; sql: string; plan: unknown }> = [];
  for (const size of selectedSizes) {
    const config = size === "stress" ? { workspaces: 8500, sharedRoots: 4800, sources: 5300, readers: 50 }
      : { workspaces: 8, sharedRoots: 5, sources: 6, readers: 2 };
    const fixtures: Fixture[] = [];
    for (const variant of ["baseline", "treatment"]) {
      console.error(`Seeding ${size} ${variant}: ${config.workspaces} historical workspaces`);
      fixtures.push(await createWorkspacePreparationHistoryFixture(db, path.join(root, `${size}-${variant}`), config));
    }
    fixtureSummary.push({ size, ...config, principals: 8, crossCompanyDecoys: 2 });
    const modules = [baseline, treatment];
    const phase = async (name: string, build: (module: any, recorded: Db, fixture: Fixture) => Promise<unknown>,
      prepare?: (module: any, recorded: Db, fixture: Fixture) => Promise<() => Promise<unknown>>) => {
      const observations: Observation[][] = [[], []];
      for (let iteration = 0; iteration < warmups + samples; iteration++) {
        for (const variant of iteration % 2 ? [1, 0] : [0, 1]) {
          const fixture = fixtures[variant];
          const observation = await observe(recorded => build(modules[variant], recorded, fixture),
            prepare ? recorded => prepare(modules[variant], recorded, fixture) : undefined);
          if (variant === 1) {
            assert.equal(observation.retiredTableQueries, 0, `${name} queried retired root tables`);
            assert.equal(observation.historicalReaderQueries, 0, `${name} loaded historical readers`);
            assert.equal(observation.companyInventories, 0, `${name} inventoried company workspaces`);
            assert.ok(observation.realpaths.every(cwd => cwd === fixture.cwd || cwd.startsWith(`${fixture.cwd}${path.sep}`)),
              `${name} canonicalized an unrelated path`);
          }
          if (iteration >= warmups) observations[variant].push(observation);
        }
        console.error(`${size} ${name}: ${iteration + 1}/${warmups + samples}`);
      }
      results.push({ size, phase: name, baseline: stats(observations[0]), treatment: stats(observations[1]) });
    };
    await phase("initial-local-source-guard", async (module, recorded, fixture) => {
      const service = module.executionWorkspaceRepositoryService(recorded);
      const method = service.prepareConfiguredRepositoryCopy ?? service.prepareConfiguredRepositorySource;
      assert.equal(typeof await method({ ...fixture.input, sourceCwd: fixture.cwd }), "function");
    });
    await phase("before-copy-revalidation", async () => {}, async (module, recorded, fixture) => {
      const service = module.executionWorkspaceRepositoryService(recorded);
      return (service.prepareConfiguredRepositoryCopy ?? service.prepareConfiguredRepositorySource)
        ({ ...fixture.input, sourceCwd: fixture.cwd });
    });
    await phase("publication-guard", async (module, recorded, fixture) => {
      const service = module.executionWorkspaceRepositoryService(recorded);
      await (service.assertPublicationAllowed ?? service.guardForPublication)(fixture.input);
    });
    await phase("empty-repository-admission", async (module, recorded, fixture) => {
      assert.deepEqual(await module.executionWorkspaceRepositoryService(recorded).prepareForAdmission(fixture.input), []);
    });
    await phase("recovery-binding", async (module, recorded, fixture) => {
      const service = module.executionWorkspaceRepositoryService(recorded);
      await (service.assertRecoveryBinding ?? service.reserveForRecovery)(fixture.input);
    });
    const repositories = [];
    for (const fixture of fixtures) repositories.push(await addReadyWorkspaceHistoryRepository(db, fixture, { matchingHistoricalReceipts: true }));
    await db.$client.unsafe("ANALYZE");
    await phase("ready-public-repository-admission-and-warm-reuse", async (module, recorded, fixture) => {
      const rows = await module.executionWorkspaceRepositoryService(recorded).prepareForAdmission(fixture.input);
      const expected = repositories[fixtures.indexOf(fixture)];
      assert.deepEqual(rows, [{ id: expected.row.id, cwd: expected.checkout, repoUrl: expected.row.repoUrl,
        relativePath: expected.row.relativePath, pinnedCommit: fixture.pin, branchName: "main" }]);
      assert.equal(await fs.readFile(path.join(rows[0].cwd, "result.txt"), "utf8"), "Synthetic task workspace\n");
    });
    // Capture actual baseline permission SQL with its original parameters outside timing samples.
    const captures: Array<{ query: string; params: unknown[] }> = [];
    const recorded = drizzle(db.$client, { schema: db._.fullSchema,
      logger: { logQuery: (query: string, params: unknown[]) => captures.push({ query, params }) } }) as Db;
    await baseline.executionWorkspaceRepositoryService(recorded).guardForPublication(fixtures[0].input);
    const expensive = captures.find(item => item.query.includes('from "execution_workspaces"') && item.query.includes("jsonb_object_keys"));
    if (expensive) {
      const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${expensive.query}`, expensive.params as never[]);
      sqlPlans.push({ size, phase: "baseline-workspace-disclosure-query", sql: expensive.query, plan: plan["QUERY PLAN"] });
    }
  }
  if (selectedSizes.includes("small") && selectedSizes.includes("stress")) {
    for (const small of results.filter(result => result.size === "small")) {
      const stress = results.find(result => result.size === "stress" && result.phase === small.phase)!;
      assert.deepEqual(stress.treatment.queryCounts, small.treatment.queryCounts, `${small.phase}: SQL count grew with peer history`);
      assert.deepEqual(stress.treatment.realpathCounts, small.treatment.realpathCounts, `${small.phase}: canonicalization count grew with peer history`);
    }
  }
  const guardPhases = results.filter(result => result.size === "stress" && result.phase !== "ready-public-repository-admission-and-warm-reuse");
  const baselineGuardMs = guardPhases.reduce((sum, result) => sum + result.baseline.medianMs, 0);
  const treatmentGuardMs = guardPhases.reduce((sum, result) => sum + result.treatment.medianMs, 0);
  const improvementPercent = guardPhases.length ? (1 - treatmentGuardMs / baselineGuardMs) * 100 : null;
  if (improvementPercent !== null) assert.ok(improvementPercent >= 90, `Guard improvement ${improvementPercent.toFixed(2)}% missed 90% target`);
  const report = { baselineRevision, treatmentRevision,
    treatmentWorkingDiff: execFileSync("git", ["diff", "--stat"], { encoding: "utf8" }),
    node: process.version, platform: process.platform, arch: process.arch,
    postgres: (await db.$client.unsafe("select version()"))[0].version,
    databaseSettings: await db.$client.unsafe("select current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem"),
    warmups, samples, fixtureSummary,
    baselineIsolation: "Complete pinned server/src snapshot; current workspace package dependencies and schema held constant",
    contract: "Both versions succeed on granted synthetic history; privacy-denial behavior changes are covered by the integration suite",
    timingScope: "Actual repository service guards/admission with ready local Git receipts; excludes network acquisition, provider startup, and copying",
    performance: { baselineGuardMs, treatmentGuardMs, improvementPercent },
    results, sqlPlans };
  const output = JSON.stringify(report, null, 2);
  if (argument("output")) await fs.writeFile(path.resolve(argument("output")!), `${output}\n`);
  console.log(output);
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(baselineDirectory, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
