import { spawnSync } from "node:child_process";
import path from "node:path";

export type StartupRepairClassification =
  | {
      kind: "dependency_integrity_failure";
      summary: string;
      missingSpecifier: string | null;
      importedFrom: string | null;
    }
  | null;

export function classifyStartupRepairableFailure(input: {
  error: unknown;
  projectRoot: string;
}): StartupRepairClassification {
  const details = extractModuleNotFoundDetails(input.error);
  if (!details) return null;

  const importedFrom = normalizeImportedFrom(details.importedFrom);
  const missingSpecifier = details.missingSpecifier;
  const missingModulePath = normalizePathLikeSpecifier(missingSpecifier);
  const normalizedProjectRoot = path.resolve(input.projectRoot);
  const importedFromWorkspace = importedFrom
    ? path.resolve(importedFrom).startsWith(normalizedProjectRoot + path.sep) ||
      path.resolve(importedFrom) === normalizedProjectRoot
    : false;
  const missingWorkspacePackage = missingSpecifier?.startsWith("@paperclipai/") ?? false;
  const missingExternalPackage = Boolean(
    missingSpecifier &&
      !missingSpecifier.startsWith(".") &&
      !missingSpecifier.startsWith("/") &&
      !missingSpecifier.startsWith("file:") &&
      !missingWorkspacePackage,
  );
  const missingNodeModulesPath = Boolean(
    missingModulePath &&
      (missingModulePath.includes(`${path.sep}node_modules${path.sep}`) ||
        missingModulePath.includes(`${path.sep}.pnpm${path.sep}`) ||
        missingModulePath.endsWith(`${path.sep}tsx${path.sep}dist${path.sep}cli.mjs`) ||
        missingModulePath.endsWith(`${path.sep}tsx${path.sep}dist${path.sep}loader.mjs`)),
  );

  if (!importedFromWorkspace && !missingNodeModulesPath && !missingWorkspacePackage) return null;
  if (!missingWorkspacePackage && !missingExternalPackage && !missingNodeModulesPath) return null;

  return {
    kind: "dependency_integrity_failure",
    summary: buildDependencyIntegritySummary({
      missingSpecifier,
      importedFrom,
      missingNodeModulesPath,
      missingWorkspacePackage,
    }),
    missingSpecifier,
    importedFrom,
  };
}

export function repairDevWorkspaceDependencyIntegrity(projectRoot: string) {
  const commands: Array<{ args: string[]; description: string }> = [
    { args: ["install", "--frozen-lockfile"], description: "Reinstall workspace dependencies with a frozen lockfile" },
    { args: ["run", "preflight:workspace-links"], description: "Repair workspace package links" },
    { args: ["--filter", "@paperclipai/server", "build"], description: "Verify the server build after dependency repair" },
  ];

  for (const command of commands) {
    const result = spawnSync(resolvePnpmBinary(), command.args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
      timeout: 10 * 60 * 1000,
    });
    if (result.error) throw new Error(`${command.description} failed: ${formatError(result.error)}`);
    if ((result.status ?? 1) !== 0) {
      throw new Error(`${command.description} failed with exit code ${result.status ?? "unknown"}.`);
    }
  }
}

function resolvePnpmBinary() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function extractModuleNotFoundDetails(error: unknown): {
  missingSpecifier: string | null;
  importedFrom: string | null;
} | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  const message = error.message ?? "";
  if (code !== "ERR_MODULE_NOT_FOUND" && !message.includes("Cannot find module")) return null;

  const packageMatch = message.match(/Cannot find package '([^']+)' imported from ([^\n]+)/);
  if (packageMatch) return { missingSpecifier: packageMatch[1] ?? null, importedFrom: packageMatch[2] ?? null };
  const moduleImportedMatch = message.match(/Cannot find module '([^']+)' imported from ([^\n]+)/);
  if (moduleImportedMatch) {
    return { missingSpecifier: moduleImportedMatch[1] ?? null, importedFrom: moduleImportedMatch[2] ?? null };
  }
  const moduleMatch = message.match(/Cannot find module '([^']+)'/);
  if (moduleMatch) return { missingSpecifier: moduleMatch[1] ?? null, importedFrom: null };
  return { missingSpecifier: null, importedFrom: null };
}

function normalizeImportedFrom(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/^file:\/\//, "") : null;
}

function normalizePathLikeSpecifier(value: string | null) {
  if (!value) return null;
  if (value.startsWith("file://")) return value.replace(/^file:\/\//, "");
  return path.isAbsolute(value) ? value : null;
}

function buildDependencyIntegritySummary(input: {
  missingSpecifier: string | null;
  importedFrom: string | null;
  missingNodeModulesPath: boolean;
  missingWorkspacePackage: boolean;
}) {
  if (input.missingNodeModulesPath) {
    return `Missing runtime dependency path ${input.missingSpecifier ?? "(unknown)"} indicates torn node_modules or pnpm store state.`;
  }
  if (input.missingWorkspacePackage) {
    return `Missing workspace package ${input.missingSpecifier ?? "(unknown)"} indicates broken workspace links in the repo checkout.`;
  }
  return `Missing dependency ${input.missingSpecifier ?? "(unknown)"} imported from ${input.importedFrom ?? "the Paperclip workspace"} indicates incomplete workspace dependencies.`;
}
