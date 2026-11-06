/**
 * Cloud managed-config bootstrap (harness → app contract).
 *
 * Instances managed by the Paperclip Cloud harness receive one environment
 * variable, `PAPERCLIP_MANAGED_CONFIG`, holding a single JSON document:
 *
 *   {
 *     "v": 1,
 *     "mode": "cloud",
 *     "catalogVersion": "2026.720.0",
 *     "features": { "<feature-key>": true | false, ... },
 *     "plugins":  { "autoInstall": ["daytona", "remote-host"] },
 *     "environments": [
 *       { "name": "Daytona", "provider": "daytona", "config": { "target": "us" } },
 *       {
 *         "name": "Remote Host",
 *         "driver": "plugin",
 *         "pluginKey": "example.remote-host-plugin",
 *         "driverKey": "tasks",
 *         "driverConfig": {},
 *         "instanceDefault": true
 *       }
 *     ]
 *   }
 *
 * An `environments` entry without `driver` is the single sandbox entry; any
 * number of `driver: "plugin"` entries may sit beside it (see
 * `MANAGED_ENVIRONMENT_DRIVERS`).
 *
 * Parsing follows the `execution-policy-bootstrap.ts` doctrine: a pure
 * function over `Record<string, string | undefined>`, strict, and fail
 * closed — bad JSON, an unsupported `v`, an unknown feature key, a feature
 * key this build's feature catalog does not mark tier "managed", or any
 * malformed section throws with a precise error so a managed instance
 * refuses to start instead of silently dropping a security control. Only an
 * ABSENT env var means self-hosted (no overlay, zero behavior change); a
 * present-but-blank value or a document missing the `features` or
 * `plugins.autoInstall` sections is malformed and fails startup, so a
 * harness misconfiguration can never silently drop the managed overlay.
 *
 * Unlike the execution-policy bootstrap, the parsed document is NEVER
 * persisted. `instanceSettingsService` overlays it at read time, so a DB
 * restore or manual row edit cannot resurrect a capability the harness has
 * disabled (see `applyManagedExperimentalOverlay` in instance-settings.ts).
 */

import {
  INSTANCE_FEATURE_CATALOG,
  instanceExperimentalSettingsSchema,
  type ManagedExperimentalFeatureKey,
} from "@paperclipai/shared";

export type ManagedConfigEnv = Record<string, string | undefined>;

export const MANAGED_CONFIG_ENV_KEY = "PAPERCLIP_MANAGED_CONFIG";
export const SUPPORTED_MANAGED_CONFIG_VERSION = 1;

export interface ManagedInstanceConfig {
  v: typeof SUPPORTED_MANAGED_CONFIG_VERSION;
  mode: "cloud";
  /** App feature-catalog version the document was validated against. */
  catalogVersion: string;
  features: Readonly<Partial<Record<ManagedExperimentalFeatureKey, boolean>>>;
  plugins: {
    readonly autoInstall: readonly string[];
    readonly workerEnv?: Readonly<Record<string, readonly string[]>>;
    readonly enabledCompanies?: Readonly<Record<string, readonly string[]>>;
  };
  /**
   * The sandbox entry of the `environments` section: zero or one, since it
   * provisions the single Paperclip-managed sandbox slot (empty when the
   * section is absent or declares only plugin entries).
   */
  environments: readonly ManagedEnvironmentSpec[];
  /** The `driver: "plugin"` entries of the `environments` section (empty when none are declared). */
  pluginEnvironments: readonly ManagedPluginEnvironmentSpec[];
}

/**
 * The environment drivers a managed-config `environments` entry may declare.
 * An entry without `driver` is the sandbox entry, so documents written
 * before plugin entries existed parse unchanged.
 */
export const MANAGED_ENVIRONMENT_DRIVERS = ["sandbox", "plugin"] as const;

