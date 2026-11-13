import { reviewedChatProfile } from "./chat-runtime-profile.js";
import { createProcessTreeOwner, stopOwnedProcessTree } from "./process-tree-owner.js";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { MatrixExecution } from "./types.js";
export class ChatInstalledCleanupError extends Error {}
export async function runOwnedInstalledPreparation(name: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) {
  const child = spawn(name, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const owner = createProcessTreeOwner(child);
  let timer: ReturnType<typeof setTimeout> | undefined; let stdout = "", bytes = 0;
  const completed = new Promise<{ ok: boolean }>(resolve => {
    timer = setTimeout(() => resolve({ ok: false }), options.timeout);
    child.on("error", () => resolve({ ok: false })); child.on("close", code => resolve({ ok: code === 0 }));
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 2_097_152) resolve({ ok: false }); else stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 2_097_152) resolve({ ok: false }); });
  });
  try { await owner.observe(); if (!(await completed).ok) throw new Error("Preparation failed"); return stdout; }
  catch { throw new Error("Published installed source preparation failed; raw output withheld"); }
  finally {
    if (timer) clearTimeout(timer);
    try { await stopOwnedProcessTree(child, owner, 5000, 1000); }
    catch { throw new ChatInstalledCleanupError("Installed preparation child ownership cleanup is unconfirmed"); }
    finally { owner.stopObserving(); }
  }
}

export const CHAT_INSTALL_CONFIG = "PAPERCLIP_CHAT_INSTALLED_SOURCE_CONFIG";
export const CHAT_INSTALL_PLAN = "PAPERCLIP_CHAT_INSTALLED_PLAN";
export const CHAT_INSTALL_RECEIPT = "PAPERCLIP_CHAT_OPERATOR_INSTALL_RECEIPT";
export const installedChatScenarioIds = ["instance-operations.update-instance", "instance-operations.provision-runtime"] as const;
interface PublishedPin { version: string; integrity: string }
export interface ChatInstallConfiguration { schemaVersion: 1; disposable: true; source: PublishedPin; target?: PublishedPin; piCredentialEnv?: "OPENROUTER_API_KEY" }
export interface PublishedArtifact { package: "paperclipai" | "@paperclipai/server"; version: string; integrity: string; archiveSha512: string; entrySha256: string }
interface InstallPlan { schemaVersion: 1; executionId: string; temporaryRoot: string; prefix: string; cli: string; serverRoot: string;
  sourceVersion: string; artifacts: PublishedArtifact[]; targetVersion?: string; targetIntegrity?: string; piCredentialEnv?: string }
