import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { companies, createDb, startEmbeddedPostgresTestDatabase, type Db } from "../../packages/db/src/index.js";
import { resolveGitHubApiCredential } from "../src/services/git-credentials.js";
import { secretService } from "../src/services/secrets.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const baselineRef = process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.split("=")[1];
assert.ok(baselineRef, "Pass --baseline-ref=<pre-fix commit>");
const baselineRevision = git("rev-parse", `${baselineRef}^{commit}`);
const countsOnly = process.argv.includes("--counts-only");
const rounds = countsOnly ? 1 : 7;
const operations = countsOnly ? 1 : 100;
const baselineDir = await mkdtemp(path.join(root, "server/scripts/.github-credentials-baseline-"));
const keyDir = await mkdtemp(path.join(os.tmpdir(), "github-credential-bench-"));
const isolatedEnv = {
  PAPERCLIP_HOME: keyDir,
  PAPERCLIP_CONFIG: path.join(keyDir, "config.json"),
  PAPERCLIP_INSTANCE_ID: "benchmark",
  PAPERCLIP_SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(keyDir, "master.key"),
};
const previousEnv = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);
const modulePath = "server/src/services/git-credentials.ts";
const source = git("show", `${baselineRevision}:${modulePath}`);
const rewritten = source.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) =>
  `from ${JSON.stringify(fileURLToPath(new URL(specifier, pathToFileURL(path.join(root, modulePath)))))}`);
await writeFile(path.join(baselineDir, "git-credentials.ts"), rewritten);
const baseline = await import(pathToFileURL(path.join(baselineDir, "git-credentials.ts")).href) as typeof import("../src/services/git-credentials.js");
let lookups = 0;
function countedDb(db: Db): Db {
  return new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...args: unknown[]) => {
      const builder = target.select(...args as []);
      const from = builder.from.bind(builder);
      builder.from = ((...tables: Parameters<typeof from>) => {
        const query = from(...tables);
        const execute = query.execute.bind(query);
        query.execute = async (...params: Parameters<typeof execute>) => {
          if (/"company_secrets"\."name" (?:=|in)/.test(query.toSQL().sql)) lookups++;
          return execute(...params);
        };
        return query;
      }) as typeof builder.from;
      return builder;
    };
  } });
}
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
const keepAlive = setInterval(() => {}, 1000);
try {
  database = await startEmbeddedPostgresTestDatabase("github-credential-benchmark-");
  const db = createDb(database.connectionString, { maxConnections: 1 });
  const counted = countedDb(db);
  const svc = secretService(db);
  const results = [];
  for (const shape of ["absent", "first", "last"] as const) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Credential benchmark", issuePrefix: `B${companyId.slice(0, 7)}` });
    const secretName = shape === "first" ? "GITHUB_TOKEN" : "PAPERCLIP_GITHUB_TOKEN";
    if (shape !== "absent") await svc.create(companyId, { name: secretName, provider: "local_encrypted", value: "synthetic-benchmark-token" });
    const samples: Record<string, { wallMs: number; processCpuMs: number; lookups: number }[]> = { baseline: [], treatment: [] };
    for (let round = 0; round < rounds; round++) {
      for (const arm of round % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
        lookups = 0;
        const cpu = process.cpuUsage();
        const start = performance.now();
        for (let operation = 0; operation < operations; operation++) {
          const credential = await (arm === "baseline" ? baseline.resolveGitHubApiCredential : resolveGitHubApiCredential)(counted, companyId, { env: {} });
          assert.deepEqual(credential, shape === "absent" ? null : { token: "synthetic-benchmark-token", source: "company_secret", secretName });
        }
        const wallMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        assert.equal(lookups, operations * (arm === "baseline" && shape !== "first" ? 3 : 1));
        if (countsOnly || round >= 2) samples[arm]!.push({ wallMs, processCpuMs: (used.user + used.system) / 1000, lookups });
      }
    }
    results.push({ shape, samples });
  }
  const sourceHashes = Object.fromEntries(await Promise.all([
    modulePath, "server/src/services/secrets.ts", "server/scripts/benchmark-github-api-credentials.ts",
  ].map(async (file) => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
  console.log(JSON.stringify({ baselineRevision, sourceHashes, treatmentRevision: git("rev-parse", "HEAD"), node: process.version, platform: `${process.platform}/${process.arch}`, operationsPerSample: operations, countsOnly, timingsValid: !countsOnly, realBoundary: "exported GitHub API resolver + secret service + local encrypted provider + PostgreSQL; no GitHub HTTP", results }, null, 2));
} finally {
  await database?.cleanup();
  clearInterval(keepAlive);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(keyDir, { recursive: true, force: true });
  await rm(baselineDir, { recursive: true, force: true });
}
