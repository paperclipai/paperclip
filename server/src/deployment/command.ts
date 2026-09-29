import {
  acquireDeploymentLease, applyPendingMigrations, assertDeploymentSchemaCompatible,
  createDb, closeRegisteredClients, inspectMigrations, resolveMigrationConnection,
} from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { embeddedDeploymentIdentity, readJson, type DeploymentDescriptor } from "./runtime.js";
import { reconcileDeployment } from "./reconcile.js";
import { publishDeploymentBindings } from "./startup.js";

/** Plans/checks never initialize a cluster, migrate, bootstrap or publish files. */
export async function deploymentCommand(command: "plan" | "apply" | "check", descriptor: DeploymentDescriptor) {
  const config = loadConfig();
  const apply = command === "apply";
  let stop: (() => Promise<void>) | undefined;
  let release: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let connectionUrl: string | undefined;
  try {
    let url = config.databaseUrl;
    if (!url) {
      const identity = embeddedDeploymentIdentity();
      if (apply) {
        const connection = await resolveMigrationConnection({ ...identity, strictPort: true });
        url = connection.connectionString; stop = connection.stop;
      } else url = identity.url(config.embeddedPostgresPort);
    }
    if (!url) throw new Error("Missing database connection");
    connectionUrl = url;
    // An offline apply cannot change resources underneath a running server.
    // Read-only checks may run concurrently with it.
    if (apply) release = await acquireDeploymentLease(url, () => {
      // The lease lives on a separate connection from migrations and the apply
      // transaction. Once it is gone another controller can start immediately.
      // Exit rather than letting either connection continue without ownership.
      console.error("Declarative database lease was lost; aborting offline apply");
      process.exit(1);
    });
    const migrationUrl = config.databaseMigrationUrl ?? url;
    await assertDeploymentSchemaCompatible(migrationUrl);
    if (apply) await applyPendingMigrations(migrationUrl);
    else if ((await inspectMigrations(url)).status !== "upToDate") {
      throw new Error("Database requires migrations; plan and check never migrate");
    }
    db = createDb(url);
    const manifest = descriptor.manifestFile ? readJson(descriptor.manifestFile)
      : { version: 1, owner: descriptor.instance, companies: {} };
    const result = await reconcileDeployment(db, manifest, { apply, descriptor, config, singleOwner: true });
    if (apply) await publishDeploymentBindings(descriptor, result);
    return { result, exitCode: command === "check" && result.differences.length ? 2 : 0 };
  } finally {
    if (db && connectionUrl) await closeRegisteredClients(connectionUrl);
    await release?.();
    await stop?.();
  }
}
