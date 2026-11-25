import type { Db } from "@paperclipai/db";
import type { MigrateCloudTrialAgentsInput } from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";
import type { CloudInstanceEnv } from "./cloud-instance.js";
import {
  CloudTrialExhaustedError,
  createCloudTrialKeyStore,
  isCloudTrialExhaustedError,
} from "./cloud-trial-key-store.js";
import {
  migrateCloudTrialAgents,
  type CloudTrialMigrationActor,
} from "./cloud-trial-migration.js";
import {
  createCloudTrialProxy,
  type PreparedCloudTrialRuntime,
} from "./cloud-trial-proxy.js";
import {
  assertCloudTrialInferenceEligible,
  getCompanyCloudTrialStatus,
} from "./cloud-trial-status.js";

export {
  CloudTrialExhaustedError,
  isCloudTrialExhaustedError,
  assertCloudTrialInferenceEligible,
  type PreparedCloudTrialRuntime,
};

export interface CloudTrialInferenceOptions {
  env?: CloudInstanceEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createCloudTrialInferenceController(opts: CloudTrialInferenceOptions = {}) {
  const keyStore = createCloudTrialKeyStore(opts);
  const proxy = createCloudTrialProxy(keyStore);

  return {
    prepareCloudTrialRuntime: proxy.prepareCloudTrialRuntime,
    proxyOpenRouterRequest: proxy.proxyOpenRouterRequest,
    getCompanyStatus: (
      db: Db,
      companyId: string,
      options: { refreshUsage?: boolean; actor?: AuthorizationActor } = {},
    ) => getCompanyCloudTrialStatus(db, companyId, keyStore, options),
    migrateTrialAgents: (
      db: Db,
      companyId: string,
      input: MigrateCloudTrialAgentsInput,
      actor: CloudTrialMigrationActor,
    ) => migrateCloudTrialAgents(db, companyId, input, actor, keyStore),
    markExhausted: keyStore.markExhausted,
    probeOpenRouterUsage: keyStore.probeOpenRouterUsage,
    _resetForTests: () => {
      proxy.clearTokens();
      keyStore._resetForTests();
    },
  };
}

export type CloudTrialInferenceController = ReturnType<
  typeof createCloudTrialInferenceController
>;

let defaultController: CloudTrialInferenceController | null = null;

export function setDefaultCloudTrialInferenceController(
  controller: CloudTrialInferenceController,
): void {
  defaultController = controller;
}

export function getDefaultCloudTrialInferenceController(): CloudTrialInferenceController {
  if (!defaultController) {
    defaultController = createCloudTrialInferenceController();
  }
  return defaultController;
}