/**
 * The managed-config capabilities this build supports. The control plane
 * reads them from `managed-config-capabilities.json` (next to this file) at
 * a release commit, and sends a section only to a release that lists its
 * capability. `managed-config-capabilities.test.ts` keeps that file equal to
 * this list, and the parser accepts each section only while its capability
 * is listed here, so the two cannot drift.
 *
 * - `pluginEnvironments`: `driver: "plugin"` entries in `environments`,
 *   including their one-time `instanceDefault`.
 */
export const MANAGED_CONFIG_CAPABILITIES_SCHEMA_VERSION = 1;
export const MANAGED_CONFIG_CAPABILITIES = ["pluginEnvironments"] as const;
export type ManagedConfigCapability = (typeof MANAGED_CONFIG_CAPABILITIES)[number];

function supportsCapability(capability: ManagedConfigCapability): boolean {
  return (MANAGED_CONFIG_CAPABILITIES as readonly string[]).includes(capability);
}
export type ManagedEnvironmentDriver = (typeof MANAGED_ENVIRONMENT_DRIVERS)[number];

/**
 * One declared managed plugin environment: an instance-level `plugin`-driver
 * environment row served by an auto-installed plugin's environment driver.
 * The row is
 * identified by its `pluginKey`–`driverKey` pair, which boot stamps on the
 * row as `metadata.managedPluginEnvironment`.
 */
export interface ManagedPluginEnvironmentSpec {
  driver: "plugin";
  /** Display name of the instance-level environment row (unique per instance). */
  name: string;
  description?: string;
  /**
   * The serving plugin's manifest id (for example
   * `example.remote-host-plugin`), not its `plugins.autoInstall` catalog key.
   * Boot requires a catalog entry
   * whose `key` is in `plugins.autoInstall` to install this id.
   */
  pluginKey: string;
  /** The plugin's environment driver key. */
  driverKey: string;
  /** Driver config, validated by the plugin at ensure time; never carries secrets. */
  driverConfig: Readonly<Record<string, unknown>>;
  /**
   * Make this environment the instance default once per instance, at the
   * first boot that sees the flag, and only while the instance has no agents
   * (see `applyManagedPluginInstanceDefault`).
   */
  instanceDefault: boolean;
}

/**
 * One declared managed sandbox environment. Provider-agnostic: `provider` is
 * the sandbox plugin's driver key (== its `plugins.autoInstall` catalog key),
 * and `config` is stored verbatim in the environment row for the plugin to
 * validate at lease time — the same split `ensureKubernetesEnvironment` has
 * always used, generalized to any bundled sandbox provider.
 */
export interface ManagedEnvironmentSpec {
  /** Display name of the instance-level environment row (unique per instance). */
  name: string;
  description?: string;
  /** Sandbox provider key (the plugin's driverKey, e.g. "daytona"). */
  provider: string;
  /** Provider config stored in `environment.config`; never carries secrets. */
  config: Readonly<Record<string, unknown>>;
}

/**
 * Managed-config documents deliver NO secrets, ever. Provider credentials
 * reach a managed instance as process environment variables (every bundled
 * sandbox provider falls back to its env var when `config` omits the key,
 * e.g. `DAYTONA_API_KEY`), so any secret-looking config key in the document
 * is a misrouted credential and fails startup. The environments API reuses
 * this pattern to floor credential-shaped config keys out of
 * platform-provisioned environment responses on managed instances.
 */
export const SECRET_LIKE_CONFIG_KEY_PATTERN = /(api[-_]?key|token|secret|password|credential)/i;

const WORKER_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const COMPANY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const WORKER_ENV_DENIED_NAME_PATTERN =
  /(^|_)(AWS|CREDENTIAL|CREDENTIALS|DATABASE|DSN|JWT|KEY|KEYS|PASSWORD|POSTGRES|PRIVATE|SECRET|SECRETS|SIGNING|TOKEN)(_|$)|^(DB|DYLD|LD|NODE)_|^(PATH|PAPERCLIP_MANAGED_CONFIG)$/;

