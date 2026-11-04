import { closeRegisteredClients, createDb } from "@paperclipai/db";
import { cloudRuntimeConfigService } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { getStorageService } from "../storage/index.js";
import { prestageNativeHarnessBackups } from "../services/native-runtime/native-harness-backup-migration.js";

// Operator-only finite preparation. No task drain, scheduler, app routes,
// enrollment export, or assertion that other executions have stopped.
if (process.env.PAPERCLIP_NATIVE_HARNESS_PRESTAGE !== "true") throw new Error("Explicit harness pre-copy mode is required");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Harness pre-copy requires an explicit database");
const cancellation = new AbortController();
const stop = () => cancellation.abort(new Error("native_harness_prestage_stopped"));
const deadline = setTimeout(() => cancellation.abort(new Error("native_harness_prestage_deadline")), 90 * 60_000);
process.once("SIGINT", stop); process.once("SIGTERM", stop);
const db = createDb(url, { maxConnections: 2 });
try {
  if (isCloudManagedInstance()) {
    const config = await cloudRuntimeConfigService(db).inspectStored();
    if (!config) throw new Error("cloud_runtime_configuration_missing");
    setCloudRuntimeConfigSnapshot(config);
  }
  const storage = getStorageService();
  if (storage.provider !== "s3") throw new Error("shared_object_storage_required");
  const counts = await prestageNativeHarnessBackups(db, { storage, signal: cancellation.signal });
  console.log(JSON.stringify({ schema: "paperclip.native-harness-prestage.v1", counts, enrollmentReady: false }));
} catch (error) {
  const message = error instanceof Error ? error.message : "native_harness_prestage_failed";
  const failure = /^[a-z_]{1,80}$/.test(message) ? message : "native_harness_prestage_failed";
  console.error(JSON.stringify({ schema: "paperclip.native-harness-prestage.v1", state: "blocked", failure, enrollmentReady: false }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline); process.off("SIGINT", stop); process.off("SIGTERM", stop);
  await closeRegisteredClients(url, { scope: "database" });
}
