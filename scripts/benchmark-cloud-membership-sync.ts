import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agents, applyPendingMigrations, authUsers, companyMemberships, createDb, startEmbeddedPostgresTestDatabase, type Db,
} from "../packages/db/src/index.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "../server/src/middleware/auth.js";

// All databases, identities and probes are disposable. This never reads DATABASE_URL.
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
const dockerPostgres = process.argv.includes("--docker-postgres=17");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
assert.ok(baselineRef, "Pass an explicit --baseline-ref=<pre-fix commit>");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8", cwd: repoRoot }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim();
const treatmentDiff = execFileSync("git", ["diff", "--", "server/src/middleware/auth.ts"], { encoding: "utf8", cwd: repoRoot });
const keepAlive = setInterval(() => {}, 1_000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let baselineDir: string | undefined;
const clients = new Set<Db>();

async function startDatabase() {
  if (!dockerPostgres) return startEmbeddedPostgresTestDatabase("cloud-membership-benchmark-");
  const container = `paperclip-cloud-membership-${randomUUID()}`;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  docker("run", "--detach", "--rm", "--name", container, "--label", "paperclip.benchmark=cloud-membership",
    "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=paperclip", "--env", "POSTGRES_PASSWORD=paperclip",
    "--env", "POSTGRES_DB=paperclip", "postgres:17");
  const cleanup = async () => { docker("rm", "--force", container); };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        docker("exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "paperclip");
        ready = true;
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, "Disposable PostgreSQL did not become ready");
    const port = docker("port", container, "5432/tcp").split(":").at(-1);
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);
    return { connectionString, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

try {
  database = await startDatabase();
  function freshDb() {
    const db = createDb(database!.connectionString);
    clients.add(db);
    return db;
  }
  const db = freshDb();
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".cloud-auth-baseline-"));
  const original = new URL("../server/src/middleware/auth.ts", import.meta.url);
  const source = execFileSync("git", ["show", `${baselineRevision}:server/src/middleware/auth.ts`], { encoding: "utf8" });
  const rewritten = source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, original)))}`);
  const baselineFile = path.join(baselineDir, "auth.ts");
  await fs.writeFile(baselineFile, rewritten);
  const baseline = (await import(pathToFileURL(baselineFile).href)).resolveCloudTenantActor as typeof resolveCloudTenantActor;

  process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "synthetic-membership-benchmark";
  process.env.PAPERCLIP_MANAGED_CONFIG = JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "synthetic", features: { enableOwnerInstanceAdmin: false }, plugins: { autoInstall: [] } });
  const userId = randomUUID();
  const headers = cloudActorHeaderSourceFromHeaders({
    "x-paperclip-cloud-tenant-token": "synthetic-membership-benchmark",
    "x-paperclip-cloud-user-id": userId,
    "x-paperclip-cloud-user-email": `${userId}@example.test`,
    "x-paperclip-cloud-stack-id": `stack-${randomUUID()}`,
    "x-paperclip-cloud-stack-role": "owner",
  });
  const seeded = await baseline(db, headers);
  const companyId = seeded!.companyIds![0]!;
  await db.insert(agents).values({ companyId, name: "Synthetic observer", adapterType: "codex_local" });
  await db.$client.unsafe("CREATE TABLE cloud_sync_probe (relation text, operation text)");
  await db.$client.unsafe(`CREATE FUNCTION cloud_sync_probe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO cloud_sync_probe VALUES (TG_TABLE_NAME, TG_OP); RETURN NEW; END $$`);
  await db.$client.unsafe('CREATE TRIGGER cloud_sync_probe AFTER INSERT OR UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION cloud_sync_probe()');
  await db.$client.unsafe("CREATE TRIGGER cloud_sync_probe AFTER INSERT OR UPDATE ON company_memberships FOR EACH ROW EXECUTE FUNCTION cloud_sync_probe()");
  const [version] = await db.$client.unsafe("SELECT version(), current_setting('max_connections') AS max_connections");

  function observe(client: Db) {
    const statements: Array<{ table: string; sql: string; params: unknown[]; returnedRows: number }> = [];
    const observed = new Proxy(client, { get(target, key) {
      if (key !== "insert") return Reflect.get(target, key);
      return (...args: Parameters<Db["insert"]>) => {
        const builder = target.insert(...args);
        const values = builder.values.bind(builder);
        builder.values = ((...input: Parameters<typeof values>) => {
          const query = values(...input);
          const execute = query.execute.bind(query);
          query.execute = (async () => {
            const result = await execute();
            if (args[0] === authUsers || args[0] === companyMemberships) {
              statements.push({ table: args[0] === authUsers ? "user" : "company_memberships", ...query.toSQL(), returnedRows: result.length });
            }
            return result;
          }) as typeof query.execute;
          return query;
        }) as typeof builder.values;
        return builder;
      };
    }});
    return { db: observed, statements };
  }

  const burstSize = 20;
  async function sample(resolve: typeof resolveCloudTenantActor) {
    const client = freshDb();
    const observed = observe(client); // same fixture; a fresh debounce scope
    try {
      await db.$client.unsafe("TRUNCATE cloud_sync_probe");
      const start = performance.now();
      const actors = await Promise.all(Array.from({ length: burstSize }, () => resolve(observed.db, headers)));
      const durationMs = performance.now() - start;
      for (const actor of actors) assert.deepEqual(actor, seeded);
      const writes = await db.$client.unsafe("SELECT relation, operation, count(*)::int AS writes FROM cloud_sync_probe GROUP BY relation, operation ORDER BY relation, operation");
      return { durationMs, statements: observed.statements, writes: [...writes], equalActors: actors.length };
    } finally {
      await client.$client.end({ timeout: 0 });
      clients.delete(client);
    }
  }
  const results: { before: Awaited<ReturnType<typeof sample>>[]; after: Awaited<ReturnType<typeof sample>>[] } = { before: [], after: [] };
  // Alternate order; first two pairs are warmups, then five measured pairs.
  for (let index = 0; index < 7; index += 1) {
    const order = index % 2 === 0 ? ["before", "after"] as const : ["after", "before"] as const;
    for (const variant of order) {
      const result = await sample(variant === "before" ? baseline : resolveCloudTenantActor);
      if (index >= 2) results[variant].push(result);
    }
  }
  for (const before of results.before) {
    assert.equal(before.statements.filter(statement => statement.table === "company_memberships").length, burstSize);
    assert.deepEqual(before.writes, [{ relation: "company_memberships", operation: "UPDATE", writes: burstSize }, { relation: "user", operation: "UPDATE", writes: burstSize }]);
  }
  for (const after of results.after) {
    assert.equal(after.statements.filter(statement => statement.table === "company_memberships").length, 1);
    assert.deepEqual(after.writes, []);
    assert.equal(after.statements.find(statement => statement.table === "company_memberships")!.returnedRows, 0);
  }
  function summarize(samples: typeof results.before) {
    const timings = samples.map(sample => sample.durationMs).sort((left, right) => left - right);
    return { medianMs: timings[2], rangeMs: [timings[0], timings.at(-1)], samplesMs: samples.map(sample => sample.durationMs),
      membershipStatementsPerBurst: samples[0].statements.filter(statement => statement.table === "company_memberships").length,
      tupleWritesPerBurst: samples[0].writes, equalActorsPerBurst: burstSize, statements: samples[0].statements };
  }
  const before = summarize(results.before), after = summarize(results.after);
  const treatmentSources = await Promise.all(["server/src/middleware/auth.ts", "server/src/middleware/cloud-tenant-sync.ts"].map(async file => ({
    file, sha256: createHash("sha256").update(await fs.readFile(new URL(`../${file}`, import.meta.url))).digest("hex"),
  })));
  console.log(JSON.stringify({ baselineRevision, treatmentRevision, treatmentHasUncommittedChanges: treatmentDiff.length > 0,
    treatmentSources, version, fixture: { users: 1, memberships: 1, agents: 1, burstSize, warmupPairs: 2, measuredPairs: 5 },
    scope: "Local real-service burst including SQL and authority reads; excludes HTTP/network. No production latency claim.",
    before, after, speedup: before.medianMs / after.medianMs }, null, 2));
} finally {
  try {
    await Promise.all([...clients].map(db => db.$client.end({ timeout: 0 })));
    await database?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