function findSecretLikeConfigKey(value: Record<string, unknown>, path: string): string | null {
  for (const [key, child] of Object.entries(value)) {
    const childPath = path.length > 0 ? `${path}.${key}` : key;
    if (SECRET_LIKE_CONFIG_KEY_PATTERN.test(key)) return childPath;
    const nested = findSecretLikeConfigKeyInValue(child, childPath);
    if (nested) return nested;
  }
  return null;
}

/** Objects and arrays at any depth, including arrays nested in arrays. */
function findSecretLikeConfigKeyInValue(value: unknown, path: string): string | null {
  if (isPlainObject(value)) return findSecretLikeConfigKey(value, path);
  if (!Array.isArray(value)) return null;
  for (const [index, element] of value.entries()) {
    const nested = findSecretLikeConfigKeyInValue(element, `${path}[${index}]`);
    if (nested) return nested;
  }
  return null;
}

let cachedFeatureKeys: ReadonlySet<string> | null = null;

/**
 * The set of feature keys a managed-config document may target: the boolean
 * flag keys of `instanceExperimentalSettingsSchema`. The schema is the
 * manifest — server-managed bookkeeping fields (activation cutoffs, lookback
 * hours) are not booleans and are excluded by construction.
 */
export function managedFeatureKeySet(): ReadonlySet<string> {
  if (!cachedFeatureKeys) {
    const defaults = instanceExperimentalSettingsSchema.parse({}) as Record<string, unknown>;
    cachedFeatureKeys = new Set(
      Object.keys(defaults).filter((key) => typeof defaults[key] === "boolean"),
    );
  }
  return cachedFeatureKeys;
}

function fail(detail: string): never {
  throw new Error(`${MANAGED_CONFIG_ENV_KEY} ${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `${JSON.stringify(value)}`;
}

const SANDBOX_ENTRY_KEYS = ["name", "description", "driver", "provider", "config"] as const;
const PLUGIN_ENTRY_KEYS = [
  "name",
  "description",
  "driver",
  "pluginKey",
  "driverKey",
  "driverConfig",
  "instanceDefault",
] as const;
/** Same rule as the plugin environment config schema in `environment-config.ts`. */
const PLUGIN_DRIVER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function requireTrimmedString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`"${path}" must be a non-empty string without surrounding whitespace (got ${describeJsonValue(value)})`);
  }
  return value;
}

function readOptionalDescription(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`"${path}" must be a non-empty string when present (got ${describeJsonValue(value)})`);
  }
  return value;
}

function readSecretFreeObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    fail(`"${path}" must be an object (got ${describeJsonValue(value)})`);
  }
  const secretLikeKey = findSecretLikeConfigKey(value, "");
  if (secretLikeKey) {
    fail(
      `"${path}" key "${secretLikeKey}" looks secret-bearing; credentials are delivered to managed instances as process environment variables (the provider's documented env fallback), never in the managed-config document`,
    );
  }
  return { ...value };
}

/**
 * Parse the `environments` section: at most one sandbox entry (no `driver`,
 * or `driver: "sandbox"`) plus any number of `driver: "plugin"` entries.
 * Names are unique across the section, and plugin entries are unique by
 * their `pluginKey`–`driverKey` pair.
 */