const hash = (bytes: Buffer | string, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
function privateJson(filename: string, root?: string) {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 1_048_576 || root && !realpathSync(filename).startsWith(realpathSync(root) + path.sep))
    throw new Error("Installed chat configuration/receipt must be a bounded owned private0600 file");
  try { return JSON.parse(readFileSync(filename, "utf8")); } catch { throw new Error("Invalid installed chat private metadata; contents withheld"); }
}
export function validateChatInstallConfiguration(value: unknown): ChatInstallConfiguration {
  const c = value as ChatInstallConfiguration;
  const pin = (p: PublishedPin | undefined) => !!p && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(p.version) && /^sha512-[A-Za-z0-9+/]+=*$/.test(p.integrity);
  if (!c || c.schemaVersion !== 1 || c.disposable !== true || !pin(c.source) || c.target && !pin(c.target)
    || c.target?.version === c.source.version || c.piCredentialEnv && c.piCredentialEnv !== "OPENROUTER_API_KEY")
    throw new Error("Installed chat requires exact public npm version/integrity pins and disposable ownership");
  return c;
}
/** Complete owned npm-prefix closure, including dependency and executable bytes. */
export function installedChatTreeIdentity(prefix: string) {
  const root = realpathSync(prefix), entries: Array<{ file: string; sha256?: string; link?: string }> = [];
  let bytes = 0;
  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const filename = path.join(directory, name), info = lstatSync(filename);
      if (entries.length >= 200000 || bytes + (info.isFile() ? info.size : 0) > 2_147_483_648) throw new Error("Installed source exceeds bounded dependency inventory");
      if (info.isSymbolicLink()) {
        if (!realpathSync(filename).startsWith(root + path.sep)) throw new Error("Installed dependency escapes owned npm prefix");
        entries.push({ file: path.relative(root, filename), link: readlinkSync(filename) });
      } else if (info.isDirectory()) visit(filename);
      else if (info.isFile()) { bytes += info.size; entries.push({ file: path.relative(root, filename), sha256: hash(readFileSync(filename)) }); }
      else throw new Error("Installed closure contains nonregular filesystem data");
    }
  }
  visit(root);
  return { treeSha256: hash(JSON.stringify(entries)), fileCount: entries.length, bytes };
}
export function admitsInstalledChat(execution: Pick<MatrixExecution, "suite" | "task" | "profile" | "environment">) {
  return execution.suite.id === "chat-features" && execution.suite.manualOnly && execution.task.flow === "agent_chat"
    && reviewedChatProfile(execution.profile) && execution.environment.id === "local"
    && (installedChatScenarioIds as readonly string[]).includes(execution.task.id);
}
/** Runs only inside an explicitly selected governed attempt; never during discovery. */
export async function stagePublishedChatInstall(input: { execution: MatrixExecution; root: string; env: NodeJS.ProcessEnv }): Promise<NodeJS.ProcessEnv> {
  if (!admitsInstalledChat(input.execution)) throw new Error("Published ordinary-chat installation is restricted to update/provision scenarios");
  const configRef = input.env[CHAT_INSTALL_CONFIG]; if (!configRef) throw new Error("Missing private installed source configuration with public npm integrity pins");
  const config = validateChatInstallConfiguration(privateJson(configRef));
  if (input.execution.task.id.endsWith("update-instance") && !config.target) throw new Error("Update requires a distinct exact published target pin");
  if (input.execution.task.id.endsWith("provision-runtime") && !config.piCredentialEnv) throw new Error("Provision requires the declared selected OpenRouter credential name");
  const root = realpathSync(input.root), prefix = path.join(root, "published-prefix"), artifactsDir = path.join(root, "published-artifacts");
  await Promise.all([mkdir(prefix, { mode: 0o700 }), mkdir(artifactsDir, { mode: 0o700 })]);
  const env: NodeJS.ProcessEnv = { PATH: input.env.PATH, HOME: root, NPM_CONFIG_CACHE: path.join(root, ".npm"), NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_PREFIX: prefix, NO_COLOR: "1" };
  const artifacts: PublishedArtifact[] = [];
  async function command(name: string, args: string[], timeout = 120_000) {
    return runOwnedInstalledPreparation(name, args, { cwd: root, env, timeout });
  }
  for (const pin of [config.source, ...(config.target ? [config.target] : [])]) {
    for (const name of ["paperclipai", "@paperclipai/server"] as const) {
      const dist = JSON.parse(await command("npm", ["view", `${name}@${pin.version}`, "dist", "--json", "--registry=https://registry.npmjs.org"], 30000));
      if (typeof dist.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+=*$/.test(dist.integrity) || !String(dist.tarball).startsWith("https://registry.npmjs.org/")
        || name === "paperclipai" && dist.integrity !== pin.integrity) throw new Error("Published source metadata differs from the exact public registry pin");
      const packed = JSON.parse(await command("npm", ["pack", `${name}@${pin.version}`, "--ignore-scripts", "--json", "--pack-destination", artifactsDir, "--registry=https://registry.npmjs.org"]));
      const archive = realpathSync(path.join(artifactsDir, packed[0]?.filename ?? "missing"));
      if (!archive.startsWith(artifactsDir + path.sep)) throw new Error("Published tarball escaped its owned artifact folder");
      const bytes = readFileSync(archive), actualIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      if (actualIntegrity !== dist.integrity) throw new Error("Downloaded public tarball integrity differs from registry metadata");
      const entry = await command("tar", ["-xOf", archive, "package/dist/index.js"]);
      artifacts.push({ package: name, version: pin.version, integrity: dist.integrity, archiveSha512: hash(bytes, "sha512"), entrySha256: hash(entry) });
    }
  }
  await command("npm", ["install", "--global", "--prefix", prefix, `paperclipai@${config.source.version}`, "--registry=https://registry.npmjs.org"], 600000);
  const cli = realpathSync(path.join(prefix, "lib/node_modules/paperclipai/dist/index.js"));
  // Resolve using the installed CLI's own public dependency graph, never the source checkout.
  const { findPackageJSON } = await import("node:module"); const { pathToFileURL } = await import("node:url");
  const manifest = findPackageJSON("@paperclipai/server", pathToFileURL(cli));
  if (!manifest) throw new Error("Published CLI has no actual installed server dependency");
  const serverRoot = path.dirname(realpathSync(manifest));
  const plan: InstallPlan = { schemaVersion: 1, executionId: input.execution.id, temporaryRoot: root, prefix, cli, serverRoot,
    sourceVersion: config.source.version, artifacts, targetVersion: config.target?.version, targetIntegrity: config.target?.integrity, piCredentialEnv: config.piCredentialEnv };
  const planFile = path.join(root, "published-chat-plan.json"); writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
  const overrides: NodeJS.ProcessEnv = { [CHAT_INSTALL_PLAN]: planFile, [CHAT_INSTALL_RECEIPT]: path.join(root, "published-chat-source.json"),
    PAPERCLIP_RUNNER_E2E_INSTALLED_CLI: cli, PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT: serverRoot };
  refreshInstalledChatPins({ ...input.env, ...overrides, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root }, input.execution.id, overrides);
  return overrides;
}
export function refreshInstalledChatPins(env: NodeJS.ProcessEnv, executionId: string, destination: NodeJS.ProcessEnv = env) {
  const reference = env[CHAT_INSTALL_PLAN], root = env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!reference || !root) throw new Error("Installed chat has no owned publication plan");
  const plan = privateJson(reference, root) as InstallPlan;
  if (plan.schemaVersion !== 1 || plan.executionId !== executionId || realpathSync(plan.temporaryRoot) !== realpathSync(root)
    || ![plan.cli, plan.serverRoot, plan.prefix].every(filename => realpathSync(filename).startsWith(realpathSync(root) + path.sep))) throw new Error("Installed source plan belongs to another target");
  const server = path.join(plan.serverRoot, "dist/index.js"), cliManifest = JSON.parse(readFileSync(path.resolve(plan.cli, "../../package.json"), "utf8")), serverManifest = JSON.parse(readFileSync(path.join(plan.serverRoot, "package.json"), "utf8"));
  const version = cliManifest.version;
  if (cliManifest.name !== "paperclipai" || serverManifest.name !== "@paperclipai/server" || version !== serverManifest.version
    || ![plan.sourceVersion, plan.targetVersion].filter(Boolean).includes(version)) throw new Error("Installed source version is not a declared publication transition");
  const cliSha256 = hash(readFileSync(plan.cli)), serverSha256 = hash(readFileSync(server));
  if (!plan.artifacts.some(a => a.package === "paperclipai" && a.version === version && a.entrySha256 === cliSha256)
    || !plan.artifacts.some(a => a.package === "@paperclipai/server" && a.version === version && a.entrySha256 === serverSha256)) throw new Error("Actual installed CLI/server bytes differ from their independently downloaded published tarballs");
  destination.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256 = cliSha256;
  destination.PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256 = serverSha256;
  return { plan, server, version, cliSha256, serverSha256, ...installedChatTreeIdentity(plan.prefix) };
}
export function publishInstalledChatReceipt(env: NodeJS.ProcessEnv, executionId: string, serverPid: number) {
  const source = refreshInstalledChatPins(env, executionId);
  const reference = env[CHAT_INSTALL_RECEIPT]; if (!reference || !Number.isSafeInteger(serverPid) || serverPid < 2) throw new Error("Installed source process identity missing");
  if (!realpathSync(path.dirname(reference)).startsWith(realpathSync(source.plan.temporaryRoot))) throw new Error("Installed source receipt escapes its owned attempt");
  const receipt = { schemaVersion: 1, disposable: true, cli: source.plan.cli, server: source.server, cliSha256: source.cliSha256,
    serverSha256: source.serverSha256, installationTreeSha256: source.treeSha256, serverPid, version: source.version,
    targetVersion: source.plan.targetVersion, targetIntegrity: source.plan.targetIntegrity, piCredentialEnv: source.plan.piCredentialEnv,
    publishedArtifacts: source.plan.artifacts, sourceVersion: source.plan.sourceVersion };
  writeFileSync(reference, JSON.stringify(receipt), { mode: 0o600 });
  return receipt;
}
export function installedChatFingerprintIdentity(env: NodeJS.ProcessEnv, executionId: string) {
  const source = refreshInstalledChatPins(env, executionId);
  const receipt = privateJson(env[CHAT_INSTALL_RECEIPT]!, env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT) as { serverPid?: number };
  if (!receipt.serverPid) throw new Error("Actual installed source process receipt is missing");
  const owner = execFileSync("ps", ["-p", String(receipt.serverPid), "-o", "uid=", "-o", "command="], { encoding: "utf8", timeout: 5000 }).trim();
  if (!new RegExp(`^${process.getuid?.()}\\s`).test(owner) || !owner.split(/\s+/).includes(source.plan.cli)) throw new Error("Installed receipt does not identify this user's actual CLI source process");
  return { kind: "published-global-npm", sourceVersion: source.version, cliSha256: source.cliSha256, serverSha256: source.serverSha256,
    treeSha256: source.treeSha256, publishedArtifacts: source.plan.artifacts, observedProcess: { pid: receipt.serverPid, uid: process.getuid?.() } };
}
