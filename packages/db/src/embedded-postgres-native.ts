import { promises as fs, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const runtimeAliasDirectories = new Map<string, Promise<string | null>>();

function resolveNativePackageName(): string | null {
  if (process.platform !== "linux") return null;

  switch (process.arch) {
    case "arm64":
      return "linux-arm64";
    case "arm":
      return "linux-arm";
    case "ia32":
      return "linux-ia32";
    case "ppc64":
      return "linux-ppc64";
    case "x64":
      return "linux-x64";
    default:
      return null;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.stat(value);
    return true;
  } catch {
    return false;
  }
}

function resolveEmbeddedPostgresPackageRoot(): string | null {
  try {
    const entry = require.resolve("embedded-postgres");
    return path.dirname(path.dirname(entry));
  } catch {
    return null;
  }
}

function prependPathEnv(name: string, value: string): void {
  const current = process.env[name] ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(value)) return;
  process.env[name] = [value, ...parts].join(path.delimiter);
}

export async function createLinuxSharedLibraryAliasDirectory(libDir: string): Promise<{
  aliasDir: string | null;
  aliases: string[];
}> {
  const entries = await fs.readdir(libDir, { withFileTypes: true });
  const aliases = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = entry.name.match(/^(lib.+\.so\.\d+)\.\d+(?:\.\d+)?$/);
    if (!match) return [];
    return [{ sourceName: entry.name, aliasName: match[1] }];
  });

  if (aliases.length === 0) return { aliasDir: null, aliases: [] };

  const aliasDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
  const created: string[] = [];

  try {
    for (const alias of aliases) {
      const aliasPath = path.join(aliasDir, alias.aliasName);
      await fs.symlink(path.join(libDir, alias.sourceName), aliasPath);
      created.push(aliasPath);
    }
  } catch (error) {
    await fs.rm(aliasDir, { recursive: true, force: true });
    throw error;
  }

  return { aliasDir, aliases: created };
}

async function resolveRuntimeAliasDirectory(libDir: string): Promise<string | null> {
  const existing = runtimeAliasDirectories.get(libDir);
  if (existing) return existing;

  const pending = createLinuxSharedLibraryAliasDirectory(libDir)
    .then(({ aliasDir }) => {
      if (aliasDir) {
        process.once("exit", () => rmSync(aliasDir, { recursive: true, force: true }));
      }
      return aliasDir;
    })
    .catch((error) => {
      runtimeAliasDirectories.delete(libDir);
      throw error;
    });
  runtimeAliasDirectories.set(libDir, pending);
  return pending;
}

export async function prepareEmbeddedPostgresNativeRuntime(): Promise<void> {
  const nativePackageName = resolveNativePackageName();
  const packageRoot = resolveEmbeddedPostgresPackageRoot();
  if (!nativePackageName || !packageRoot) return;

  const nativeRoot = path.resolve(packageRoot, "..", "@embedded-postgres", nativePackageName);
  const libDir = path.join(nativeRoot, "native", "lib");
  if (!(await pathExists(libDir))) return;

  const aliasDir = await resolveRuntimeAliasDirectory(libDir);
  prependPathEnv("LD_LIBRARY_PATH", libDir);
  if (aliasDir) {
    prependPathEnv("LD_LIBRARY_PATH", aliasDir);
  }
}
