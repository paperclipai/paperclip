import fs from "node:fs/promises";
import path from "node:path";
import type { ManagedCompanyHomeCleanupResult } from "@paperclipai/shared";
import { resolveManagedCompanyHomeDir, resolvePaperclipInstanceRoot } from "../home-paths.js";

export type { ManagedCompanyHomeCleanupResult };

function assertWithinCompaniesRoot(targetPath: string): void {
  const companiesRoot = path.resolve(resolvePaperclipInstanceRoot(), "companies");
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(companiesRoot, resolvedTarget);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove path outside managed companies root: ${targetPath}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}

export async function removeManagedCompanyHome(companyId: string): Promise<ManagedCompanyHomeCleanupResult> {
  const companyHome = resolveManagedCompanyHomeDir(companyId);
  assertWithinCompaniesRoot(companyHome);

  try {
    await fs.lstat(companyHome);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { path: companyHome, removed: false, status: "missing" };
    }
    return {
      path: companyHome,
      removed: false,
      status: "failed",
      error: errorMessage(error),
    };
  }

  try {
    await fs.rm(companyHome, { recursive: true, force: true });
    return { path: companyHome, removed: true, status: "removed" };
  } catch (error) {
    return {
      path: companyHome,
      removed: false,
      status: "failed",
      error: errorMessage(error),
    };
  }
}
