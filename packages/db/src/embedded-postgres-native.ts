import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

type NativeRuntimeConfig = {
  envVarName: "LD_LIBRARY_PATH" | "DYLD_LIBRARY_PATH";
  nativePackageName: string;
};

function resolveNativePackageName(): string | null {
  if (process.platform === "linux") {
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

  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";

  return null;
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

function resolveNativePackageRoot(nativePackageName: string): string | null {
  try {
    const packageRoot = resolveEmbeddedPostgresPackageRoot();
    if (!packageRoot) return null;
    const entryPath = require.resolve(`@embedded-postgres/${nativePackageName}`, {
      paths: [packageRoot],
    });
    return path.dirname(path.dirname(entryPath));
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

function resolveNativeRuntimeConfig(): NativeRuntimeConfig | null {
  const nativePackageName = resolveNativePackageName();
  if (!nativePackageName) return null;
  return {
    envVarName: process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH",
    nativePackageName,
  };
}

export async function upsertAutoConfSetting(
  autoConfPath: string,
  key: string,
  value: string,
): Promise<void> {
  const rendered = `${key} = '${value.replaceAll("'", "''")}'`;
  let contents = "";
  try {
    contents = await fs.readFile(autoConfPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const lines = contents.length > 0 ? contents.split(/\r?\n/) : [];
  const filtered = lines.filter((line) => !line.trimStart().startsWith(`${key} =`));
  filtered.push(rendered);
  const nextContents = `${filtered.filter((line) => line.length > 0).join("\n")}\n`;
  if (nextContents === contents) return;
  await fs.writeFile(autoConfPath, nextContents, "utf8");
}

export async function ensureLinuxSharedLibraryAliases(libDir: string): Promise<string[]> {
  const entries = await fs.readdir(libDir, { withFileTypes: true });
  const created: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(lib.+\.so\.\d+)\.\d+(?:\.\d+)?$/);
    if (!match) continue;

    const aliasName = match[1];
    const aliasPath = path.join(libDir, aliasName);
    try {
      await fs.symlink(entry.name, aliasPath);
      created.push(aliasPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }

  return created;
}

export async function prepareEmbeddedPostgresNativeRuntime(dataDir?: string): Promise<void> {
  const runtimeConfig = resolveNativeRuntimeConfig();
  if (!runtimeConfig) return;

  const nativeRoot = resolveNativePackageRoot(runtimeConfig.nativePackageName);
  if (!nativeRoot) return;
  const libDir = path.join(nativeRoot, "native", "lib");
  if (!(await pathExists(libDir))) return;

  prependPathEnv(runtimeConfig.envVarName, libDir);
  if (process.platform === "linux") {
    await ensureLinuxSharedLibraryAliases(libDir);
    return;
  }

  if (process.platform === "darwin" && dataDir) {
    await upsertAutoConfSetting(
      path.resolve(dataDir, "postgresql.auto.conf"),
      "dynamic_library_path",
      libDir,
    );
  }
}
