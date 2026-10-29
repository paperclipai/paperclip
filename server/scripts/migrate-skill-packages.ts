/** Run from the server package with its configured storage and DATABASE_URL. */
import { createDb } from "@paperclipai/db";
import { skillPackageMaintenance } from "../src/services/skill-package-maintenance.js";

const value = (flag: string) => process.argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
const phase = value("--phase") ?? "snapshots";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must explicitly select the database to migrate");
const limit = Number(value("--limit") ?? 10);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be between 1 and 50");
const db = createDb(url, { maxConnections: 2 });
try {
  const service = skillPackageMaintenance(db);
  const actions = { snapshots: service.migrateSnapshots, versions: service.migrateVersions,
    orphans: service.collectOrphans, deletions: service.deleteObjects };
  const action = actions[phase as keyof typeof actions];
  if (!action) throw new Error("--phase must be snapshots, versions, orphans, or deletions");
  const apply = process.argv.includes("--apply");
  const result = await action({ apply, clearLegacy: process.argv.includes("--clear-legacy"), limit, after: value("--after"), companyId: value("--company") });
  console.log(JSON.stringify({ phase, apply, ...result }));
} finally { await db.$client.end({ timeout: 1 }); }
