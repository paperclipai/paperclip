import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { plugins, pluginCompanySettings, type Db } from "@paperclipai/db";
import {
  parseRunnerHarnessDeclaration,
  parseRunnerHarnessReleaseIdentity,
  type RunnerHarnessDeclaration,
  type RunnerHarnessReleaseIdentity,
} from "@paperclipai/runner-sdk/contracts";
import type { PluginRecord } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { isCloudManagedInstance } from "./cloud-instance.js";
import type { PluginLoaderOptions } from "./plugin-loader.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, resolvePluginPackageRoot } from "./plugin-package-root.js";
import { validateInstanceConfig } from "./plugin-config-validator.js";

export interface PublicRunnerHarness {
  harnessId: string;
  pluginKey: string;
  packageName: string;
  version: string;
  displayName: string;
  configSchema: RunnerHarnessDeclaration["configSchema"];
  platforms: RunnerHarnessDeclaration["platforms"];
  capabilities: RunnerHarnessDeclaration["capabilities"];
  credentials?: RunnerHarnessDeclaration["credentials"];
  protocolVersion: 1;
}

export interface ResolvedRunnerHarness {
  pluginId: string;
  pluginKey: string;
  declaration: RunnerHarnessDeclaration;
  release: RunnerHarnessReleaseIdentity;
  packageRoot: string;
  entrypoint: string;
}

export interface RunnerHarnessRegistryOptions {
  localPluginDir?: string;
  resolvePackageRoot?: PluginLoaderOptions["resolvePackageRoot"];
  assertPackageActivation?: PluginLoaderOptions["assertPackageActivation"];
}

type Candidate = { plugin: PluginRecord; enabled: boolean | null };
type CandidateSource = (companyId: string, pluginKey?: string) => Promise<Candidate[]>;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_FILES = 10_000;

function unavailable() {
  return unprocessable("The selected Runner harness is not installed and enabled for this company.", {
    code: "runner_harness_unavailable",
  });
}

function invalidPackage() {
  return unprocessable("The selected Runner harness package failed integrity verification. Reinstall its approved package.", {
    code: "runner_harness_integrity_invalid",
  });
}

/**
 * V1 accepts a self-contained runtime bundle: all runtime assets and dependencies
 * must live below the package root. No registry request, import, or process runs
 * while resolving it. Its SRI describes these installed bytes, not an npm tarball.
 */
async function packageInventory(root: string) {
  const inventory: Array<[string, string, number]> = [];
  let bytes = 0;
  async function visit(directory: string, relative = "", depth = 0): Promise<void> {
    if (depth > 32) throw invalidPackage();
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const relativeName = relative ? `${relative}/${name}` : name;
      const filename = path.join(directory, name);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) throw invalidPackage();
      if (stat.isDirectory()) {
        await visit(filename, relativeName, depth + 1);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_PACKAGE_BYTES || inventory.length >= MAX_PACKAGE_FILES) throw invalidPackage();
        const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.size !== stat.size) throw invalidPackage();
          const digest = createHash("sha256");
          let readBytes = 0;
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            readBytes += chunk.length;
            if (readBytes > opened.size) throw invalidPackage();
            digest.update(chunk);
          }
          if (readBytes !== opened.size) throw invalidPackage();
          inventory.push([relativeName, `sha256:${digest.digest("hex")}`, opened.mode & 0o777]);
        } finally {
          await file.close();
        }
      } else throw invalidPackage();
    }
  }
  await visit(root);
  if (!inventory.length) throw invalidPackage();
  const digest = createHash("sha256").update(JSON.stringify(inventory)).digest();
  return { inventory, integrity: `sha256-${digest.toString("base64")}`, runtimeDigest: `sha256:${digest.toString("hex")}` };
}

