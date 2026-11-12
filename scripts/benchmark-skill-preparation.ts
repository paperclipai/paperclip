/** Isolated, repeatable preparation benchmark. Run with pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-skill-preparation.ts. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { companies, companySkills, createDb, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { removeRuntimeSkillCache } from "../server/src/services/runtime-skill-cache.js";
import { companySkillService } from "../server/src/services/company-skills.js";

const child = process.argv.includes("--warm-child");
const home = child ? process.env.PAPERCLIP_HOME! : await fs.mkdtemp(path.join(os.tmpdir(), "skill-preparation-benchmark-"));
process.env.PAPERCLIP_HOME = home;
process.env.PAPERCLIP_INSTANCE_ID = "default";
const database = child ? null : await startEmbeddedPostgresTestDatabase("skill-preparation-benchmark-");
const db = createDb(database?.connectionString ?? process.env.SKILL_BENCH_DATABASE_URL!);
const companyId = child ? process.env.SKILL_BENCH_COMPANY_ID! : randomUUID();
const svc = companySkillService(db);
let upstreamFetches = 0;
let inventoryRefreshes = 0;
let rebuilds = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => { upstreamFetches++; return new Response(`# Fixture\n${String(input)}\n`); };
const originalSelect = db.select.bind(db);
db.select = ((fields?: Record<string, unknown>) => {
  if (fields && Object.keys(fields).length === 1 && fields.id === companies.id) inventoryRefreshes++;
  return originalSelect(fields as never);
}) as typeof db.select;
const originalMkdtemp = fs.mkdtemp;
fs.mkdtemp = ((prefix: string, ...args: unknown[]) => {
  if (String(prefix).includes("__runtime_cache_v1__") && String(prefix).includes(".staging-")) rebuilds++;
  return Reflect.apply(originalMkdtemp, fs, [prefix, ...args]);
}) as typeof fs.mkdtemp;

async function measure(label: string) {
  upstreamFetches = inventoryRefreshes = rebuilds = 0;
  const start = performance.now();
  const entries = await svc.listRuntimeSkillEntries(companyId);
  const durationMs = performance.now() - start;
  const missingEntries = entries.filter((entry) => entry.sourceStatus === "missing").length;
  assert.equal(entries.length, 114);
  assert.equal(missingEntries, 0);
  assert.equal(inventoryRefreshes, 1);
  if (label !== "cold") { assert.equal(upstreamFetches, 0); assert.equal(rebuilds, 0); }
  // Check every synthetic supporting file against its installed revision, outside the timed section.
  const installed = await db.select().from(companySkills);
  for (const skill of installed.filter((skill) => skill.sourceType === "github" || skill.sourceType === "skills_sh")) {
    const entry = entries.find((entry) => entry.key === skill.key)!;
    for (const file of skill.fileInventory) {
      const expected = `# Fixture\nhttps://raw.githubusercontent.com/fixture/skills/${skill.sourceRef}/${skill.slug}/${file.path}\n`;
      assert.equal(await fs.readFile(path.join(entry.source, file.path), "utf8"), expected);
    }
  }
  return { label, durationMs: Math.round(durationMs * 100) / 100, inventoryRefreshes, upstreamFetches, rebuilds, missingEntries, entries: entries.length };
}

try {
  if (child) {
    console.log(JSON.stringify(await measure("warm-new-process")));
  } else {
    await db.insert(companies).values({ id: companyId, name: "Skill benchmark", issuePrefix: "BENCH" });
    const bundled = await svc.listFull(companyId);
    const additional = 114 - bundled.length;
    assert.ok(additional >= 6, "Bundled inventory leaves insufficient room for mixed benchmark fixtures");
    const remoteCount = 33;
    const catalogCount = 21;
    assert.ok(additional > remoteCount + catalogCount, "Bundled inventory leaves no room for local fixtures");
    const filesPerRemote = Math.max(9, Math.ceil(400 / remoteCount));
    for (let index = 0; index < additional; index++) {
      const slug = `fixture-${index}`;
      const sourceType = index < remoteCount ? (index < 28 ? "github" : "skills_sh")
        : index === remoteCount ? "url" : index <= remoteCount + catalogCount ? "catalog" : "local_path";
      const localDir = path.join(home, "instances", "default", "skills", companyId, slug);
      if (sourceType === "local_path" || sourceType === "catalog") {
        await fs.mkdir(localDir, { recursive: true });
        await fs.writeFile(path.join(localDir, "SKILL.md"), `---\nname: ${slug}\ndescription: Benchmark\n---\n# Local\n`);
      }
      await db.insert(companySkills).values({
        id: randomUUID(), companyId, key: `company/${companyId}/${slug}`, slug, name: slug,
        markdown: `# ${slug}`, sourceType, sourceLocator: sourceType === "local_path" || sourceType === "catalog" ? localDir : `https://example.com/${slug}`,
        sourceRef: index < remoteCount ? "a".repeat(40) : null,
        trustLevel: "markdown_only", compatibility: "compatible",
        metadata: { owner: "fixture", repo: "skills", repoSkillDir: slug },
        fileInventory: [{ path: "SKILL.md", kind: "skill" }, ...Array.from({ length: index < remoteCount ? filesPerRemote - 1 : 0 }, (_, file) => ({ path: `references/${file}.md`, kind: "reference" as const }))],
      });
    }
    const samples = [await measure("cold")];
    for (let index = 0; index < 9; index++) samples.push(await measure(`warm-${index + 1}`));
    const childOutput = await new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, ["--import", fileURLToPath(new URL("../server/node_modules/tsx/dist/loader.mjs", import.meta.url)), fileURLToPath(import.meta.url), "--warm-child"], {
        env: { ...process.env, SKILL_BENCH_DATABASE_URL: database!.connectionString, SKILL_BENCH_COMPANY_ID: companyId },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let output = "";
      proc.stdout.on("data", (chunk) => { output += chunk; });
      proc.on("error", reject);
      proc.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`Warm subprocess failed: ${code}`)));
    });
    samples.push(JSON.parse(childOutput.trim().split("\n").at(-1)!));
    const warm = samples.slice(1).map((sample) => sample.durationMs).sort((a, b) => a - b);
    console.log(JSON.stringify({ inventory: 114, materializedRemoteFiles: remoteCount * filesPerRemote,
      warmMedianMs: (warm[4] + warm[5]) / 2, warmMaxMs: warm.at(-1), samples }, null, 2));
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.mkdtemp = originalMkdtemp;
  if (!child) for (const skill of await db.select().from(companySkills)) {
    await removeRuntimeSkillCache(path.join(home, "instances", "default", "skills", companyId), skill.id);
  }
  await db.$client.end();
  await database?.cleanup();
  if (!child) await fs.rm(home, { recursive: true, force: true });
}
