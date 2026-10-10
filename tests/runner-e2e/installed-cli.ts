/** Optional published-install lane. No production hook or admission override. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CREDENTIAL_NAMES, type MatrixExecution } from "./types.js";

export const installedCliKeys = ["PAPERCLIP_RUNNER_E2E_INSTALLED_CLI", "PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256", "PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT", "PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256"] as const;
const overrideKeys = ["PAPERCLIP_RUNNER_BINARY", "PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "PAPERCLIP_RUNNER_ACPX_QUALIFICATION", "PAPERCLIP_ACPX_BUILTIN_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST"] as const;
const suites = new Set(["extended-harnesses", "pi-native", "pi-controls", "rich-acp-warm-continuity"]);
export function usesInstalledCli(env: NodeJS.ProcessEnv): boolean {
  return installedCliKeys.some(key => env[key] !== undefined);
}
export function assertInstalledCliSelection(env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[]): void {
  if (!usesInstalledCli(env)) return;
  if (!installedCliKeys.every(key => Boolean(env[key])) || executions.length === 0 || executions.some(e => e.profile.id !== "runner-acpx-pi" || e.profile.qualificationCandidate !== "pi" || !e.suite.manualOnly || !suites.has(e.suite.id))) throw new Error("Installed CLI proof requires complete pins and explicit supported Pi cases");
  for (const key of overrideKeys) if (env[key] !== undefined) throw new Error(`Installed CLI proof forbids ${key}`);
  if (env.NODE_OPTIONS !== undefined || env.NODE_PATH !== undefined) throw new Error("Installed CLI proof forbids ambient Node injection");
}
async function readOwned(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) throw new Error("Installed CLI proof requires a bounded regular file");
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink() || bytes.length !== Number(before.size)) throw new Error("Installed CLI proof file changed during admission");
    return bytes;
  } finally { await handle.close(); }
}
export async function verifyInstalledCli(env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[]) {
  if (!usesInstalledCli(env)) return undefined;
  assertInstalledCliSelection(env, executions);
  const entry = env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI!;
  const serverRoot = env.PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT!;
  for (const path of [entry, serverRoot]) if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error("Installed CLI proof paths must be canonical and unlinked");
  if (!entry.endsWith("/dist/index.js")) throw new Error("Installed CLI proof requires published dist/index.js");
  const cliRoot = resolve(dirname(entry), "..");
  const cli = JSON.parse((await readOwned(join(cliRoot, "package.json"), 65536)).toString());
  const manifest = findPackageJSON("@paperclipai/server", pathToFileURL(entry));
  if (!manifest || await realpath(manifest) !== join(serverRoot, "package.json")) throw new Error("Installed CLI resolved a foreign server dependency");
  const server = JSON.parse((await readOwned(join(serverRoot, "package.json"), 65536)).toString());
  if (cli.name !== "paperclipai" || cli.bin?.paperclipai !== "./dist/index.js" || server.name !== "@paperclipai/server" || typeof cli.version !== "string" || cli.version !== server.version || server.exports?.["."]?.import !== "./dist/index.js") throw new Error("Installed CLI/server public package identity differs");
  const serverEntry = join(serverRoot, "dist/index.js");
  if (await realpath(serverEntry) !== serverEntry) throw new Error("Installed server entrypoint escapes its package");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const cliSha256 = digest(await readOwned(entry, 64 * 1024 * 1024));
  const serverSha256 = digest(await readOwned(serverEntry, 16 * 1024 * 1024));
  if (cliSha256 !== env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256 || serverSha256 !== env.PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256) throw new Error("Installed CLI/server bytes differ from their reviewed pins");
  return { schema: "paperclip.e2e.installed-cli-admission/v1", entry, cliRoot, cliSha256, serverRoot, serverEntry, serverSha256, version: cli.version, defaultRuntimeResolution: true, qualificationOverride: false };
}

/** This prep lane cannot create agents or read the normal local credential file. */
export function assertInstalledStartupOnly(env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[], options: { ids: string[]; maxParallel: number; maxAutomaticRetries: number; headed: boolean; ui: boolean; debug: boolean; list: boolean; matrixJson: boolean }) {
  assertInstalledCliSelection(env, executions);
  if (!usesInstalledCli(env) || executions.length !== 1 || executions[0]?.id !== "extended-harnesses.runner-acpx-pi.local.hello-complete" || options.ids.length !== 1 || options.ids[0] !== executions[0]?.id || options.maxParallel !== 1 || options.maxAutomaticRetries !== 0 || options.headed || options.ui || options.debug || options.list || options.matrixJson) throw new Error("Installed startup-only requires one explicit local Pi hello, no retries or interactive mode");
  if (CREDENTIAL_NAMES.some(key => env[key] !== undefined) || Object.keys(env).some(key => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DAYTONA|XAI|GROK|CURSOR|COPILOT|GITHUB|GH)(?:_|$)/.test(key) && env[key] !== undefined)) throw new Error("Installed startup-only forbids provider credential inputs");
}