function parseManagedEnvironmentsSection(
  raw: unknown,
  autoInstall: readonly string[],
): { sandbox: ManagedEnvironmentSpec[]; plugin: ManagedPluginEnvironmentSpec[] } {
  const sandbox: ManagedEnvironmentSpec[] = [];
  const plugin: ManagedPluginEnvironmentSpec[] = [];
  if (raw === undefined) return { sandbox, plugin };
  if (!Array.isArray(raw)) {
    fail(`"environments" must be an array of environment objects (got ${describeJsonValue(raw)})`);
  }
  const names = new Set<string>();
  const pluginDrivers = new Set<string>();
  let instanceDefaultIndex: number | null = null;
  for (const [index, entry] of raw.entries()) {
    const at = `environments[${index}]`;
    if (!isPlainObject(entry)) {
      fail(`"${at}" must be an object (got ${describeJsonValue(entry)})`);
    }
    // Only an absent `driver` means the sandbox entry; an explicit `null` is malformed.
    const driver = entry.driver === undefined ? "sandbox" : entry.driver;
    if (!(MANAGED_ENVIRONMENT_DRIVERS as readonly unknown[]).includes(driver)) {
      fail(
        `"${at}.driver" must be one of ${MANAGED_ENVIRONMENT_DRIVERS.map((value) => JSON.stringify(value)).join(", ")} when present (got ${describeJsonValue(entry.driver)})`,
      );
    }
    if (driver === "plugin" && !supportsCapability("pluginEnvironments")) {
      fail(`"${at}.driver" is "plugin", but this build does not list the "pluginEnvironments" managed-config capability`);
    }
    if (driver === "sandbox" && entry.instanceDefault !== undefined) {
      fail(
        `"${at}.instanceDefault" is not allowed on the sandbox entry; only a plugin entry may become the instance default (the sandbox entry's default is governed by enableManagedSandboxOnly)`,
      );
    }
    const allowedKeys: readonly string[] = driver === "plugin" ? PLUGIN_ENTRY_KEYS : SANDBOX_ENTRY_KEYS;
    for (const key of Object.keys(entry)) {
      if (!allowedKeys.includes(key)) {
        fail(`"${at}" has unknown key "${key}" (allowed for a ${driver} entry: ${allowedKeys.join(", ")})`);
      }
    }
    const name = requireTrimmedString(entry.name, `${at}.name`);
    if (names.has(name)) {
      fail(`"${at}.name" duplicates another entry's name "${name}"; environment names are unique per instance`);
    }
    names.add(name);
    const description = readOptionalDescription(entry.description, `${at}.description`);

    if (driver === "sandbox") {
      // The DB enforces at most ONE Paperclip-managed sandbox row per instance
      // (partial unique index `environments_managed_sandbox_idx`); every
      // sandbox entry provisions that row, so a second one can never be
      // satisfied.
      if (sandbox.length > 0) {
        fail(
          `"environments" supports at most one sandbox entry: each sandbox entry provisions the single Paperclip-managed sandbox environment (DB invariant environments_managed_sandbox_idx)`,
        );
      }
      const provider = requireTrimmedString(entry.provider, `${at}.provider`);
      // Coherence: on a managed instance the control plane is the only plugin
      // install path, so an environment whose provider plugin is not
      // auto-installed could never serve a lease. Catch the skew at parse time.
      if (!autoInstall.includes(provider)) {
        fail(
          `"${at}.provider" is "${provider}", which is not in "plugins.autoInstall"; a managed environment requires its provider plugin to be provisioned`,
        );
      }
      if (isPlainObject(entry.config) && entry.config.provider !== undefined) {
        fail(`"${at}.config" must not set "provider"; it is forced from the entry's provider key`);
      }
      const config = readSecretFreeObject(entry.config, `${at}.config`);
      sandbox.push(
        Object.freeze({
          name,
          ...(description !== undefined ? { description } : {}),
          provider,
          config: Object.freeze(config),
        }) as ManagedEnvironmentSpec,
      );
      continue;
    }

    // `pluginKey` is the plugin's manifest id (what the row's config stores),
    // not a `plugins.autoInstall` catalog key, so this pure parser cannot map
    // it. `applyManagedEnvironments` refuses startup when no auto-installed
    // catalog entry installs this manifest id.
    const pluginKey = requireTrimmedString(entry.pluginKey, `${at}.pluginKey`);
    const driverKey = requireTrimmedString(entry.driverKey, `${at}.driverKey`);
    if (!PLUGIN_DRIVER_KEY_PATTERN.test(driverKey)) {
      fail(
        `"${at}.driverKey" must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, hyphens, or underscores (got ${describeJsonValue(driverKey)})`,
      );
    }
    const pair = `${pluginKey}:${driverKey}`;
    if (pluginDrivers.has(pair)) {
      fail(`"${at}" duplicates another plugin entry's pluginKey and driverKey ("${pair}"); each plugin environment driver is declared once`);
    }
    pluginDrivers.add(pair);
    const driverConfig = readSecretFreeObject(entry.driverConfig, `${at}.driverConfig`);
    if (entry.instanceDefault !== undefined && typeof entry.instanceDefault !== "boolean") {
      fail(`"${at}.instanceDefault" must be a boolean when present (got ${describeJsonValue(entry.instanceDefault)})`);
    }
    const instanceDefault = entry.instanceDefault === true;
    if (instanceDefault) {
      if (instanceDefaultIndex !== null) {
        fail(
          `"${at}.instanceDefault" is also set on environments[${instanceDefaultIndex}]; at most one entry may become the instance default`,
        );
      }
      instanceDefaultIndex = index;
    }
    plugin.push(
      Object.freeze({
        driver: "plugin",
        name,
        ...(description !== undefined ? { description } : {}),
        pluginKey,
        driverKey,
        driverConfig: Object.freeze(driverConfig),
        instanceDefault,
      }) as ManagedPluginEnvironmentSpec,
    );
  }
  return { sandbox, plugin };
}

