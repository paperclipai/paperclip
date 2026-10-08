import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { QUALIFIED_ACPX_PROFILES } from "../acpx/qualified-profiles.js";

/** Resolve the already-installed qualified CLI, without borrowing an ambient command. */
export function resolvePinnedCodexCommand(issuer: string | URL = import.meta.url): string {
  try {
    const runnerRequire = createRequire(issuer);
    let bridgeManifest: string;
    try {
      bridgeManifest = runnerRequire.resolve("@agentclientprotocol/codex-acp/package.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      // A public server vendors runner code, while pnpm may keep the bridge
      // inside its declared adapter dependency rather than hoisting it.
      const adapter = runnerRequire.resolve("@paperclipai/adapter-codex-local/server");
      bridgeManifest = createRequire(adapter).resolve("@agentclientprotocol/codex-acp/package.json");
    }
    const manifestPath = realpathSync(createRequire(bridgeManifest).resolve("@openai/codex/package.json"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: unknown; version?: unknown; bin?: string | Record<string, unknown>;
    };
    const expected = QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion;
    if (manifest.name !== "@openai/codex" || manifest.version !== expected) {
      throw new Error(`Codex package version mismatch: expected @openai/codex@${expected}, received ${String(manifest.name)}@${String(manifest.version)}`);
    }
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
    if (typeof bin !== "string" || !bin || bin.includes("\0") || isAbsolute(bin)) {
      throw new Error("Pinned Codex dependency does not expose a contained executable");
    }
    const root = dirname(manifestPath), candidate = resolve(root, bin);
    const inside = (path: string) => {
      const value = relative(root, path);
      return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
    };
    if (!inside(candidate)) throw new Error("Pinned Codex executable escapes its package");
    const executable = realpathSync(candidate);
    if (!inside(executable)) throw new Error("Pinned Codex executable escapes its package");
    if (!statSync(executable).isFile()) throw new Error("Pinned Codex executable is not a regular file");
    accessSync(executable, constants.X_OK);
    return executable;
  } catch (error) {
    throw new Error(`Pinned Codex runtime unavailable: ${(error as Error).message}. Reinstall the qualified runtime dependencies or choose Legacy runner in Advanced.`, { cause: error });
  }
}
