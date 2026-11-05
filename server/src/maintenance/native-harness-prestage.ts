import { closeRegisteredClients, createDb } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { cloudRuntimeConfigService } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { getStorageService } from "../storage/index.js";
import { hasLocalNativeHarnessObligations, prestageNativeHarnessBackups } from "../services/native-runtime/native-harness-backup-migration.js";
import { initializeNativeHarnessPrestageKey, nativeHarnessPrestageDatabaseUrl } from "./native-harness-prestage-runtime.js";

if (process.env.PAPERCLIP_NATIVE_HARNESS_PRESTAGE !== "true") throw new Error("Explicit harness pre-copy mode is required");
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("Harness pre-copy requires an explicit database");
const url = nativeHarnessPrestageDatabaseUrl(sourceUrl);
const cancellation = new AbortController();
let shutdown: ReturnType<typeof setTimeout> | undefined;
let blocked = false;
const reportBlocked = (error: unknown) => {
  process.exitCode = 1;
  if (blocked) return;
  blocked = true;
  const message = error instanceof Error ? error.message : "native_harness_prestage_failed";
  const failure = /^[a-z_]{1,80}$/.test(message) ? message : "native_harness_prestage_failed";
  console.error(JSON.stringify({ schema: "paperclip.native-harness-prestage.v1", state: "blocked", failure, enrollmentReady: false }));
};
const abort = (reason: string) => {
  if (cancellation.signal.aborted) return;
  reportBlocked(new Error(reason));
  cancellation.abort(new Error(reason));
  shutdown = setTimeout(() => process.exit(1), 10_000);
  void closeRegisteredClients(url, { scope: "database" });
};
const stop = () => abort("native_harness_prestage_stopped");
const deadline = setTimeout(() => abort("native_harness_prestage_deadline"), 90 * 60_000);
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  const db = createDb(url, { maxConnections: 2, connectTimeoutSeconds: 10 });
  if (isCloudManagedInstance()) {
    const config = await cloudRuntimeConfigService(db).inspectStored();
    if (!config) throw new Error("cloud_runtime_configuration_missing");
    setCloudRuntimeConfigSnapshot(config);
  }
  await initializeNativeHarnessPrestageKey(loadConfig().secretsMasterKeyFilePath);
  const storage = getStorageService();
  if (storage.provider !== "s3") throw new Error("shared_object_storage_required");
  const counts = await prestageNativeHarnessBackups(db, { storage, signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  if (counts.inspected === 0) {
    const obligations = await hasLocalNativeHarnessObligations(db);
    cancellation.signal.throwIfAborted();
    if (obligations) throw new Error("native_harness_prestage_source_missing");
  }
  console.log(JSON.stringify({ schema: "paperclip.native-harness-prestage.v1", counts, enrollmentReady: false }));
} catch (error) {
  reportBlocked(error);
} finally {
  clearTimeout(deadline); process.off("SIGINT", stop); process.off("SIGTERM", stop);
  await closeRegisteredClients(url, { scope: "database" });
  clearTimeout(shutdown);
}
