import { createDb } from "@paperclipai/db";
import { environmentRuntimeService } from "../../services/environment-runtime.js";
import { environmentService } from "../../services/environments.js";
import type { PluginWorkerManager } from "../../services/plugin-worker-manager.js";

const db = createDb(process.env.CREATION_FIXTURE_DATABASE_URL!);
const workers = {
  isRunning: () => true,
  getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentInspectLease", "environmentDestroyLease"] }),
  call: async (_pluginId: string, method: string, input: unknown) => {
    const response = await fetch(process.env.CREATION_FIXTURE_PROVIDER_URL!, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, input }),
    });
    if (!response.ok) throw new Error("Controlled provider unavailable");
    return response.json();
  },
} as unknown as PluginWorkerManager;
try {
  const runtime = environmentRuntimeService(db, {
    pluginWorkerManager: workers, orphanCleanupSpoolDir: process.env.CREATION_FIXTURE_EMPTY_DISK,
  });
  if (process.env.CREATION_FIXTURE_ACTION === "acquire") {
    await runtime.acquireRunLease({ companyId: process.env.CREATION_FIXTURE_COMPANY_ID!,
      environment: (await environmentService(db).getById(process.env.CREATION_FIXTURE_ENVIRONMENT_ID!))!,
      heartbeatRunId: process.env.CREATION_FIXTURE_RUN_ID!, issueId: null, persistedExecutionWorkspace: null });
  } else {
    await runtime.flushDeferredOrphanCleanups();
  }
  process.stdout.write(JSON.stringify({ ok: true }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
} finally {
  await db.$client.end({ timeout: 1 });
}
