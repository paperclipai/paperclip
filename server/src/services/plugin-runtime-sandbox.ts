import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginCapabilityValidator } from "./plugin-capability-validator.js";

export class PluginSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSandboxError";
  }
}

/**
 * Sandbox runtime options used when loading a plugin worker module.
 *
 * `allowedModuleSpecifiers` controls which bare module specifiers are permitted.
 * `allowedModules` provides concrete host-provided bindings for those specifiers.
 */
export interface PluginSandboxOptions {
  entrypointPath: string;
  allowedModuleSpecifiers?: ReadonlySet<string>;
  allowedModules?: Readonly<Record<string, Record<string, unknown>>>;
  allowedGlobals?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Operation-level runtime gate for plugin host API calls.
 * Every host operation must be checked against manifest capabilities before execution.
 */
export interface CapabilityScopedInvoker {
  invoke<T>(operation: string, fn: () => Promise<T> | T): Promise<T>;
}

interface LoadedModule {
  namespace: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const MODULE_PATH_SUFFIXES = ["", ".js", ".mjs", ".cjs", "/index.js", "/index.mjs", "/index.cjs"];
const DEFAULT_GLOBALS: Record<string, unknown> = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  AbortController,
  AbortSignal,
};

export function createCapabilityScopedInvoker(
  manifest: PaperclipPluginManifestV1,
  validator: PluginCapabilityValidator,
): CapabilityScopedInvoker {
  return {
    async invoke<T>(operation: string, fn: () => Promise<T> | T): Promise<T> {
      validator.assertOperation(manifest, operation);
      return await fn();
    },
  };
}

/**
 * Load a CommonJS plugin module in a VM context with explicit module import allow-listing.
 *
 * Security properties:
 * - no implicit access to host globals like `process`
 * - no unrestricted built-in module imports
 * - relative imports are resolved only inside the plugin root directory
 */
export async function loadPluginModuleInSandbox(
  options: PluginSandboxOptions,
): Promise<LoadedModule> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowedSpecifiers = options.allowedModuleSpecifiers ?? new Set<string>();
  const entrypointPath = path.resolve(options.entrypointPath);
  const pluginRoot = path.dirname(entrypointPath);

  const context = vm.createContext({
    ...DEFAULT_GLOBALS,
    ...options.allowedGlobals,
  });

  const moduleCache = new Map<string, Record<string, unknown>>();
  const allowedModules = options.allowedModules ?? {};

  const realPluginRoot = realpathSync(pluginRoot);

  const loadModuleSync = (modulePath: string): Record<string, unknown> => {
    const resolvedPath = resolveModulePathSync(path.resolve(modulePath));
    const realPath = realpathSync(resolvedPath);

    if (!isWithinRoot(realPath, realPluginRoot)) {
      throw new PluginSandboxError(
        `Import '${modulePath}' escapes plugin root and is not allowed`,
      );
    }

    const cached = moduleCache.get(realPath);
    if (cached) return cached;

    const code = readModuleSourceSync(realPath);

    if (looksLikeEsm(code)) {
      throw new PluginSandboxError(
        "Sandbox loader only supports CommonJS modules. Build plugin worker entrypoints as CJS for sandboxed loading.",
      );
    }

    const module = { exports: {} as Record<string, unknown> };
    // Cache the module before execution to preserve CommonJS cycle semantics.
    moduleCache.set(realPath, module.exports);

    const requireInSandbox = (specifier: string): Record<string, unknown> => {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        if (!allowedSpecifiers.has(specifier)) {
          throw new PluginSandboxError(
            `Import denied for module '${specifier}'. Add an explicit sandbox allow-list entry.`,
          );
        }

        const binding = allowedModules[specifier];
        if (!binding) {
          throw new PluginSandboxError(
            `Bare module '${specifier}' is allow-listed but no host binding is registered.`,
          );
        }

        return binding;
      }

      const candidatePath = path.resolve(path.dirname(realPath), specifier);
      return loadModuleSync(candidatePath);
    };

    // Inject the CJS module arguments into the context so the script can call
    // the wrapper immediately. This is critical: the timeout in runInContext
    // only applies during script evaluation. By including the self-invocation
    // `(fn)(exports, module, ...)` in the script text, the timeout also covers
    // the actual module body execution — preventing infinite loops from hanging.
    const sandboxArgs = {
      __paperclip_exports: module.exports,
      __paperclip_module: module,
      __paperclip_require: requireInSandbox,
      __paperclip_filename: realPath,
      __paperclip_dirname: path.dirname(realPath),
    };
    // Temporarily inject args into the context, run, then remove to avoid pollution.
    Object.assign(context, sandboxArgs);
    const wrapped = `(function (exports, module, require, __filename, __dirname) {\n${code}\n})(__paperclip_exports, __paperclip_module, __paperclip_require, __paperclip_filename, __paperclip_dirname)`;
    const script = new vm.Script(wrapped, { filename: realPath });
    try {
      script.runInContext(context, { timeout: timeoutMs });
    } finally {
      for (const key of Object.keys(sandboxArgs)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (context as Record<string, unknown>)[key];
      }
    }

    const normalizedExports = normalizeModuleExports(module.exports);
    moduleCache.set(realPath, normalizedExports);
    return normalizedExports;
  };

  const entryExports = loadModuleSync(entrypointPath);

  return {
    namespace: { ...entryExports },
  };
}

function resolveModulePathSync(candidatePath: string): string {
  for (const suffix of MODULE_PATH_SUFFIXES) {
    const fullPath = `${candidatePath}${suffix}`;
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  throw new PluginSandboxError(`Unable to resolve module import at path '${candidatePath}'`);
}

/**
 * True when `targetPath` is inside `rootPath` (or equals rootPath), false otherwise.
 * Uses `path.relative` so sibling-prefix paths (e.g. `/root-a` vs `/root`) cannot bypass checks.
 */
function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readModuleSourceSync(modulePath: string): string {
  try {
    return readFileSync(modulePath, "utf8");
  } catch (error) {
    throw new PluginSandboxError(
      `Failed to read sandbox module '${modulePath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeModuleExports(exportsValue: unknown): Record<string, unknown> {
  if (typeof exportsValue === "object" && exportsValue !== null) {
    return exportsValue as Record<string, unknown>;
  }

  return { default: exportsValue };
}

/**
 * Lightweight guard to reject ESM syntax in the VM CommonJS loader.
 */
function looksLikeEsm(code: string): boolean {
  return /(^|\n)\s*import\s+/m.test(code) || /(^|\n)\s*export\s+/m.test(code);
}
