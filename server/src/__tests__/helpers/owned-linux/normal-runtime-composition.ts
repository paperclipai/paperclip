// PRIVATE, UNRUN. Intended normal imports when placed beside the fixture.
import type { Db } from "@paperclipai/db";
import type { PluginWorkerManager } from "../../../services/plugin-worker-manager.js";
import { environmentRuntimeService, type EnvironmentRuntimeDriver } from "../../../services/environment-runtime.js";

export const LINUX_QUALIFICATION_PROVIDER = "dot-linux-qualification";

export function composeLinuxManagedRuntime(db: Db, workerManager: PluginWorkerManager) {
  // Preserve the real sandbox driver's configuration validation, acquire/lease
  // persistence, classifier, target resolution and release/reconciliation. The
  // provider worker implements real Linux I/O; no managed/ready/target fake.
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
  const driver: EnvironmentRuntimeDriver | null = runtime.getDriver("sandbox");
  if (!driver) throw new Error("normal_sandbox_driver_missing");
  return { runtime, driver, workerManager };
}

// Required fixture wiring (not an alternative production bootstrap):
// 1 Install the owned worker with the normal plugin loader/registration owner.
//    Its sandbox_provider driverKey is LINUX_QUALIFICATION_PROVIDER. Start the
//    REAL worker; ready/verified methods must come from its actual handshake.
// 2 POST /api/companies/:companyId/environments with original board authority,
//    driver=sandbox, config.provider=LINUX_QUALIFICATION_PROVIDER. No direct DB
//    environment/default-agent writes, internal fake config or Daytona label.
// 3 PATCH /api/agents/:id defaultEnvironmentId through the normal authorized
//    route. Keep its current company, driver, consent and setup validation.
// 4 The externally composed heartbeat uses runtime from this function. createApp
//    receives the SAME workerManager; its normal runtime uses that owner too.
// 5 Stop/join heartbeat + app consumers before worker/provider shutdown. Provider
//    release returns stopped only after real custody/ingress proof, then normal
//    environmentService persists the release receipt. Unknown => retain.
