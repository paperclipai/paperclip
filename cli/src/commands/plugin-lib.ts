import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "../config/home.js";

export type PluginCommandCommonOptions = {
  instance?: string;
  json?: boolean;
};

export type PluginLifecycleState = {
  loadCount: number;
  restartCount: number;
  lastLoadedAt?: string;
  lastInitializedAt?: string;
  lastHealthAt?: string;
  lastShutdownAt?: string;
};

export type PluginRegistryRecord = {
  pluginId: string;
  packageName: string;
  packageVersion: string;
  sourcePath: string;
  symlinkPath: string;
  manifestPath: string;
  workerPath: string;
  enabled: boolean;
  status: "ready" | "error" | "disabled";
  config: Record<string, unknown>;
  lifecycle: PluginLifecycleState;
  installedAt: string;
  updatedAt: string;
  lastError?: string;
  lastHealth?: unknown;
};

type PluginRegistryFileV1 = {
  version: 1;
  plugins: Array<
    Omit<PluginRegistryRecord, "enabled" | "config" | "lifecycle" | "status"> & {
      status: "ready" | "error";
    }
  >;
};

type PluginRegistryFileV2 = {
  version: 2;
  updatedAt: string;
  plugins: PluginRegistryRecord[];
};

export type PaperclipPluginManifestV1 = {
  id: string;
  apiVersion: number;
  version: string;
  displayName: string;
  description?: string;
  capabilities?: string[];
  configSchema?: unknown;
};

type PluginPackageJson = {
  name?: string;
  version?: string;
  paperclipPlugin?: {
    manifest?: string;
    worker?: string;
  };
};

export type ValidatedPluginPackage = {
  packageName: string;
  packageVersion: string;
  sourcePath: string;
  manifestPath: string;
  workerPath: string;
  manifest: PaperclipPluginManifestV1;
};

export type PluginConfigField = {
  key: string;
  label?: string;
  description?: string;
  type: "string" | "number" | "boolean" | "textarea" | "password" | "select" | "json";
  required?: boolean;
  secret?: boolean;
  defaultValue?: unknown;
  placeholder?: string;
  options?: Array<{
    label: string;
    value: string | number | boolean;
  }>;
};

export type PluginConfigSchemaDescriptor = {
  title?: string;
  description?: string;
  restartRequired?: boolean;
  fields: PluginConfigField[];
};

export type PluginConfigDescribeResult = {
  plugin: PluginRegistryRecord;
  config: Record<string, unknown>;
  schema: PluginConfigSchemaDescriptor;
  schemaSource: "manifest" | "inferred";
};

export type PluginConfigUpdateResult = {
  plugin: PluginRegistryRecord;
  restartResult?: PluginLoadResult;
};

export type PluginDoctorResult = {
  pluginId: string;
  ok: boolean;
  status: "ready" | "error" | "disabled";
  error?: string;
  health?: unknown;
};

export type PluginLoadResult = {
  pluginId: string;
  status: "ready" | "error" | "disabled";
  health?: unknown;
  error?: string;
};

type WorkerModule = {
  initialize?: (input: unknown) => Promise<unknown> | unknown;
  health?: () => Promise<unknown> | unknown;
  shutdown?: () => Promise<unknown> | unknown;
  default?: {
    initialize?: (input: unknown) => Promise<unknown> | unknown;
    health?: () => Promise<unknown> | unknown;
    shutdown?: () => Promise<unknown> | unknown;
  };
};

type WorkerApi = {
  initialize?: (input: unknown) => Promise<unknown> | unknown;
  health?: () => Promise<unknown> | unknown;
  shutdown?: () => Promise<unknown> | unknown;
};

type RunningWorker = {
  pluginId: string;
  api: WorkerApi;
};

export interface PluginRegistryStore {
  load(): PluginRegistryFileV2;
  save(registry: PluginRegistryFileV2): void;
}

type PluginHostPaths = {
  instanceId: string;
  instanceRoot: string;
  pluginsRoot: string;
  installedRoot: string;
  registryPath: string;
};

