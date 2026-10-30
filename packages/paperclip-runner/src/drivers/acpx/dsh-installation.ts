import { realpath } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { packageModuleFormat, readPackageMetadata, type AcpxCommandFormat as DshCommandFormat, type AcpxPackageMetadata as DshPackageMetadata } from "./package-metadata.js";
import type { QualifiedAcpxProfile } from "./qualified-profiles.js";

export const DSH_MAX_DEPENDENCY_ANCESTORS = 2_048;

export function dshSnapshotPathSkipped(source: string, packageRoot: string): boolean {
  const local = relative(packageRoot, source);
  if (local.startsWith("..") || isAbsolute(local)) return true;
  if (/\.(?:map|tsx?|mts|cts|png|jpe?g|gif|webp|svg|pdf|mp4|webm|woff2?|ttf|otf|eot|zip|tar|gz)$/i.test(local)) return true;
  return local.split(sep).some(segment => ["__tests__", "test", "tests", "storybook"].includes(segment));
}

export type DshPackageJsonResolver = (
  packageName: string,
  issuerPackageJsonPath?: string,
  signal?: AbortSignal,
) => string | Promise<string>;

function dshDependencyNames(metadata: DshPackageMetadata): Set<string> {
  const names = new Set<string>();
  for (const group of [metadata.dependencies, metadata.optionalDependencies, metadata.peerDependencies]) {
    if (group !== null && typeof group === "object" && !Array.isArray(group)) {
      for (const name of Object.keys(group)) names.add(name);
    }
  }
  return names;
}

interface DshProviderPackage {
  name: string;
  directory: string;
  format: DshCommandFormat;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function resolveDshPackageJsonFromIssuer(packageName: string, issuerPackageJsonPath?: string, signal?: AbortSignal): Promise<string> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName) || packageName.split("/").some(segment => segment === "." || segment === "..")) {
    throw Object.assign(new Error(`Invalid DSH package name '${packageName}'`), { code: "ERR_INVALID_PACKAGE_NAME" });
  }
  let directory = dirname(issuerPackageJsonPath?.startsWith("file:") ? fileURLToPath(issuerPackageJsonPath) : issuerPackageJsonPath ?? fileURLToPath(import.meta.url));
  for (let count = 0; count < 64; count++) {
    signal?.throwIfAborted();
    const candidate = join(directory, "node_modules", packageName, "package.json");
    try {
      const resolved = await realpath(candidate);
      const metadata = await readPackageMetadata(resolved, packageName);
      if (metadata.name === packageName) return resolved;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw Object.assign(new Error(`Cannot find package '${packageName}'`), { code: "MODULE_NOT_FOUND" });
}

export function createDshPackageJsonResolver(root?: string, manifest?: string): DshPackageJsonResolver {
  if (!root) return resolveDshPackageJsonFromIssuer;
  let authority: Promise<{ canonicalRoot: string; canonicalManifest: string; canonicalNodeModules: string }> | undefined;
  const loadAuthority = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    authority ??= (async () => {
      const canonicalRoot = await realpath(root);
      const canonicalManifest = await realpath(manifest ?? resolve(canonicalRoot, "package.json"));
      if (!inside(canonicalRoot, canonicalManifest)) throw new Error("DSH provider package manifest resolves outside the selected provider root");
      const canonicalNodeModules = await realpath(resolve(canonicalRoot, "node_modules"));
      if (!inside(canonicalRoot, canonicalNodeModules)) throw new Error("DSH provider node_modules resolves outside the selected provider root");
      return { canonicalRoot, canonicalManifest, canonicalNodeModules };
    })();
    return authority;
  };
  return async (packageName, issuerPackageJsonPath, signal) => {
    const { canonicalRoot, canonicalManifest, canonicalNodeModules } = await loadAuthority(signal);
    signal?.throwIfAborted();
    const canonicalIssuer = issuerPackageJsonPath === undefined ? canonicalManifest : await realpath(issuerPackageJsonPath);
    if (!inside(canonicalRoot, canonicalIssuer)) throw new Error(`DSH provider package issuer for ${packageName} resolves outside the selected provider root`);
    const packageJsonPath = await resolveDshPackageJsonFromIssuer(packageName, canonicalIssuer, signal);
    if (!inside(canonicalNodeModules, packageJsonPath)) throw new Error(`DSH provider package ${packageName} resolves outside the selected provider root`);
    return packageJsonPath;
  };
}

async function collectDshPackageLinks(packages: ReadonlyMap<string, DshProviderPackage>, signal?: AbortSignal): Promise<Map<string, Map<string, string>>> {
  const admitted = new Set([...packages.values()].map(pkg => pkg.directory));
  const links = new Map<string, Map<string, string>>();
  for (const { directory } of packages.values()) {
    const packageLinks = new Map<string, string>();
    const readLinks = async (nodeModules: string, scope = ""): Promise<void> => {
      signal?.throwIfAborted();
      const entries = await readdir(nodeModules, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && entry.name.startsWith("@")) {
          await readLinks(join(nodeModules, entry.name), `${entry.name}/`);
          continue;
        }
        const target = await realpath(join(nodeModules, entry.name)).catch(() => null);
        if (target && admitted.has(target)) packageLinks.set(`${scope}${entry.name}`, target);
      }
    };
    await readLinks(join(directory, "node_modules"));
    links.set(directory, packageLinks);
  }
  return links;
}

