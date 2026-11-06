import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, readdir, lstat, readlink } from "node:fs/promises";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { installedReleaseLaunch } from "../installed-release.js";
const execute = promisify(execFile);
export interface InstalledOperatorReceipt { schemaVersion: 1; disposable: true; cli: string; cliSha256: string; server: string; serverSha256: string;
  installationTreeSha256: string; serverPid: number; version: string; targetVersion?: string; targetIntegrity?: string; piCredentialEnv?: string }
export function validInstalledReceipt(r: InstalledOperatorReceipt) {
  return r.schemaVersion === 1 && r.disposable === true && Number.isSafeInteger(r.serverPid) && r.serverPid > 1
    && /^[0-9a-f]{64}$/.test(r.installationTreeSha256) && /^[0-9a-f]{64}$/.test(r.cliSha256) && /^[0-9a-f]{64}$/.test(r.serverSha256)
    && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(r.version)
    && (!r.targetVersion || /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(r.targetVersion))
    && (!r.targetIntegrity || /^sha512-[A-Za-z0-9+/]+=*$/.test(r.targetIntegrity))
    && (!r.piCredentialEnv || /^[A-Z][A-Z0-9_]+$/.test(r.piCredentialEnv));
}
/** Receipt identifies the *actual source server*, not another healthy fixture. */
export async function ownedInstalledTarget(ctx: ChatCatalogContext) {
  const ref = process.env.PAPERCLIP_CHAT_OPERATOR_INSTALL_RECEIPT, temp = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!ref || !temp) throw new Error("Requires actual owned published source target and PAPERCLIP_CHAT_OPERATOR_INSTALL_RECEIPT (private mode0600; CLI/server hashes, version and live PID)");
  const root = await realpath(temp), receiptFile = await realpath(ref), info = await stat(receiptFile);
  if (!receiptFile.startsWith(root + path.sep) || !info.isFile() || info.mode & 0o077) throw new Error("Installed operator receipt must be private and inside the owned attempt");
  const r = JSON.parse(await readFile(receiptFile, "utf8")) as InstalledOperatorReceipt;
  if (!validInstalledReceipt(r)) throw new Error("Installed operator receipt lacks exact artifact identities");
  const cli = await realpath(r.cli), server = await realpath(r.server);
  if (![cli, server].every(file => file.startsWith(root + path.sep))) throw new Error("Installed operation refuses artifacts outside its owned attempt");
  const launch = installedReleaseLaunch(cli);
  const serverManifest = JSON.parse(await readFile(path.resolve(server, "../../package.json"), "utf8"));
  if (launch.version !== r.version || serverManifest.name !== "@paperclipai/server" || serverManifest.version !== r.version
    || createHash("sha256").update(await readFile(cli)).digest("hex") !== r.cliSha256
    || createHash("sha256").update(await readFile(server)).digest("hex") !== r.serverSha256) throw new Error("Installed artifact identity differs from receipt");
  const row = (await execute("ps", ["-p", String(r.serverPid), "-o", "uid=", "-o", "command="], { timeout: 5000 })).stdout.trim();
  const match = row.match(/^(\d+)\s+([\s\S]+)$/);
  if (Number(match?.[1]) !== process.getuid?.() || !match?.[2]?.split(/\s+/).includes(cli)) throw new Error("Receipt does not identify the current user's exact installed CLI process");
  const health = await ctx.input.api.get<{ version?: string }>("/api/health");
  if (health.version !== r.version) throw new Error("Actual source HTTP version differs from the pinned installed target");
  const prefix = path.resolve(launch.cwd, "../../..");
  if (!prefix.startsWith(root + path.sep) || !server.startsWith(prefix + path.sep)) throw new Error("Installed artifacts do not share the exact owned npm prefix");
  const entries: Array<{ file: string; sha256?: string; link?: string }> = []; let totalBytes = 0;
  async function inventory(current: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      const file = path.join(current, name), info = await lstat(file);
      if (entries.length > 200000 || totalBytes > 2_147_483_648) throw new Error("Installed artifact inventory exceeds the bounded proof scope");
      if (info.isSymbolicLink()) { const resolved = await realpath(file); if (!resolved.startsWith(prefix + path.sep)) throw new Error("Installed dependency escapes its owned prefix"); entries.push({ file: path.relative(prefix, file), link: await readlink(file) }); }
      else if (info.isDirectory()) await inventory(file);
      else if (info.isFile()) { totalBytes += info.size; entries.push({ file: path.relative(prefix, file), sha256: createHash("sha256").update(await readFile(file)).digest("hex") }); }
      else throw new Error("Installed artifact inventory contains a nonregular object");
    }
  }
  await inventory(prefix);
  const treeSha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  if (treeSha256 !== r.installationTreeSha256) throw new Error("Actual installed source dependency tree differs from its pinned artifact receipt");
  const config = process.env.PAPERCLIP_CONFIG;
  if (!config || !(await realpath(config)).startsWith(root + path.sep)) throw new Error("Installed operation requires the owned source config");
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, PAPERCLIP_HOME: root, PAPERCLIP_CONFIG: config,
    PAPERCLIP_TELEMETRY_DISABLED: "1", PAPERCLIP_NO_BROWSER: "1", NO_COLOR: "1", NPM_CONFIG_PREFIX: path.resolve(launch.cwd, "../../..") };
  return { receipt: r, cli, server, root, treeSha256, environment,
    async command(args: string[], timeout = 180_000) {
      try { return (await execute(process.execPath, [cli, ...args], { cwd: launch.cwd, env: environment, timeout, maxBuffer: 1_048_576 })).stdout; }
      catch { throw new Error("Owned installed operator command failed; raw subprocess output withheld"); }
    } };
}