function fileExists(pathname: string): boolean {
  try {
    return existsSync(pathname);
  } catch {
    return false;
  }
}

function toAbsolutePath(value: string): string {
  return path.resolve(value);
}

function sanitizePluginPathSegment(pluginId: string): string {
  return pluginId.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function resolvePluginHostPaths(instanceOverride?: string): PluginHostPaths {
  const instanceId = resolvePaperclipInstanceId(instanceOverride);
  const instanceRoot = resolvePaperclipInstanceRoot(instanceId);
  const pluginsRoot = path.resolve(instanceRoot, "plugins");
  const installedRoot = path.resolve(pluginsRoot, "installed");
  const registryPath = path.resolve(pluginsRoot, "registry.json");

  return {
    instanceId,
    instanceRoot,
    pluginsRoot,
    installedRoot,
    registryPath,
  };
}

function ensurePluginHostDirs(instanceOverride?: string): PluginHostPaths {
  const paths = resolvePluginHostPaths(instanceOverride);
  mkdirSync(paths.pluginsRoot, { recursive: true });
  mkdirSync(paths.installedRoot, { recursive: true });
  mkdirSync(path.resolve(paths.instanceRoot, "data", "plugins"), { recursive: true });
  return paths;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLifecycle(input?: Partial<PluginLifecycleState>): PluginLifecycleState {
  return {
    loadCount: Number.isFinite(input?.loadCount) ? Number(input?.loadCount) : 0,
    restartCount: Number.isFinite(input?.restartCount) ? Number(input?.restartCount) : 0,
    lastLoadedAt: input?.lastLoadedAt,
    lastInitializedAt: input?.lastInitializedAt,
    lastHealthAt: input?.lastHealthAt,
    lastShutdownAt: input?.lastShutdownAt,
  };
}

function normalizeRecord(input: Partial<PluginRegistryRecord> & { pluginId: string }): PluginRegistryRecord {
  const installedAt = input.installedAt || nowIso();
  const updatedAt = input.updatedAt || installedAt;
  const enabled = input.enabled ?? true;
  const status = enabled ? input.status ?? "ready" : "disabled";

  return {
    pluginId: input.pluginId,
    packageName: input.packageName ?? "",
    packageVersion: input.packageVersion ?? "",
    sourcePath: input.sourcePath ?? "",
    symlinkPath: input.symlinkPath ?? "",
    manifestPath: input.manifestPath ?? "",
    workerPath: input.workerPath ?? "",
    enabled,
    status,
    config: (input.config ?? {}) as Record<string, unknown>,
    lifecycle: normalizeLifecycle(input.lifecycle),
    installedAt,
    updatedAt,
    lastError: input.lastError,
    lastHealth: input.lastHealth,
  };
}

export class FilePluginRegistryStore implements PluginRegistryStore {
  constructor(private readonly instanceOverride?: string) {}

  load(): PluginRegistryFileV2 {
    const { registryPath } = ensurePluginHostDirs(this.instanceOverride);
    if (!fileExists(registryPath)) {
      return {
        version: 2,
        updatedAt: nowIso(),
        plugins: [],
      };
    }

    const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as
      | PluginRegistryFileV1
      | PluginRegistryFileV2;

    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Invalid plugin registry format at ${registryPath}.`);
    }

    if ((parsed as PluginRegistryFileV2).version === 2) {
      const v2 = parsed as PluginRegistryFileV2;
      if (!Array.isArray(v2.plugins)) {
        throw new Error(`Invalid plugin registry format at ${registryPath}.`);
      }
      return {
        version: 2,
        updatedAt: v2.updatedAt || nowIso(),
        plugins: v2.plugins.map((record) => normalizeRecord(record)),
      };
    }

    if ((parsed as PluginRegistryFileV1).version === 1) {
      const v1 = parsed as PluginRegistryFileV1;
      if (!Array.isArray(v1.plugins)) {
        throw new Error(`Invalid plugin registry format at ${registryPath}.`);
      }
      return {
        version: 2,
        updatedAt: nowIso(),
        plugins: v1.plugins.map((record) =>
          normalizeRecord({
            ...record,
            enabled: true,
            config: {},
            lifecycle: { loadCount: 0, restartCount: 0 },
          }),
        ),
      };
    }

    throw new Error(`Invalid plugin registry format at ${registryPath}.`);
  }

  save(registry: PluginRegistryFileV2): void {
    const { registryPath } = ensurePluginHostDirs(this.instanceOverride);
    const normalized: PluginRegistryFileV2 = {
      version: 2,
      updatedAt: nowIso(),
      plugins: registry.plugins.map((record) => normalizeRecord(record)),
    };
    writeFileSync(registryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  }
}

function resolvePackageDir(localPath: string): string {
  const absolutePath = toAbsolutePath(localPath);
  if (!fileExists(absolutePath)) {
    throw new Error(
      `Plugin source path not found: ${absolutePath}. Only local directory installs are supported in this phase.`,
    );
  }

  const stats = lstatSync(absolutePath);
  if (stats.isDirectory()) {
    const packageJsonPath = path.resolve(absolutePath, "package.json");
    if (!fileExists(packageJsonPath)) {
      throw new Error(`Plugin source must contain package.json: ${absolutePath}`);
    }
    return absolutePath;
  }

  throw new Error(`Plugin source must be a directory path: ${absolutePath}`);
}

async function importModuleFromPath(modulePath: string): Promise<unknown> {
  const moduleUrl = pathToFileURL(modulePath).href;
  const loaded = await import(`${moduleUrl}?t=${Date.now()}`);
  return loaded;
}

function normalizeManifest(moduleNamespace: unknown): unknown {
  const ns = moduleNamespace as Record<string, unknown>;
  if (ns && typeof ns === "object") {
    if (ns.default && typeof ns.default === "object") {
      return ns.default;
    }
    if (ns.manifest && typeof ns.manifest === "object") {
      return ns.manifest;
    }
  }
  return moduleNamespace;
}

function assertManifestShape(manifest: unknown): asserts manifest is PaperclipPluginManifestV1 {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Plugin manifest module must export an object.");
  }

  const value = manifest as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("Plugin manifest requires a non-empty string `id`.");
  }
  if (typeof value.apiVersion !== "number" || !Number.isFinite(value.apiVersion)) {
    throw new Error("Plugin manifest requires numeric `apiVersion`.");
  }
  if (value.apiVersion !== 1) {
    throw new Error(`Unsupported plugin apiVersion ${String(value.apiVersion)} (expected 1).`);
  }
  if (typeof value.version !== "string" || value.version.trim().length === 0) {
    throw new Error("Plugin manifest requires a non-empty string `version`.");
  }
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) {
    throw new Error("Plugin manifest requires a non-empty string `displayName`.");
  }
}

export async function validateLocalPluginPackage(localPath: string): Promise<ValidatedPluginPackage> {
  const packageDir = resolvePackageDir(localPath);
  const packageJsonPath = path.resolve(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PluginPackageJson;

  const packageName = packageJson.name?.trim();
  const packageVersion = packageJson.version?.trim();
  if (!packageName) {
    throw new Error(`Plugin package.json must include non-empty name: ${packageJsonPath}`);
  }
  if (!packageVersion) {
    throw new Error(`Plugin package.json must include non-empty version: ${packageJsonPath}`);
  }

  const pluginConfig = packageJson.paperclipPlugin;
  if (!pluginConfig || typeof pluginConfig !== "object") {
    throw new Error(
      `Plugin package.json must include paperclipPlugin with manifest/worker entries: ${packageJsonPath}`,
    );
  }
  if (!pluginConfig.manifest || typeof pluginConfig.manifest !== "string") {
    throw new Error(`paperclipPlugin.manifest must be a non-empty string in ${packageJsonPath}`);
  }
  if (!pluginConfig.worker || typeof pluginConfig.worker !== "string") {
    throw new Error(`paperclipPlugin.worker must be a non-empty string in ${packageJsonPath}`);
  }

  const manifestPath = path.resolve(packageDir, pluginConfig.manifest);
  const workerPath = path.resolve(packageDir, pluginConfig.worker);
  if (!fileExists(manifestPath)) {
    throw new Error(`Plugin manifest entry not found: ${manifestPath}`);
  }
  if (!fileExists(workerPath)) {
    throw new Error(`Plugin worker entry not found: ${workerPath}`);
  }

  const manifestModule = await importModuleFromPath(manifestPath);
  const manifest = normalizeManifest(manifestModule);
  assertManifestShape(manifest);

  return {
    packageName,
    packageVersion,
    sourcePath: packageDir,
    manifestPath,
    workerPath,
    manifest,
  };
}

function resolveWorkerApi(loaded: WorkerModule): WorkerApi {
  const root =
    loaded && typeof loaded.default === "object" && loaded.default
      ? loaded.default
      : loaded;

  return {
    initialize: root.initialize,
    health: root.health,
    shutdown: root.shutdown,
  };
}

function isPluginConfigFieldType(value: unknown): value is PluginConfigField["type"] {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "textarea" ||
    value === "password" ||
    value === "select" ||
    value === "json"
  );
}

function normalizePluginConfigSchema(raw: unknown): PluginConfigSchemaDescriptor | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as {
    title?: unknown;
    description?: unknown;
    restartRequired?: unknown;
    fields?: unknown;
  };

  if (!Array.isArray(value.fields)) {
    return null;
  }

  const fields: PluginConfigField[] = [];
  for (const item of value.fields) {
    if (!item || typeof item !== "object") continue;
    const field = item as {
      key?: unknown;
      label?: unknown;
      description?: unknown;
      type?: unknown;
      required?: unknown;
      secret?: unknown;
      defaultValue?: unknown;
      placeholder?: unknown;
      options?: unknown;
    };

    if (typeof field.key !== "string" || field.key.trim().length === 0) continue;

    const type = isPluginConfigFieldType(field.type) ? field.type : "string";
    const normalized: PluginConfigField = {
      key: field.key,
      type,
    };

    if (typeof field.label === "string") normalized.label = field.label;
    if (typeof field.description === "string") normalized.description = field.description;
    if (typeof field.required === "boolean") normalized.required = field.required;
    if (typeof field.secret === "boolean") normalized.secret = field.secret;
    if (typeof field.placeholder === "string") normalized.placeholder = field.placeholder;
    if (field.defaultValue !== undefined) normalized.defaultValue = field.defaultValue;

    if (type === "select" && Array.isArray(field.options)) {
      const options = field.options
        .filter((opt): opt is { label?: unknown; value?: unknown } => Boolean(opt && typeof opt === "object"))
        .map((opt) => {
          const label = typeof opt.label === "string" ? opt.label : String(opt.value ?? "");
          const rawValue = opt.value;
          if (
            typeof rawValue === "string" ||
            typeof rawValue === "number" ||
            typeof rawValue === "boolean"
          ) {
            return { label, value: rawValue };
          }
          return null;
        })
        .filter((opt): opt is { label: string; value: string | number | boolean } => opt !== null);

      if (options.length > 0) {
        normalized.options = options;
      }
    }

    fields.push(normalized);
  }

  if (fields.length === 0) {
    return null;
  }

  return {
    title: typeof value.title === "string" ? value.title : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    restartRequired: typeof value.restartRequired === "boolean" ? value.restartRequired : undefined,
    fields,
  };
}

function inferPluginConfigSchema(config: Record<string, unknown>): PluginConfigSchemaDescriptor {
  const fields: PluginConfigField[] = Object.entries(config).map(([key, currentValue]) => {
    const base = {
      key,
      label: key,
    } satisfies Pick<PluginConfigField, "key" | "label">;

    if (typeof currentValue === "boolean") {
      return { ...base, type: "boolean", defaultValue: currentValue };
    }
    if (typeof currentValue === "number") {
      return { ...base, type: "number", defaultValue: currentValue };
    }
    if (typeof currentValue === "string") {
      const lower = key.toLowerCase();
      const isSecretLike =
        lower.includes("key") || lower.includes("token") || lower.includes("secret") || lower.includes("password");
      return {
        ...base,
        type: isSecretLike ? "password" : key.toLowerCase().includes("prompt") ? "textarea" : "string",
        secret: isSecretLike || undefined,
        defaultValue: currentValue,
      };
    }

    return {
      ...base,
      type: "json",
      defaultValue: currentValue,
    };
  });

  return {
    title: "Plugin Configuration",
    description:
      "Inferred from current config values. Unknown schema fields can be edited as JSON values.",
    restartRequired: true,
    fields,
  };
}

function buildInitializeInput(input: {
  manifest: PaperclipPluginManifestV1;
  instanceId: string;
  config: Record<string, unknown>;
}) {
  return {
    manifest: input.manifest,
    config: input.config,
    instance: { id: input.instanceId },
    hostApiVersion: 1,
  };
}

export class PluginHostService {
  private readonly paths: PluginHostPaths;
  private readonly store: PluginRegistryStore;
  private readonly running = new Map<string, RunningWorker>();

  constructor(
    private readonly opts: {
      instance?: string;
      store?: PluginRegistryStore;
    } = {},
  ) {
    this.paths = ensurePluginHostDirs(opts.instance);
    this.store = opts.store ?? new FilePluginRegistryStore(opts.instance);
  }

  private loadRegistry(): PluginRegistryFileV2 {
    return this.store.load();
  }

  private saveRegistry(registry: PluginRegistryFileV2): void {
    this.store.save(registry);
  }

  private findRecordOrThrow(registry: PluginRegistryFileV2, pluginId: string): PluginRegistryRecord {
    const record = registry.plugins.find((item) => item.pluginId === pluginId);
    if (!record) {
      throw new Error(`Plugin not installed: ${pluginId}`);
    }
    return record;
  }

  listInstalled(): PluginRegistryRecord[] {
    return this.loadRegistry().plugins.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  async installLocal(localPath: string, opts: { autoLoad?: boolean } = {}): Promise<PluginRegistryRecord> {
    const validated = await validateLocalPluginPackage(localPath);
    const pluginId = validated.manifest.id;
    const symlinkPath = path.resolve(this.paths.installedRoot, sanitizePluginPathSegment(pluginId));

    rmSync(symlinkPath, { recursive: true, force: true });
    symlinkSync(validated.sourcePath, symlinkPath, "dir");

    mkdirSync(path.resolve(this.paths.instanceRoot, "data", "plugins", pluginId), {
      recursive: true,
    });

    const registry = this.loadRegistry();
    const existing = registry.plugins.find((item) => item.pluginId === pluginId);
    const ts = nowIso();
    const bootstrapSkipped = !(opts.autoLoad ?? true);
    const nextRecord: PluginRegistryRecord = normalizeRecord({
      pluginId,
      packageName: validated.packageName,
      packageVersion: validated.packageVersion,
      sourcePath: validated.sourcePath,
      symlinkPath,
      manifestPath: validated.manifestPath,
      workerPath: validated.workerPath,
      enabled: existing?.enabled ?? true,
      status: existing?.enabled === false ? "disabled" : bootstrapSkipped ? "error" : "ready",
      config: existing?.config ?? {},
      lifecycle: existing?.lifecycle ?? { loadCount: 0, restartCount: 0 },
      installedAt: existing?.installedAt ?? ts,
      updatedAt: ts,
      lastError: bootstrapSkipped
        ? "Bootstrap skipped: plugin installed but not initialized/health-checked in host process yet."
        : undefined,
      lastHealth: existing?.lastHealth,
    });

    registry.plugins = [...registry.plugins.filter((item) => item.pluginId !== pluginId), nextRecord];
    this.saveRegistry(registry);

    if (opts.autoLoad ?? true) {
      const loaded = await this.loadPlugin(pluginId);
      const updatedRegistry = this.loadRegistry();
      const updatedRecord = this.findRecordOrThrow(updatedRegistry, pluginId);
      updatedRecord.status = loaded.status;
      updatedRecord.lastHealth = loaded.health;
      updatedRecord.lastError = loaded.error;
      updatedRecord.updatedAt = nowIso();
      this.saveRegistry(updatedRegistry);
      return updatedRecord;
    }

    return nextRecord;
  }

  async uninstall(pluginId: string, opts: { purgeData?: boolean } = {}): Promise<PluginRegistryRecord> {
    const normalizedPluginId = pluginId.trim();
    if (!normalizedPluginId) {
      throw new Error("Plugin id is required.");
    }

    const registry = this.loadRegistry();
    const target = registry.plugins.find((item) => item.pluginId === normalizedPluginId);
    if (!target) {
      throw new Error(`Plugin not installed: ${normalizedPluginId}`);
    }

    await this.shutdownPlugin(normalizedPluginId, { suppressMissing: true }).catch(() => undefined);

    rmSync(target.symlinkPath, { recursive: true, force: true });
    if (opts.purgeData) {
      rmSync(path.resolve(this.paths.instanceRoot, "data", "plugins", normalizedPluginId), {
        recursive: true,
        force: true,
      });
    }

    registry.plugins = registry.plugins.filter((item) => item.pluginId !== normalizedPluginId);
    this.saveRegistry(registry);

    return target;
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginRegistryRecord> {
    const registry = this.loadRegistry();
    const record = this.findRecordOrThrow(registry, pluginId);
    record.enabled = enabled;

    if (!enabled) {
      record.status = "disabled";
      record.lastError = undefined;
      record.updatedAt = nowIso();
      this.saveRegistry(registry);
      await this.shutdownPlugin(pluginId, { suppressMissing: true }).catch(() => undefined);
      return record;
    }

    record.status = "error";
    record.lastError = "Plugin enabled but not loaded yet.";
    record.updatedAt = nowIso();
    this.saveRegistry(registry);

    await this.loadPlugin(pluginId);
    const refreshed = this.loadRegistry();
    return this.findRecordOrThrow(refreshed, pluginId);
  }

  setConfig(pluginId: string, config: Record<string, unknown>): PluginRegistryRecord {
    const registry = this.loadRegistry();
    const record = this.findRecordOrThrow(registry, pluginId);
    record.config = config;
    record.updatedAt = nowIso();
    this.saveRegistry(registry);
    return record;
  }

  getConfig(pluginId: string): Record<string, unknown> {
    const registry = this.loadRegistry();
    const record = this.findRecordOrThrow(registry, pluginId);
    return record.config ?? {};
  }

  async describeConfig(pluginId: string): Promise<PluginConfigDescribeResult> {
    const registry = this.loadRegistry();
    const record = this.findRecordOrThrow(registry, pluginId);
    const validated = await validateLocalPluginPackage(record.sourcePath);

    const manifestSchema = normalizePluginConfigSchema(validated.manifest.configSchema);
    const config = record.config ?? {};

    if (manifestSchema) {
      return {
        plugin: record,
        config,
        schema: manifestSchema,
        schemaSource: "manifest",
      };
    }

    return {
      plugin: record,
      config,
      schema: inferPluginConfigSchema(config),
      schemaSource: "inferred",
    };
  }

  async updateConfig(
    pluginId: string,
    config: Record<string, unknown>,
    opts: { restart?: boolean } = {},
  ): Promise<PluginConfigUpdateResult> {
    const plugin = this.setConfig(pluginId, config);

    if (opts.restart) {
      const restartResult = await this.restartPlugin(pluginId);
      const refreshed = this.loadRegistry();
      return {
        plugin: this.findRecordOrThrow(refreshed, pluginId),
        restartResult,
      };
    }

    return { plugin };
  }

  async loadPlugin(pluginId: string): Promise<PluginLoadResult> {
    const registry = this.loadRegistry();
    const record = this.findRecordOrThrow(registry, pluginId);

    if (!record.enabled) {
      return {
        pluginId,
        status: "disabled",
        error: "Plugin is disabled. Enable before loading.",
      };
    }

    try {
      const validated = await validateLocalPluginPackage(record.sourcePath);
      if (validated.manifest.id !== record.pluginId) {
        throw new Error(
          `Manifest id changed from ${record.pluginId} to ${validated.manifest.id}; reinstall plugin.`,
        );
      }

      const loaded = (await importModuleFromPath(validated.workerPath)) as WorkerModule;
      const workerApi = resolveWorkerApi(loaded);
      if (typeof workerApi.initialize !== "function") {
        throw new Error(`Worker must implement initialize(input) method: ${validated.workerPath}`);
      }

      await workerApi.initialize(
        buildInitializeInput({
          manifest: validated.manifest,
          instanceId: this.paths.instanceId,
          config: record.config,
        }),
      );

      let health: unknown = { status: "unknown" };
      if (typeof workerApi.health === "function") {
        health = await workerApi.health();
        record.lifecycle.lastHealthAt = nowIso();
      }

      this.running.set(pluginId, { pluginId, api: workerApi });

      record.status = "ready";
      record.lastError = undefined;
      record.lastHealth = health;
      record.updatedAt = nowIso();
      record.lifecycle.loadCount += 1;
      record.lifecycle.lastLoadedAt = nowIso();
      record.lifecycle.lastInitializedAt = nowIso();
      this.saveRegistry(registry);

      return {
        pluginId,
        status: "ready",
        health,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.status = "error";
      record.lastError = message;
      record.updatedAt = nowIso();
      this.saveRegistry(registry);

      return {
        pluginId,
        status: "error",
        error: message,
      };
    }
  }

  async loadAllEnabledPlugins(): Promise<PluginLoadResult[]> {
    const plugins = this.listInstalled().filter((item) => item.enabled);
    const results: PluginLoadResult[] = [];
    for (const plugin of plugins) {
      results.push(await this.loadPlugin(plugin.pluginId));
    }
    return results;
  }

  async shutdownPlugin(pluginId: string, opts: { suppressMissing?: boolean } = {}): Promise<boolean> {
    const running = this.running.get(pluginId);
    if (!running) {
      if (opts.suppressMissing) return false;
      throw new Error(`Plugin is not currently loaded in this host process: ${pluginId}`);
    }

    if (typeof running.api.shutdown === "function") {
      await running.api.shutdown();
    }
    this.running.delete(pluginId);

    const registry = this.loadRegistry();
    const record = this.findRecordOrThrow(registry, pluginId);
    record.lifecycle.lastShutdownAt = nowIso();
    record.updatedAt = nowIso();
    if (!record.enabled) {
      record.status = "disabled";
    }
    this.saveRegistry(registry);

    return true;
  }

  async restartPlugin(pluginId: string): Promise<PluginLoadResult> {
    await this.shutdownPlugin(pluginId, { suppressMissing: true });
    const result = await this.loadPlugin(pluginId);

    if (result.status === "ready") {
      const registry = this.loadRegistry();
      const record = this.findRecordOrThrow(registry, pluginId);
      record.lifecycle.restartCount += 1;
      record.updatedAt = nowIso();
      this.saveRegistry(registry);
    }

    return result;
  }

  async doctor(opts: { pluginId?: string; restartOnFail?: boolean } = {}): Promise<PluginDoctorResult[]> {
    const targets = opts.pluginId
      ? this.listInstalled().filter((item) => item.pluginId === opts.pluginId)
      : this.listInstalled();

    if (opts.pluginId && targets.length === 0) {
      throw new Error(`Plugin not installed: ${opts.pluginId}`);
    }

    const results: PluginDoctorResult[] = [];
    for (const target of targets) {
      if (!target.enabled) {
        results.push({
          pluginId: target.pluginId,
          ok: true,
          status: "disabled",
          health: { skipped: true, reason: "disabled" },
        });
        continue;
      }

      const loaded = await this.loadPlugin(target.pluginId);
      if (loaded.status === "ready") {
        results.push({
          pluginId: target.pluginId,
          ok: true,
          status: "ready",
          health: loaded.health,
        });
        await this.shutdownPlugin(target.pluginId, { suppressMissing: true });
        continue;
      }

      if (opts.restartOnFail) {
        const restarted = await this.restartPlugin(target.pluginId);
        if (restarted.status === "ready") {
          results.push({
            pluginId: target.pluginId,
            ok: true,
            status: "ready",
            health: restarted.health,
          });
          await this.shutdownPlugin(target.pluginId, { suppressMissing: true });
          continue;
        }
      }

      results.push({
        pluginId: target.pluginId,
        ok: false,
        status: "error",
        error: loaded.error ?? "unknown error",
      });
    }

    return results;
  }
}

function createPluginHostService(instance?: string): PluginHostService {
  return new PluginHostService({ instance });
}

export function listInstalledPlugins(opts: PluginCommandCommonOptions): PluginRegistryRecord[] {
  return createPluginHostService(opts.instance).listInstalled();
}

export async function installLocalPlugin(
  localPath: string,
  opts: PluginCommandCommonOptions & { skipBootstrap?: boolean },
): Promise<PluginRegistryRecord> {
  return createPluginHostService(opts.instance).installLocal(localPath, {
    autoLoad: !opts.skipBootstrap,
  });
}

export async function uninstallPlugin(
  pluginId: string,
  opts: PluginCommandCommonOptions & { purgeData?: boolean },
): Promise<PluginRegistryRecord> {
  return createPluginHostService(opts.instance).uninstall(pluginId, {
    purgeData: opts.purgeData,
  });
}

export async function doctorPlugins(
  opts: PluginCommandCommonOptions & { pluginId?: string; restartOnFail?: boolean },
): Promise<PluginDoctorResult[]> {
  return createPluginHostService(opts.instance).doctor({
    pluginId: opts.pluginId,
    restartOnFail: opts.restartOnFail,
  });
}

export async function loadPlugins(
  opts: PluginCommandCommonOptions & { pluginId?: string },
): Promise<PluginLoadResult[]> {
  const host = createPluginHostService(opts.instance);
  if (opts.pluginId) {
    return [await host.loadPlugin(opts.pluginId)];
  }
  return host.loadAllEnabledPlugins();
}

export async function restartPlugin(
  pluginId: string,
  opts: PluginCommandCommonOptions,
): Promise<PluginLoadResult> {
  return createPluginHostService(opts.instance).restartPlugin(pluginId);
}

export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
  opts: PluginCommandCommonOptions,
): Promise<PluginRegistryRecord> {
  return createPluginHostService(opts.instance).setEnabled(pluginId, enabled);
}

export function setPluginConfig(
  pluginId: string,
  config: Record<string, unknown>,
  opts: PluginCommandCommonOptions,
): PluginRegistryRecord {
  return createPluginHostService(opts.instance).setConfig(pluginId, config);
}

export function getPluginConfig(pluginId: string, opts: PluginCommandCommonOptions): Record<string, unknown> {
  return createPluginHostService(opts.instance).getConfig(pluginId);
}

export async function describePluginConfig(
  pluginId: string,
  opts: PluginCommandCommonOptions,
): Promise<PluginConfigDescribeResult> {
  return createPluginHostService(opts.instance).describeConfig(pluginId);
}

export async function updatePluginConfig(
  pluginId: string,
  config: Record<string, unknown>,
  opts: PluginCommandCommonOptions & { restart?: boolean },
): Promise<PluginConfigUpdateResult> {
  return createPluginHostService(opts.instance).updateConfig(pluginId, config, {
    restart: opts.restart,
  });
}