export function dshEntryPackageLinks(packages: readonly Pick<DshProviderPackage, "name" | "directory">[], runtimeDirectory: string, runtimeLinks?: ReadonlyMap<string, string>): Map<string, string> {
  const links = new Map<string, string>();
  for (const pkg of packages) if (!links.has(pkg.name)) links.set(pkg.name, pkg.directory);
  for (const [name, directory] of runtimeLinks ?? []) links.set(name, directory);
  links.set("@deepseek-ai/dsh", runtimeDirectory);
  return links;
}

export async function collectDshProviderPackages(input: {
  profile: QualifiedAcpxProfile;
  resolvePackageJson: DshPackageJsonResolver;
  serverPackageJsonPath: string;
  signal?: AbortSignal;
}): Promise<{ packages: DshProviderPackage[]; links: Map<string, Map<string, string>> }> {
  const packages = new Map<string, DshProviderPackage>();
  const resolutionLinks = new Map<string, Map<string, string>>();
  const roots = ["@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-acp-app", "@deepseek-ai/dsh-base"] as const;
  const visit = async (packageName: string, issuerPackageJsonPath: string, depth = 0, traverseDependencies = true): Promise<string> => {
    input.signal?.throwIfAborted();
    let packageJsonPath: string;
    try {
      const resolved = await input.resolvePackageJson(packageName, issuerPackageJsonPath, input.signal);
      packageJsonPath = await realpath(resolved);
      input.signal?.throwIfAborted();
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { dshDirectPackageResolutionDepth: depth });
    }
    if (packages.has(packageJsonPath)) return packageJsonPath;
    if (packages.size >= DSH_MAX_DEPENDENCY_ANCESTORS) throw new Error("DSH provider dependency ancestry exceeds its bound");
    const metadata = await readPackageMetadata(packageJsonPath, packageName);
    if (metadata.name !== packageName) throw new Error(`DSH package identity mismatch for ${packageName}`);
    if ((packageName === "@deepseek-ai/dsh" || packageName.startsWith("@deepseek-ai/dsh-")) && metadata.version !== input.profile.agentRuntimeVersion) {
      throw new Error(`DSH package version mismatch for ${packageName}: expected ${input.profile.agentRuntimeVersion}, received ${metadata.version ?? "unknown"}`);
    }
    const directory = dirname(packageJsonPath);
    packages.set(packageJsonPath, { name: packageName, directory, format: packageModuleFormat(metadata.type) });
    if (!traverseDependencies) return packageJsonPath;
    const optional = metadata.peerDependenciesMeta !== null && typeof metadata.peerDependenciesMeta === "object" && !Array.isArray(metadata.peerDependenciesMeta)
      ? metadata.peerDependenciesMeta as Record<string, unknown>
      : {};
    const optionalDependencies = metadata.optionalDependencies !== null && typeof metadata.optionalDependencies === "object" && !Array.isArray(metadata.optionalDependencies)
      ? metadata.optionalDependencies as Record<string, unknown>
      : {};
    const dependencies = dshDependencyNames(metadata);
    const requiredDependencies = new Set<string>();
    if (metadata.dependencies !== null && typeof metadata.dependencies === "object" && !Array.isArray(metadata.dependencies)) {
      for (const name of Object.keys(metadata.dependencies)) requiredDependencies.add(name);
    }
    for (const dependency of [...dependencies].sort()) {
      try {
        const resolvedDependency = await visit(dependency, packageJsonPath, depth + 1);
        const issuerDirectory = directory;
        const links = resolutionLinks.get(issuerDirectory) ?? new Map<string, string>();
        links.set(dependency, dirname(resolvedDependency));
        resolutionLinks.set(issuerDirectory, links);
      } catch (error) {
        const optionalPeer = optional[dependency] !== null && typeof optional[dependency] === "object" && !Array.isArray(optional[dependency])
          && (optional[dependency] as Record<string, unknown>).optional === true;
        const missingOptionalPackage = !requiredDependencies.has(dependency)
          && (optionalPeer || Object.hasOwn(optionalDependencies, dependency))
          && (error as { dshDirectPackageResolutionDepth?: number }).dshDirectPackageResolutionDepth === depth + 1
          && ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes((error as NodeJS.ErrnoException).code ?? "");
        if (!missingOptionalPackage) throw error;
      }
    }
    return packageJsonPath;
  };
  const runtimePackageJsonPath = await visit("@deepseek-ai/dsh", input.serverPackageJsonPath, 0, false);
  for (const root of roots) await visit(root, input.serverPackageJsonPath);
  const runtimeMetadata = await readPackageMetadata(runtimePackageJsonPath, "@deepseek-ai/dsh");
  const runtimeDependencies = dshDependencyNames(runtimeMetadata);
  for (const dependency of [...runtimeDependencies].sort()) {
    input.signal?.throwIfAborted();
    try {
      const resolved = await input.resolvePackageJson(dependency, runtimePackageJsonPath, input.signal);
      const dependencyPackageJsonPath = await realpath(resolved);
      if (!packages.has(dependencyPackageJsonPath)) continue;
      const runtimeLinks = resolutionLinks.get(dirname(runtimePackageJsonPath)) ?? new Map<string, string>();
      runtimeLinks.set(dependency, dirname(dependencyPackageJsonPath));
      resolutionLinks.set(dirname(runtimePackageJsonPath), runtimeLinks);
    } catch (error) {
      if (!["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  const links = await collectDshPackageLinks(packages, input.signal);
  for (const [issuer, resolved] of resolutionLinks) {
    const packageLinks = links.get(issuer) ?? new Map<string, string>();
    for (const [name, target] of resolved) packageLinks.set(name, target);
    links.set(issuer, packageLinks);
  }
  return { packages: [...packages.values()], links };
}
