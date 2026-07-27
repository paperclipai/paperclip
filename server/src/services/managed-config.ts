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
 *     "plugins":  { "autoInstall": ["daytona", "kubernetes"] },
 *     "environments": [
 *       { "name": "Daytona", "provider": "daytona", "config": { "target": "us" } }
 *     ]
 *   }
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
  plugins: { readonly autoInstall: readonly string[] };
  /** Sandbox environments the control plane provisions at boot (empty when the section is absent). */
  environments: readonly ManagedEnvironmentSpec[];
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
 * is a misrouted credential and fails startup.
 */
const SECRET_LIKE_CONFIG_KEY_PATTERN = /(api[-_]?key|token|secret|password|credential)/i;

function findSecretLikeConfigKey(value: Record<string, unknown>, path: string): string | null {
  for (const [key, child] of Object.entries(value)) {
    const childPath = path.length > 0 ? `${path}.${key}` : key;
    if (SECRET_LIKE_CONFIG_KEY_PATTERN.test(key)) return childPath;
    if (isPlainObject(child)) {
      const nested = findSecretLikeConfigKey(child, childPath);
      if (nested) return nested;
    } else if (Array.isArray(child)) {
      for (const [index, element] of child.entries()) {
        if (!isPlainObject(element)) continue;
        const nested = findSecretLikeConfigKey(element, `${childPath}[${index}]`);
        if (nested) return nested;
      }
    }
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
    if (key !== "autoInstall") {
      fail(`"plugins" has unknown key "${key}" (allowed: autoInstall)`);
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

  // `environments` is OPTIONAL, unlike `features` and `plugins`: documents
  // delivered before the section existed must keep booting newer builds (a
  // fleet image roll cannot be lockstepped with a config re-delivery), and
  // absence is not a dropped security control — it simply declares no managed
  // environments. When present, the section is validated fail-closed like
  // everything else.
  const environmentSpecs: ManagedEnvironmentSpec[] = [];
  if (doc.environments !== undefined) {
    if (!Array.isArray(doc.environments)) {
      fail(`"environments" must be an array of environment objects (got ${describeJsonValue(doc.environments)})`);
    }
    // The DB enforces at most ONE Paperclip-managed sandbox row per instance
    // (partial unique index `environments_managed_sandbox_idx`); every entry
    // here provisions that row, so a longer list can never be satisfied.
    if (doc.environments.length > 1) {
      fail(
        `"environments" supports at most one entry: each entry provisions the single Paperclip-managed sandbox environment (DB invariant environments_managed_sandbox_idx)`,
      );
    }
    for (const [index, entry] of doc.environments.entries()) {
      if (!isPlainObject(entry)) {
        fail(`"environments[${index}]" must be an object (got ${describeJsonValue(entry)})`);
      }
      const allowedEntryKeys = new Set(["name", "description", "provider", "config"]);
      for (const key of Object.keys(entry)) {
        if (!allowedEntryKeys.has(key)) {
          fail(`"environments[${index}]" has unknown key "${key}" (allowed: name, description, provider, config)`);
        }
      }
      if (typeof entry.name !== "string" || entry.name.length === 0 || entry.name.trim() !== entry.name) {
        fail(
          `"environments[${index}].name" must be a non-empty string without surrounding whitespace (got ${describeJsonValue(entry.name)})`,
        );
      }
      if (
        entry.description !== undefined
        && (typeof entry.description !== "string" || entry.description.trim().length === 0)
      ) {
        fail(`"environments[${index}].description" must be a non-empty string when present (got ${describeJsonValue(entry.description)})`);
      }
      if (typeof entry.provider !== "string" || entry.provider.length === 0 || entry.provider.trim() !== entry.provider) {
        fail(
          `"environments[${index}].provider" must be a non-empty string without surrounding whitespace (got ${describeJsonValue(entry.provider)})`,
        );
      }
      // Coherence: on a managed instance the control plane is the only plugin
      // install path, so an environment whose provider plugin is not
      // auto-installed could never serve a lease. Catch the skew at parse time.
      if (!autoInstall.includes(entry.provider)) {
        fail(
          `"environments[${index}].provider" is "${entry.provider}", which is not in "plugins.autoInstall"; a managed environment requires its provider plugin to be provisioned`,
        );
      }
      const config: Record<string, unknown> = {};
      if (entry.config !== undefined) {
        if (!isPlainObject(entry.config)) {
          fail(`"environments[${index}].config" must be an object (got ${describeJsonValue(entry.config)})`);
        }
        if (entry.config.provider !== undefined) {
          fail(`"environments[${index}].config" must not set "provider"; it is forced from the entry's provider key`);
        }
        const secretLikeKey = findSecretLikeConfigKey(entry.config, "");
        if (secretLikeKey) {
          fail(
            `"environments[${index}].config" key "${secretLikeKey}" looks secret-bearing; credentials are delivered to managed instances as process environment variables (the provider's documented env fallback), never in the managed-config document`,
          );
        }
        Object.assign(config, entry.config);
      }
      environmentSpecs.push(
        Object.freeze({
          name: entry.name,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          provider: entry.provider,
          config: Object.freeze(config),
        }) as ManagedEnvironmentSpec,
      );
    }
  }

  return Object.freeze({
    v: SUPPORTED_MANAGED_CONFIG_VERSION,
    mode: "cloud",
    catalogVersion: doc.catalogVersion,
    features: Object.freeze(features),
    plugins: Object.freeze({ autoInstall: Object.freeze(autoInstall) }),
    environments: Object.freeze(environmentSpecs),
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
