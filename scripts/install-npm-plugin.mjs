/**
 * Install a Paperclip plugin from npm and transition it to ready (mirrors POST /api/plugins/install).
 *
 * Production (copy script into the image tree, then run from /app/server so workspace packages resolve;
 * DATABASE_URL is already set in the container):
 *
 *   docker cp scripts/install-npm-plugin.mjs paperclip-server-1:/app/server/install-npm-plugin.mjs
 *   docker exec -u node -w /app/server -e PAPERCLIP_APP_ROOT=/app paperclip-server-1 \
 *     node --import ./node_modules/tsx/dist/loader.mjs ./install-npm-plugin.mjs <package> [version]
 *
 * Then restart the server container so the main process loads the plugin worker and tools.
 *
 * Local (repo root, `pnpm --filter @paperclipai/server build`):
 *   DATABASE_URL=... PAPERCLIP_APP_ROOT=$PWD \
 *     node --import ./server/node_modules/tsx/dist/loader.mjs scripts/install-npm-plugin.mjs <pkg> [version]
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb } from "@paperclipai/db";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.PAPERCLIP_APP_ROOT ?? path.resolve(__dirname, "..");
const distServices = path.join(APP_ROOT, "server", "dist", "services");

async function loadDist(name) {
  return import(pathToFileURL(path.join(distServices, `${name}.js`)).href);
}

const { createPluginWorkerManager } = await loadDist("plugin-worker-manager");
const { createPluginEventBus } = await loadDist("plugin-event-bus");
const { setPluginEventBus } = await loadDist("activity-log");
const { pluginJobStore } = await loadDist("plugin-job-store");
const { pluginLifecycleManager } = await loadDist("plugin-lifecycle");
const { createPluginJobScheduler } = await loadDist("plugin-job-scheduler");
const { createPluginToolDispatcher } = await loadDist("plugin-tool-dispatcher");
const { pluginLoader, DEFAULT_LOCAL_PLUGIN_DIR } = await loadDist("plugin-loader");
const { buildHostServices } = await loadDist("plugin-host-services");
const { pluginRegistryService } = await loadDist("plugin-registry");

const packageName = process.argv[2];
const version = process.argv[3];
if (!packageName) {
  console.error("usage: node install-npm-plugin.mjs <packageName> [version]");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL);
const hostServicesDisposers = new Map();
const workerManager = createPluginWorkerManager();
const eventBus = createPluginEventBus();
setPluginEventBus(eventBus);
const jobStore = pluginJobStore(db);
const lifecycleBootstrap = pluginLifecycleManager(db, { workerManager });
const scheduler = createPluginJobScheduler({ db, jobStore, workerManager });
const toolDispatcher = createPluginToolDispatcher({
  workerManager,
  lifecycleManager: lifecycleBootstrap,
  db,
});

const loader = pluginLoader(db, { localPluginDir: DEFAULT_LOCAL_PLUGIN_DIR }, {
  workerManager,
  eventBus,
  jobScheduler: scheduler,
  jobStore,
  toolDispatcher,
  lifecycleManager: lifecycleBootstrap,
  instanceInfo: { instanceId: process.env.PAPERCLIP_INSTANCE_ID ?? "default", hostVersion: "0.0.0" },
  buildHostHandlers: (pluginId, manifest) => {
    const notifyWorker = (method, params) => {
      const handle = workerManager.getWorker(pluginId);
      if (handle) handle.notify(method, params);
    };
    const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker);
    hostServicesDisposers.set(pluginId, () => services.dispose());
    return createHostClientHandlers({
      pluginId,
      capabilities: manifest.capabilities,
      services,
    });
  },
});

const lifecycle = pluginLifecycleManager(db, { loader, workerManager });
const registry = pluginRegistryService(db);

scheduler.start();
await toolDispatcher.initialize();

const installOpts = version ? { packageName, version } : { packageName };
const discovered = await loader.installPlugin(installOpts);
if (!discovered.manifest?.id) throw new Error("installPlugin: missing manifest id");

const row = await registry.getByKey(discovered.manifest.id);
if (!row) throw new Error("plugin row missing after install");

await lifecycle.load(row.id);
const updated = await registry.getById(row.id);
console.log(
  JSON.stringify({
    ok: true,
    pluginKey: updated?.pluginKey,
    id: updated?.id,
    version: updated?.version,
    status: updated?.status,
  }),
);
