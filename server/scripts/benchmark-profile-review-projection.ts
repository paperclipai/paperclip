import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { createDb, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../src/__tests__/helpers/embedded-postgres.js";
import { createToolProfileService } from "../src/services/tool-access/profiles/service.js";
import { createToolAppAttention } from "../src/services/tool-access/catalog/attention.js";
import { createProfileProjectionFixture } from "../src/__tests__/helpers/tool-profile-projection-fixture.js";
const option = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; };
const baselineProfiles = option("--baseline-profiles", ""), baselineAttention = option("--baseline-attention", "");
if (!baselineProfiles || !baselineAttention) throw new Error("--baseline-profiles and --baseline-attention modules required");
const beforeProfiles = (await import(pathToFileURL(baselineProfiles).href)).createToolProfileService as typeof createToolProfileService;
const beforeAttention = (await import(pathToFileURL(baselineAttention).href)).createToolAppAttention as typeof createToolAppAttention;
const profiles = Number(option("--profiles", "200")), repeats = Number(option("--repeat", "5"));
if (!Number.isInteger(profiles) || profiles < 2 || !Number.isInteger(repeats) || repeats < 1) throw new Error("Positive fixture counts required");
const database = await startEmbeddedPostgresTestDatabase("profile-review-projection-");
const db = createDb(database.connectionString, { maxConnections: 1 });
let queries = 0, rows = 0;
const measuredDb = new Proxy(db, { get(target, key) {
  if (key !== "select") return Reflect.get(target, key);
  return (...fields: Parameters<Db["select"]>) => {
    const builder = target.select(...fields), from = builder.from.bind(builder);
    builder.from = ((...args: Parameters<typeof from>) => {
      const selection = from(...args), execute = selection.execute.bind(selection);
      selection.execute = async () => { const result = await execute(); queries++; rows += result.length; return result; };
      return selection;
    }) as typeof builder.from;
    return builder;
  };
} });
try {
  const fixture = await createProfileProjectionFixture(db, { profiles });
  const now = () => new Date("2026-02-01T00:00:00Z");
  const implementations = {
    before: { profiles: beforeProfiles(measuredDb, now), attention: beforeAttention(measuredDb, now) },
    after: { profiles: createToolProfileService(measuredDb, now), attention: createToolAppAttention(measuredDb, now) },
  };
  const invoke = async (label: keyof typeof implementations) => {
    const service = implementations[label];
    return { profiles: await service.profiles.listProfiles(fixture.company.id), attention: await service.attention(fixture.company.id) };
  };
  const baseline = await invoke("before"), treatment = await invoke("after");
  assert.ok(isDeepStrictEqual(baseline, treatment), "Complete profile and attention results must match baseline");
  console.log(JSON.stringify({ fixture: { profiles, tools: 1900, meanRulesPerProfile: 380, ruleCounts: [65, 695], removedTools: 695, agents: 12, staleReferenceProfiles: Math.floor(profiles / 2) }, equality: true, profilePendingCounts: [...new Set(treatment.profiles.map(p => p.newToolsPendingCount))] }));
  for (let round = 0; round < repeats; round++) {
    for (const label of round % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
      global.gc?.(); queries = 0; rows = 0;
      const start = performance.now(), cpu = process.cpuUsage();
      const result = await invoke(label);
      const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
      assert.equal(result.profiles.length, profiles);
      console.log(JSON.stringify({ round, label, elapsedMs, cpuMs: (used.user + used.system) / 1000, queries, rows, profiles, forcedGc: Boolean(global.gc) }));
    }
  }
} finally { await db.$client.end({ timeout: 1 }); await database.cleanup(); }
