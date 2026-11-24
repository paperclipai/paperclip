import type { Db } from "@paperclipai/db";
import { ADAPTER_LOGIN_CREDENTIAL_SOURCE, isAdapterLoginCommandKey, type Environment, type EnvironmentLease } from "@paperclipai/shared";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { pluginRegistryService } from "./plugin-registry.js";

const MAX_LOGIN_CREDENTIAL_BYTES = 64 * 1024;
/**
 * Read only the saved credential file of the exact durable login allocation. The
 * command key comes from the allocation the host created, and only a sign-in that
 * saves a file is read back.
 */
export async function readPluginLoginCredential(input: {
  db: Db; workerManager?: PluginWorkerManager; environment: Environment; lease: EnvironmentLease;
}): Promise<Buffer> {
  try {
    const metadata = input.lease.metadata;
    const loginCommandKey = metadata?.loginCommandKey;
    if (input.lease.environmentId !== input.environment.id || metadata?.purpose !== "login" ||
        !isAdapterLoginCommandKey(loginCommandKey) || ADAPTER_LOGIN_CREDENTIAL_SOURCE[loginCommandKey] !== "file" ||
        !input.lease.providerLeaseId || typeof metadata.pluginId !== "string" || typeof metadata.driverKey !== "string") throw new Error();
    const plugin = await pluginRegistryService(input.db).getById(metadata.pluginId);
    const driver = plugin?.manifestJson.environmentDrivers?.find(candidate => candidate.driverKey === metadata.driverKey);
    if (!plugin || plugin.status !== "ready" || driver?.supportsLoginPty !== true ||
        !input.workerManager?.getWorker(plugin.id)?.supportedMethods.includes("loginPtyReadCredential")) throw new Error();
    const result = await input.workerManager.call(plugin.id, "loginPtyReadCredential", {
      driverKey: metadata.driverKey, companyId: input.lease.companyId, environmentId: input.environment.id,
      providerLeaseId: input.lease.providerLeaseId, loginCommandKey,
    });
    if (result?.kind !== "auth-file" || typeof result.content !== "string" || !result.content.length || Buffer.byteLength(result.content) > MAX_LOGIN_CREDENTIAL_BYTES) throw new Error();
    return Buffer.from(result.content, "utf8");
  } catch {
    throw new Error("Login credential result unavailable");
  }
}
