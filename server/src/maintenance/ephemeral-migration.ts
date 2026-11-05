import { closeRegisteredClients, createDb } from "@paperclipai/db";
import { readBuildCommit } from "../build-commit.js";
import { loadConfig } from "../config.js";
import { cloudRuntimeConfigService } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { resolveDecisionSigningSecret } from "../services/decision-signing.js";
import { assertEphemeralServerConfig } from "../services/ephemeral-server-contract.js";
import { migrateEphemeralServerData } from "./ephemeral-migration-data.js";
import { startEphemeralMigrationService } from "./ephemeral-migration-service.js";

// Cloud starts this image entry only after its provider has confirmed the web
// and every legacy worker stopped. It never starts schedulers or app routes.
if (process.env.PAPERCLIP_EPHEMERAL_MIGRATION !== "true") throw new Error("Explicit maintenance mode is required");
const url = process.env.DATABASE_URL;
const commit = readBuildCommit();
if (!url || !commit) throw new Error("Maintenance requires an explicit database and stamped image");
const service = await startEphemeralMigrationService({
  id: process.env.PAPERCLIP_EPHEMERAL_MIGRATION_ID ?? "", token: process.env.PAPERCLIP_EPHEMERAL_MIGRATION_TOKEN ?? "",
  commit, port: Number(process.env.PORT ?? 3100),
  async migrate(signal, phase) {
    const db = createDb(url, { maxConnections: 2 });
    try {
      if (isCloudManagedInstance()) {
        const config = await cloudRuntimeConfigService(db).inspectStored();
        if (!config) throw new Error("cloud_runtime_configuration_missing");
        setCloudRuntimeConfigSnapshot(config);
      }
      // Never generate a replacement key over a missing volume. The original
      // key is exported only after every owner confirms durable eligibility.
      const decisionSigningSecret = resolveDecisionSigningSecret({ allowCreate: false });
      assertEphemeralServerConfig(loadConfig(), { ...process.env, PAPERCLIP_EPHEMERAL_SERVER: "true",
        PAPERCLIP_DECISION_SIGNING_SECRET: decisionSigningSecret });
      const result = await migrateEphemeralServerData(db, { signal, phase });
      return { ...result, decisionSigningSecret };
    } finally { await closeRegisteredClients(url, { scope: "database" }); }
  },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  const deadline = setTimeout(() => process.exit(1), 10_000);
  void service.close().then(() => { clearTimeout(deadline); process.exit(0); }, () => process.exit(1));
});
