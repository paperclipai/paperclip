import { createDb } from "@paperclipai/db";
import { migrateRunEvidence } from "../src/services/run-evidence-migration.js";
import { isCloudManagedInstance } from "../src/services/cloud-instance.js";
import { cloudRuntimeConfigService } from "../src/services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../src/services/cloud-runtime-config-snapshot.js";

if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL to the intended instance; run with legacy writers drained");
const args = process.argv.slice(2);
const booleans = new Set(["--apply", "--preserve-settled-native-files"]);
const flags = new Set([...booleans, "--company", "--after-run", "--after-trace", "--limit"]);
for (let index = 0; index < args.length; index++) {
  const flag = args[index]!;
  if (!flags.has(flag)) throw new Error(`Unknown migration option: ${flag}`);
  if (!booleans.has(flag) && (!args[++index] || args[index]!.startsWith("--"))) {
    throw new Error(`Missing value for ${flag}`);
  }
}
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const db = createDb(process.env.DATABASE_URL);
try {
  if (isCloudManagedInstance()) {
    const stored = await cloudRuntimeConfigService(db).inspectStored();
    if (!stored) throw new Error("cloud_runtime_configuration_missing");
    setCloudRuntimeConfigSnapshot(stored);
  }
  const result = await migrateRunEvidence(db, {
    apply: args.includes("--apply"),
    companyId: value("--company"),
    afterRunId: value("--after-run"),
    afterTraceId: value("--after-trace"),
    limit: Number(value("--limit") || 50),
    preserveSettledNativeFiles: args.includes("--preserve-settled-native-files"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.items.some((item) => item.state === "blocked")) process.exitCode = 1;
} finally {
  await db.$client.end();
}