/**
 * Parse `PAPERCLIP_MANAGED_CONFIG` from a raw env map. Returns null only when
 * the variable is absent (self-hosted). Throws with a precise error on a
 * present-but-blank value or any malformed document so a cloud instance fails
 * to start (fail closed).
 */
export function parseManagedConfigEnv(env: ManagedConfigEnv): ManagedInstanceConfig | null {
  const raw = env[MANAGED_CONFIG_ENV_KEY];
  if (raw === undefined) return null;
  if (raw.trim().length === 0) {
    fail(
      "is set but blank; a managed instance requires the full JSON document (unset the variable entirely for self-hosted mode)",
    );
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    fail(`is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(doc)) {
    fail(`must be a JSON object (got ${describeJsonValue(doc)})`);
  }

  const allowedTopLevelKeys = new Set(["v", "mode", "catalogVersion", "features", "plugins", "environments"]);
  for (const key of Object.keys(doc)) {
    if (!allowedTopLevelKeys.has(key)) {
      fail(`has unknown top-level key "${key}" (allowed: v, mode, catalogVersion, features, plugins, environments)`);
    }
  }

  if (doc.v !== SUPPORTED_MANAGED_CONFIG_VERSION) {
    fail(
      `has unsupported "v" ${describeJsonValue(doc.v)}; this build supports v=${SUPPORTED_MANAGED_CONFIG_VERSION}`,
    );
  }
  if (doc.mode !== "cloud") {
    fail(`has invalid "mode" ${describeJsonValue(doc.mode)}; expected "cloud"`);
  }
  if (typeof doc.catalogVersion !== "string" || doc.catalogVersion.trim().length === 0) {
    fail(`requires a non-empty string "catalogVersion" (got ${describeJsonValue(doc.catalogVersion)})`);
  }

  // The cloud contract is the FULL document: `features` and
  // `plugins.autoInstall` are required (empty {} / [] are fine). A missing
  // section means a truncated or mis-built document, and defaulting it to
  // empty would silently drop the managed overlay or auto-install list.
  // `plugins.autoInstall` is validated here as part of the atomic v1
  // document; the bundled-plugin provisioning path that consumes it lands in
  // the follow-up PR that generalizes `ensureBundledKubernetesPlugin`.
  const features: Partial<Record<ManagedExperimentalFeatureKey, boolean>> = {};
  if (doc.features === undefined) {
    fail(`requires a "features" object mapping feature key → boolean (use {} for none)`);
  }
  if (!isPlainObject(doc.features)) {
    fail(`"features" must be an object mapping feature key → boolean (got ${describeJsonValue(doc.features)})`);
  }
  const knownKeys = managedFeatureKeySet();
  for (const [key, value] of Object.entries(doc.features)) {
    if (key === "enablePipelines" && typeof value === "boolean") continue;
    if (!knownKeys.has(key)) {
      fail(
        `"features" has unknown feature key "${key}"; known keys are the boolean flags of instanceExperimentalSettingsSchema`,
      );
    }
    // Catalog-compatibility enforcement: the key exists in this build, but the
    // control plane may only manage keys this build's feature catalog marks
    // tier "managed". A key whose tier differs (a tenant `preference`, a
    // code-pinned `floor`, or a tier demoted since the document's
    // `catalogVersion` was published) is version skew — refuse startup rather
    // than apply a control with mismatched catalog semantics.
    const tier = INSTANCE_FEATURE_CATALOG[key as ManagedExperimentalFeatureKey].tier;
    if (tier !== "managed") {
      fail(
        `"features" key "${key}" has tier "${tier}" in this build's feature catalog; only tier "managed" keys may be set by a managed-config document (catalogVersion ${JSON.stringify(doc.catalogVersion)} is incompatible with this build)`,
      );
    }
    if (typeof value !== "boolean") {
      fail(`"features.${key}" must be a boolean (got ${describeJsonValue(value)})`);
    }
    features[key as ManagedExperimentalFeatureKey] = value;
  }

  const autoInstall: string[] = [];
  if (doc.plugins === undefined) {
    fail(`requires a "plugins" object with an "autoInstall" array (use { "autoInstall": [] } for none)`);
  }
  if (!isPlainObject(doc.plugins)) {
    fail(`"plugins" must be an object (got ${describeJsonValue(doc.plugins)})`);
  }
  for (const key of Object.keys(doc.plugins)) {
    if (key !== "autoInstall" && key !== "workerEnv" && key !== "enabledCompanies") {
      fail(`"plugins" has unknown key "${key}" (allowed: autoInstall, workerEnv, enabledCompanies)`);
    }
  }
  const rawAutoInstall = doc.plugins.autoInstall;
  if (rawAutoInstall === undefined) {
    fail(`requires a "plugins.autoInstall" array of plugin keys (use [] for none)`);
  }
  if (!Array.isArray(rawAutoInstall)) {
    fail(`"plugins.autoInstall" must be an array of plugin keys (got ${describeJsonValue(rawAutoInstall)})`);
  }
  for (const entry of rawAutoInstall) {
    if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry) {
      fail(
        `"plugins.autoInstall" entries must be non-empty strings without surrounding whitespace (got ${describeJsonValue(entry)})`,
      );
    }
    if (autoInstall.includes(entry)) {
      fail(`"plugins.autoInstall" has duplicate entry "${entry}"`);
    }
    autoInstall.push(entry);
  }

  let workerEnv: Record<string, readonly string[]> | undefined;
  if (doc.plugins.workerEnv !== undefined) {
    if (!isPlainObject(doc.plugins.workerEnv)) {
      fail(`"plugins.workerEnv" must be an object mapping plugin key → variable names (got ${describeJsonValue(doc.plugins.workerEnv)})`);
    }
    workerEnv = Object.create(null) as Record<string, readonly string[]>;
    for (const [key, names] of Object.entries(doc.plugins.workerEnv)) {
      if (!autoInstall.includes(key)) {
        fail(`"plugins.workerEnv" key "${key}" is not in "plugins.autoInstall"; a grant requires its plugin to be provisioned`);
      }
      if (!Array.isArray(names) || names.length === 0) {
        fail(`"plugins.workerEnv.${key}" must be a non-empty array of variable names (got ${describeJsonValue(names)})`);
      }
      const granted: string[] = [];
      for (const name of names) {
        if (typeof name !== "string" || !WORKER_ENV_NAME_PATTERN.test(name)) {
          fail(`"plugins.workerEnv.${key}" entries must be uppercase variable names (got ${describeJsonValue(name)})`);
        }
        if (WORKER_ENV_DENIED_NAME_PATTERN.test(name)) {
          fail(`"plugins.workerEnv.${key}" must not grant host credential or loader variable "${name}"`);
        }
        if (granted.includes(name)) {
          fail(`"plugins.workerEnv.${key}" has duplicate entry "${name}"`);
        }
        granted.push(name);
      }
      workerEnv[key] = Object.freeze(granted);
    }
  }

  let enabledCompanies: Record<string, readonly string[]> | undefined;
  if (doc.plugins.enabledCompanies !== undefined) {
    if (!isPlainObject(doc.plugins.enabledCompanies)) {
      fail(`"plugins.enabledCompanies" must be an object mapping plugin key → company ids (got ${describeJsonValue(doc.plugins.enabledCompanies)})`);
    }
    enabledCompanies = Object.create(null) as Record<string, readonly string[]>;
    for (const [key, ids] of Object.entries(doc.plugins.enabledCompanies)) {
      if (!autoInstall.includes(key)) {
        fail(`"plugins.enabledCompanies" key "${key}" is not in "plugins.autoInstall"; enabling a company requires its plugin to be provisioned`);
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        fail(`"plugins.enabledCompanies.${key}" must be a non-empty array of company ids (got ${describeJsonValue(ids)})`);
      }
      const companyIds: string[] = [];
      for (const id of ids) {
        if (typeof id !== "string" || !COMPANY_ID_PATTERN.test(id)) {
          fail(`"plugins.enabledCompanies.${key}" entries must be lowercase company UUIDs (got ${describeJsonValue(id)})`);
        }
        if (companyIds.includes(id)) {
          fail(`"plugins.enabledCompanies.${key}" has duplicate entry "${id}"`);
        }
        companyIds.push(id);
      }
      enabledCompanies[key] = Object.freeze(companyIds);
    }
  }

  // `environments` is OPTIONAL, unlike `features` and `plugins`: documents
  // delivered before the section existed must keep booting newer builds (a
  // fleet image roll cannot be lockstepped with a config re-delivery), and
  // absence is not a dropped security control — it simply declares no managed
  // environments. When present, the section is validated fail-closed like
  // everything else.
  const { sandbox: environmentSpecs, plugin: pluginEnvironmentSpecs } = parseManagedEnvironmentsSection(
    doc.environments,
    autoInstall,
  );

  return Object.freeze({
    v: SUPPORTED_MANAGED_CONFIG_VERSION,
    mode: "cloud",
    catalogVersion: doc.catalogVersion,
    features: Object.freeze(features),
    plugins: Object.freeze({
      autoInstall: Object.freeze(autoInstall),
      ...(workerEnv ? { workerEnv: Object.freeze(workerEnv) } : {}),
      ...(enabledCompanies ? { enabledCompanies: Object.freeze(enabledCompanies) } : {}),
    }),
    environments: Object.freeze(environmentSpecs),
    pluginEnvironments: Object.freeze(pluginEnvironmentSpecs),
  }) as ManagedInstanceConfig;
}

let cache: { raw: string | undefined; config: ManagedInstanceConfig | null } | null = null;

/**
 * Parse-once accessor keyed on the raw env value. Callers that pass a custom
 * env (tests) get a fresh parse whenever the raw value differs; process.env
 * callers share one parsed document for the process lifetime.
 */
export function getManagedInstanceConfig(
  env: ManagedConfigEnv = process.env,
): ManagedInstanceConfig | null {
  const raw = env[MANAGED_CONFIG_ENV_KEY];
  if (cache && cache.raw === raw) return cache.config;
  const config = parseManagedConfigEnv(env);
  cache = { raw, config };
  return config;
}
