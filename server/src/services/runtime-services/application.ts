import { createRuntimeServiceOperations } from "./operations.js";
import type { Db } from "@paperclipai/db";
import { environmentRuntimeService } from "../environment-runtime.js";
import { isCloudManagedInstance } from "../cloud-instance.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { createRuntimeServiceManager } from "./manager.js";
import { createLocalRuntimeServiceProvider } from "./local-provider.js";
import { createLocalServiceSandboxLauncher } from "./local-sandbox.js";
import { createDaytonaRuntimeServiceProvider } from "./daytona-provider.js";
import { createRuntimeServicePlacementResolver } from "./placement.js";
import { runtimeServicePreviewConfig } from "./preview-config.js";
import { createRuntimeServicePreviewGateway } from "./preview-gateway.js";
import { createRuntimeServiceCredentials } from "./credentials.js";
import { createRuntimeServiceProvisioning } from "./provisioning.js";
import { createRuntimeServiceController } from "./controller.js";
import { createRuntimeServiceDataDeletionExecutor } from "./data-deletion.js";

export function createRuntimeServiceDependencies(db: Db, options: { pluginWorkerManager?: PluginWorkerManager; exposeEndpoint?: Parameters<typeof createRuntimeServiceManager>[1]["exposeEndpoint"] }) {
  const allowLocal = !isCloudManagedInstance();
  const environmentRuntime = environmentRuntimeService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const provisioning = createRuntimeServiceProvisioning(db, options.pluginWorkerManager);
  const providers = [
    ...(allowLocal ? [createLocalRuntimeServiceProvider({ prepareLaunch: createLocalServiceSandboxLauncher() })] : []),
    createDaytonaRuntimeServiceProvider({ operate: (input) => environmentRuntime.operateRuntimeService(input),
      handoff: (input) => environmentRuntime.operateRuntimeServiceProcessHandoff(input) }),
  ];
  const manager = createRuntimeServiceManager(db, { providers, exposeEndpoint: options.exposeEndpoint, ...createRuntimeServiceCredentials(db), prepareAllocation: provisioning.ensure,
    dataDeletionExecutor: createRuntimeServiceDataDeletionExecutor(db, options.pluginWorkerManager) });
  const resolvePlacement = createRuntimeServicePlacementResolver(db, { allowLocal, allocate: provisioning.placement });
  return { manager, resolvePlacement, operations: createRuntimeServiceOperations(db, { manager, resolvePlacement }) };
}

export function createRuntimeServiceApplication(db: Db, options: { pluginWorkerManager: PluginWorkerManager; onError: () => void; allowLocalBoard?: boolean; boardBaseURL?: () => string }) {
  const config = runtimeServicePreviewConfig(process.env.PAPERCLIP_SERVICE_PREVIEW_BASE_URL, !isCloudManagedInstance());
  let preview: ReturnType<typeof createRuntimeServicePreviewGateway> | undefined;
  const dependencies = createRuntimeServiceDependencies(db, { ...options, ...(config ? { exposeEndpoint: (row, endpoint) => preview!.exposeEndpoint(row, endpoint) } : {}) });
  const { manager } = dependencies;
  if (config) preview = createRuntimeServicePreviewGateway(db, manager, { config, allowLocalBoard: options.allowLocalBoard === true,
    boardBaseURL: options.boardBaseURL ?? (() => process.env.PAPERCLIP_API_URL ?? "") });
  const controller = createRuntimeServiceController({ select: manager.reconciliationCandidates,
    reconcile: manager.reconcile, retain: manager.reconcileAllocation, onError: options.onError });
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | null = null;
  let stopped = true;
  let prunedAt = 0;
  let storageTimer: ReturnType<typeof setInterval> | undefined;
  let storagePending: Promise<void> | null = null;
  let deletionTimer: ReturnType<typeof setInterval> | undefined;
  let deletionPending: Promise<void> | null = null;
  let expirationPending: Promise<void> | null = null;
  const expireData = () => {
    if (stopped || expirationPending) return;
    expirationPending = manager.dataExpirationTick().catch(options.onError).finally(() => { expirationPending = null; });
  };
  const deleteData = () => {
    if (stopped || deletionPending) return;
    deletionPending = manager.dataDeletionTick().catch(options.onError).finally(() => { deletionPending = null; });
  };
  const measureStorage = () => {
    if (stopped || storagePending) return;
    storagePending = manager.storageTick().catch(options.onError).finally(() => { storagePending = null; });
  };
  const prune = () => {
    const gateway = preview;
    if (stopped || pending || !gateway || Date.now() - prunedAt <= 3600_000) return;
    pending = (async () => {
      await gateway.access.prune();
      prunedAt = Date.now();
    })().catch(options.onError).finally(() => { pending = null; });
  };
  return {
    ...dependencies,
    preview,
    start() {
      if (!stopped) return;
      stopped = false;
      controller.start();
      deletionTimer = setInterval(() => { deleteData(); expireData(); }, 1000);
      deletionTimer.unref();
      deleteData();
      expireData();
      storageTimer = setInterval(measureStorage, 60_000);
      storageTimer.unref();
      measureStorage();
      timer = setInterval(prune, 60_000);
      timer.unref();
      prune();
    },
    /** Stop the controller only; supervised applications outlive this process. */
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (storageTimer) clearInterval(storageTimer);
      storageTimer = undefined;
      if (deletionTimer) clearInterval(deletionTimer);
      deletionTimer = undefined;
      await Promise.all([controller.stop(), pending, storagePending, deletionPending, expirationPending]);
    },
  };
}

export type RuntimeServiceApplication = ReturnType<typeof createRuntimeServiceApplication>;
