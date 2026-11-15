import assert from "node:assert/strict";
import { createDb, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../src/__tests__/helpers/embedded-postgres.js";
import { createToolProfileService } from "../src/services/tool-access/profiles/service.js";
import { createConnectionProfileConfigurationFixture, legacyConnectionConfiguration } from "../src/__tests__/helpers/connection-profile-configuration-fixture.js";

const repeat = Number(process.argv[2] ?? 5);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("Positive repeat count required");
const database = await startEmbeddedPostgresTestDatabase("connection-profile-config-benchmark-");
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
  const f = await createConnectionProfileConfigurationFixture(db);
  const service = createToolProfileService(measuredDb, () => new Date("2026-02-01T00:00:00Z"));
  const invoke = async (label: "before" | "after") => {
    if (label === "before") {
      const profiles = await service.listProfiles(f.company.id);
      return { profiles, selected: legacyConnectionConfiguration(profiles, f.connection.id) };
    }
    const profiles = await service.listConnectionProfileConfiguration(f.company.id, f.connection.id, async rows => rows);
    return { profiles, selected: profiles };
  };
  const baseline = await invoke("before"), treatment = await invoke("after");
  assert.deepStrictEqual(treatment.selected, baseline.selected);
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, fixture: {
    profiles: baseline.profiles.length, rules: baseline.profiles.reduce((n, p) => n + p.entries.length, 0),
    activeTools: 1900, removedTools: 695, agents: 12, selectedProfiles: treatment.profiles.length,
    selectedRules: treatment.profiles.reduce((n, p) => n + p.entries.length, 0),
  }, equality: "full ordered selected configuration", scope: "real PostgreSQL service + actual response JSON; identity filter, excludes HTTP/auth" }));
  for (let round = 0; round < repeat; round++) {
    for (const label of round % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
      global.gc?.(); queries = 0; rows = 0;
      const start = performance.now(), cpu = process.cpuUsage();
      const result = await invoke(label);
      const serviceMs = performance.now() - start, used = process.cpuUsage(cpu);
      const serializeStart = performance.now(), serializeCpu = process.cpuUsage();
      const json = JSON.stringify({ profiles: result.profiles });
      const serializationMs = performance.now() - serializeStart, serializeUsed = process.cpuUsage(serializeCpu);
      assert.deepStrictEqual(result.selected, baseline.selected);
      console.log(JSON.stringify({ round, label, serviceMs, cpuMs: (used.user + used.system) / 1000, queries, rows,
        jsonBytes: Buffer.byteLength(json), serializationMs, serializationCpuMs: (serializeUsed.user + serializeUsed.system) / 1000,
        forcedGc: Boolean(global.gc) }));
    }
  }
} finally { await db.$client.end({ timeout: 1 }); await database.cleanup(); }
