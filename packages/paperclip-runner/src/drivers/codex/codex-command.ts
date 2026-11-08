import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Prefer the installed dependency; compatibility is established by the CLI protocol. */
export function resolveCodexCommand(
  issuer: string | URL = import.meta.url,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): string {
  try {
    const runnerRequire = createRequire(issuer);
    let manifestPath: string;
    try {
      let bridgeManifest: string;
      try {
        bridgeManifest = runnerRequire.resolve("@agentclientprotocol/codex-acp/package.json");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
        // pnpm can retain the bridge inside its declared adapter dependency.
        const adapter = runnerRequire.resolve("@paperclipai/adapter-codex-local/server");
        bridgeManifest = createRequire(adapter).resolve("@agentclientprotocol/codex-acp/package.json");
      }
      manifestPath = createRequire(bridgeManifest).resolve("@openai/codex/package.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      try {
        manifestPath = runnerRequire.resolve("@openai/codex/package.json");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
        return resolveCodexOnPath(environment, workingDirectory);
      }
    }
    manifestPath = realpathSync(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: unknown; version?: unknown; bin?: string | Record<string, unknown>;
    };
    if (manifest.name !== "@openai/codex") throw new Error("Installed Codex dependency has an unexpected package identity");
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
    if (typeof bin !== "string" || !bin || bin.includes("\0") || isAbsolute(bin)) {
      throw new Error("Installed Codex dependency does not expose a contained executable");
    }
    const root = dirname(manifestPath), candidate = resolve(root, bin);
    const inside = (path: string) => {
      const value = relative(root, path);
      return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
    };
    if (!inside(candidate)) throw new Error("Installed Codex executable escapes its package");
    const executable = realpathSync(candidate);
    if (!inside(executable)) throw new Error("Installed Codex executable escapes its package");
    if (!statSync(executable).isFile()) throw new Error("Installed Codex executable is not a regular file");
    accessSync(executable, constants.X_OK);
    if (process.platform === "win32" && /\.(?:[cm]?js)$/i.test(executable)) {
      const triple = process.arch === "x64" ? "x86_64-pc-windows-msvc"
        : process.arch === "arm64" ? "aarch64-pc-windows-msvc" : undefined;
      if (!triple) throw new Error("Installed Codex does not support this Windows architecture");
      let vendorRoot = resolve(root, "vendor");
      try {
        const platformManifestPath = realpathSync(createRequire(manifestPath).resolve(`@openai/codex-win32-${process.arch}/package.json`));
        const platformManifest = JSON.parse(readFileSync(platformManifestPath, "utf8"));
        if (typeof manifest.version !== "string" || platformManifest.name !== "@openai/codex"
          || platformManifest.version !== `${manifest.version}-win32-${process.arch}`
          || !Array.isArray(platformManifest.os) || !platformManifest.os.includes("win32")
          || !Array.isArray(platformManifest.cpu) || !platformManifest.cpu.includes(process.arch)) {
          throw new Error("Installed Codex Windows dependency has an unexpected package identity");
        }
        vendorRoot = resolve(dirname(platformManifestPath), "vendor");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      }
      const ownedRoot = realpathSync(vendorRoot);
      for (const layout of ["bin", "codex"]) {
        try {
          const binary = realpathSync(resolve(ownedRoot, triple, layout, "codex.exe"));
          const contained = relative(ownedRoot, binary);
          if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
            throw new Error("Installed Codex Windows executable escapes its package");
          }
          if (!statSync(binary).isFile()) throw new Error("Installed Codex Windows executable is not a regular file");
          accessSync(binary, constants.X_OK);
          return binary;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      throw new Error("Installed Codex Windows executable is missing; restore its platform dependency");
    }
    return executable;
  } catch (error) {
    throw new Error(`Codex runtime unavailable: ${(error as Error).message}. Install Codex or restore Paperclip's runtime dependencies.`, { cause: error });
  }
}

function resolveCodexOnPath(environment: NodeJS.ProcessEnv, workingDirectory: string): string {
  const names = process.platform === "win32"
    ? ["codex", ...(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(extension => `codex${extension.toLowerCase()}`)]
    : ["codex"];
  // Empty PATH components mean cwd; an omitted PATH has no search entries.
  for (const directory of environment.PATH === undefined ? [] : environment.PATH.split(delimiter)) {
    for (const name of names) {
      try {
        const executable = realpathSync(resolve(workingDirectory, directory, name));
        if (!statSync(executable).isFile()) continue;
        accessSync(executable, constants.X_OK);
        return executable;
      } catch { /* Continue looking for an executable in the selected host PATH. */ }
    }
  }
  throw new Error("No installed Codex dependency or executable on PATH");
}

// Compatibility export: the release pin is not a runtime version gate.
export const resolvePinnedCodexCommand = resolveCodexCommand;