/** Narrow dependency seam also used by package tests with real filesystem bytes. */
export function createRunnerHarnessRegistry(source: CandidateSource, options: RunnerHarnessRegistryOptions = {}) {
  async function packageRoot(plugin: PluginRecord) {
    // Managed images must use the same source and activation guard as the plugin
    // loader. Never fall back to a local/npm copy of a removed image package.
    if (isCloudManagedInstance() && (!options.resolvePackageRoot || !options.assertPackageActivation)) throw unavailable();
    const root = options.resolvePackageRoot
      ? options.resolvePackageRoot(plugin)
      : resolvePluginPackageRoot(plugin, options.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR);
    options.assertPackageActivation?.({
      pluginKey: plugin.pluginKey, packageRoot: root,
      installedPackagePath: plugin.packagePath, manifest: plugin.manifestJson,
    });
    return await realpath(root);
  }

  function declarations(candidate: Candidate) {
    const { plugin, enabled } = candidate;
    if (plugin.status !== "ready" || enabled === false
      || plugin.manifestJson.id !== plugin.pluginKey
      || plugin.manifestJson.version !== plugin.version
      || !plugin.manifestJson.capabilities.includes("runner.harnesses.register")) return [];
    const declared = (plugin.manifestJson.runnerHarnesses ?? []).map(parseRunnerHarnessDeclaration);
    if (new Set(declared.map(harness => harness.harnessKey)).size !== declared.length) throw unavailable();
    return declared;
  }

  return {
    /** Metadata discovery performs no provider launch or runtime inventory scan. */
    async list(companyId: string): Promise<PublicRunnerHarness[]> {
      const result: PublicRunnerHarness[] = [];
      for (const candidate of await source(companyId)) {
        const declared = declarations(candidate);
        if (!declared.length) continue;
        await packageRoot(candidate.plugin);
        for (const declaration of declared) {
          result.push({
            harnessId: `${candidate.plugin.pluginKey}/${declaration.harnessKey}`,
            pluginKey: candidate.plugin.pluginKey, packageName: candidate.plugin.packageName,
            version: candidate.plugin.version, displayName: declaration.displayName,
            configSchema: structuredClone(declaration.configSchema), platforms: [...declaration.platforms],
            capabilities: { ...declaration.capabilities }, protocolVersion: 1,
            ...(declaration.credentials ? { credentials: structuredClone(declaration.credentials) } : {}),
          });
        }
      }
      return result.sort((left, right) => left.harnessId.localeCompare(right.harnessId));
    },

    /** Fresh company eligibility and installed bytes are checked at admission. */
    async resolve(companyId: string, harnessId: string): Promise<ResolvedRunnerHarness> {
      const parts = harnessId.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw unavailable();
      for (const candidate of await source(companyId, parts[0])) {
        if (candidate.plugin.pluginKey !== parts[0]) continue;
        const declaration = declarations(candidate).find(harness => harness.harnessKey === parts[1]);
        if (!declaration) continue;
        try {
          const root = await packageRoot(candidate.plugin);
          const { inventory, integrity, runtimeDigest } = await packageInventory(root);
          const entry = inventory.find(([filename]) => filename === declaration.runtime.entrypoint);
          if (!entry || entry[1] !== declaration.runtime.sha256) throw invalidPackage();
          const packageFile = await open(path.join(root, "package.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
          let metadata: { name?: unknown; version?: unknown };
          try {
            if ((await packageFile.stat()).size > 128 * 1024) throw invalidPackage();
            metadata = JSON.parse(await packageFile.readFile("utf8"));
          } finally { await packageFile.close(); }
          if (metadata.name !== candidate.plugin.packageName || metadata.version !== candidate.plugin.version) throw invalidPackage();
          return {
            pluginId: candidate.plugin.id, pluginKey: candidate.plugin.pluginKey,
            declaration, packageRoot: root, entrypoint: path.join(root, declaration.runtime.entrypoint),
            release: parseRunnerHarnessReleaseIdentity({ harnessId, packageName: candidate.plugin.packageName, version: candidate.plugin.version,
              integrity, protocolVersion: 1, runtimeDigest }),
          };
        } catch (error) {
          if (error && typeof error === "object" && "status" in error) throw error;
          throw invalidPackage();
        }
      }
      throw unavailable();
    },
  };
}

export type RunnerHarnessRegistry = ReturnType<typeof createRunnerHarnessRegistry>;
const configuredRegistries = new WeakMap<Db, RunnerHarnessRegistry>();

/** Same validation is used by save, Test, and execution admission. */
export function validateRunnerHarnessConfiguration(
  resolved: Pick<ResolvedRunnerHarness, "declaration">,
  config: Record<string, unknown>,
): void {
  const extensionConfig = config.extensionConfig ?? {};
  if (!extensionConfig || typeof extensionConfig !== "object" || Array.isArray(extensionConfig)) {
    throw unprocessable("Harness settings must be an object.", { code: "runner_harness_config_invalid" });
  }
  let validation;
  try { validation = validateInstanceConfig(extensionConfig as Record<string, unknown>, resolved.declaration.configSchema); }
  catch { throw unprocessable("The installed harness declares an unsupported settings schema.", { code: "runner_harness_config_schema_invalid" }); }
  if (!validation.valid) throw unprocessable("Check the harness settings.", { code: "runner_harness_config_invalid", errors: validation.errors });
  const env = config.env ?? {};
  if (!env || typeof env !== "object" || Array.isArray(env)) throw unprocessable("Harness credentials must use environment bindings.", { code: "runner_harness_credentials_invalid" });
  const allowed = new Set((resolved.declaration.credentials ?? []).map(credential => credential.key));
  const extraKeys = Object.keys(env).filter(key => !allowed.has(key));
  if (extraKeys.length) throw unprocessable("Only the selected harness's declared credential bindings may be configured.", {
    code: "runner_harness_credentials_invalid", fields: extraKeys.map(key => `env.${key}`),
  });
}

export function runnerHarnessRegistry(db: Db, options?: RunnerHarnessRegistryOptions): RunnerHarnessRegistry {
  const configured = configuredRegistries.get(db);
  if (options === undefined && configured) return configured;
  const registry = createRunnerHarnessRegistry(async (companyId, pluginKey) => {
    return await db.select({ plugin: plugins, enabled: pluginCompanySettings.enabled })
      .from(plugins)
      .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.pluginId, plugins.id), eq(pluginCompanySettings.companyId, companyId)))
      .where(and(eq(plugins.status, "ready"), sql`${pluginCompanySettings.enabled} is distinct from false`,
        sql`${plugins.manifestJson} ? 'runnerHarnesses'`, ...(pluginKey ? [eq(plugins.pluginKey, pluginKey)] : [])))
      .orderBy(asc(plugins.installOrder));
  }, options);
  if (options !== undefined) configuredRegistries.set(db, registry);
  return registry;
}
