import { createDb } from "@paperclipai/db";
import { migrateRunEvidence } from "../src/services/run-evidence-migration.js";

if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL to the intended instance; run with legacy writers drained");
const args = process.argv.slice(2);
const flags = new Set(["--apply", "--company", "--after-run", "--after-trace", "--limit"]);
for (let index = 0; index < args.length; index++) {
  const flag = args[index]!;
  if (!flags.has(flag)) throw new Error(`Unknown migration option: ${flag}`);
  if (flag !== "--apply" && (!args[++index] || args[index]!.startsWith("--"))) {
    throw new Error(`Missing value for ${flag}`);
  }
}
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const db = createDb(process.env.DATABASE_URL);
try {
  const result = await migrateRunEvidence(db, {
    apply: args.includes("--apply"),
    companyId: value("--company"),
    afterRunId: value("--after-run"),
    afterTraceId: value("--after-trace"),
    limit: Number(value("--limit") || 50),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.items.some((item) => item.state === "blocked")) process.exitCode = 1;
} finally {
  await db.$client.end();
}
