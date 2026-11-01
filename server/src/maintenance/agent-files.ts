import { closeRegisteredClients, createDb } from "@paperclipai/db";
import { loadStorageConfig } from "../storage/config.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import { createStorageService } from "../storage/service.js";
import { collectAgentFileObjects, migrateAgentFiles } from "../services/agent-file-maintenance.js";
import { cloudRuntimeConfigService } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { loadConfig } from "../config.js";
import { assertEphemeralServerConfig, readEphemeralServerDataEligibility } from "../services/ephemeral-server-contract.js";

const value = (flag: string) => process.argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must explicitly select the database");
const db = createDb(url, { maxConnections: 2 });
try {
  if (isCloudManagedInstance()) {
    const config = await cloudRuntimeConfigService(db).inspectStored();
    if (!config) throw new Error("Initialize Cloud runtime configuration before agent file maintenance");
    setCloudRuntimeConfigSnapshot(config);
  }
  const phase = value("--phase") ?? "migration";
  const apply = process.argv.includes("--apply");
  const provider = createStorageProviderFromConfig(loadStorageConfig());
  if (provider.id !== "s3") throw new Error("Agent file maintenance requires shared object storage");
  if (phase === "eligibility") {
    assertEphemeralServerConfig(loadConfig(), { ...process.env, PAPERCLIP_EPHEMERAL_SERVER: "true" });
    const result = await readEphemeralServerDataEligibility(db);
    console.log(JSON.stringify({ phase, ...result }));
    if (!result.eligible) process.exitCode = 1;
  } else {
  const result = phase === "migration" ? await migrateAgentFiles(db, {
    apply, writersStopped: process.argv.includes("--writers-stopped"), companyId: value("--company"),
    after: value("--after"), limit: Number(value("--limit") ?? 25),
  }) : phase === "objects" ? await collectAgentFileObjects(db, provider, createStorageService(provider), {
    apply, companyId: value("--company") ?? "", agentId: value("--agent") ?? "", continuationToken: value("--after"),
  }) : (() => { throw new Error("--phase must be migration, eligibility or objects"); })();
  console.log(JSON.stringify({ phase, apply, ...result }));
  if (phase === "migration" && apply && "pageReady" in result && !result.pageReady) process.exitCode = 1;
  }
} finally { await closeRegisteredClients(url, { scope: "database" }); }
