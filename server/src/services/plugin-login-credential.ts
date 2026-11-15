import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { pluginRegistryService } from "./plugin-registry.js";

const MAX_LOGIN_CREDENTIAL_BYTES = 64 * 1024;
/** Read only the fixed artifact of the exact durable login allocation. */
export async function readPluginLoginCredential(input: {
  db: Db; workerManager?: PluginWorkerManager; environment: Environment; lease: EnvironmentLease;
}): Promise<Buffer> {
  try {
    const metadata = input.lease.metadata;
    if (input.lease.environmentId !== input.environment.id || metadata?.purpose !== "login" || metadata.loginCommandKey !== "codex" ||
        !input.lease.providerLeaseId || typeof metadata.pluginId !== "string" || typeof metadata.driverKey !== "string") throw new Error();
    const plugin = await pluginRegistryService(input.db).getById(metadata.pluginId);
    const driver = plugin?.manifestJson.environmentDrivers?.find(candidate => candidate.driverKey === metadata.driverKey);
    if (!plugin || plugin.status !== "ready" || driver?.supportsLoginPty !== true ||
        !input.workerManager?.getWorker(plugin.id)?.supportedMethods.includes("loginPtyReadCredential")) throw new Error();
    const result = await input.workerManager.call(plugin.id, "loginPtyReadCredential", {
      driverKey: metadata.driverKey, companyId: input.lease.companyId, environmentId: input.environment.id,
      providerLeaseId: input.lease.providerLeaseId, loginCommandKey: "codex",
    });
    if (result?.kind !== "codex-auth-json" || typeof result.authJson !== "string" || !result.authJson.length || Buffer.byteLength(result.authJson) > MAX_LOGIN_CREDENTIAL_BYTES) throw new Error();
    return Buffer.from(result.authJson, "utf8");
  } catch {
    throw new Error("Login credential result unavailable");
  }
}
