import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { buildNextManifest, flipCurrentAtomic, isManagedExecutable, pruneInstallPayloads, readInstallManifest, resolveInstallStorePaths, withInstallStoreLock, writeInstallManifestAtomic, type InstallChannel, type InstallManifest, type InstallRecord, type InstallStorePaths } from "../install-store.js";
import { dbBackupCommand } from "./db-backup.js";
import { installGitPayload, installNpmPayload, PUBLIC_NPM_REGISTRY, resolveGitHubRef, resolvePublishedVersion, type CommandRunner } from "./install.js";
import { resolvePaperclipInstanceId } from "../config/home.js";
import { detectServiceManager } from "../services/service-manager.js";
import { restartManagedService } from "./service.js";
import { packageVersion } from "../version.js";

const execFileAsync = promisify(execFile);
export type InstallMode = "managed" | "global-npm" | "npx" | "source" | "unknown";
export type UpdateOptions = { canary?: boolean; latest?: boolean; version?: string; rollback?: boolean; check?: boolean; dryRun?: boolean; json?: boolean; yes?: boolean; backup?: boolean };
type Dependencies = { executablePath: string; runCommand: CommandRunner; backup: () => Promise<void>; confirm: (message: string) => Promise<boolean>; now: () => Date; paths: InstallStorePaths; restartActiveService: (expectedVersion: string) => Promise<boolean> };

async function restartActiveManagedService(expectedVersion: string): Promise<boolean> {
  const instanceId = resolvePaperclipInstanceId();
  const detection = await detectServiceManager({ instanceId });
  if (!detection.supported || !(await detection.manager.status()).active) return false;
  await restartManagedService({ instanceId, expectedVersion });
  return true;
}

export function detectInstallMode(executablePath = process.argv[1] ?? "", paths = resolveInstallStorePaths()): InstallMode {
  const resolved = path.resolve(executablePath || ".");
  const manifest = readInstallManifest(paths);
  if (manifest && isManagedExecutable(resolved, manifest, paths)) return "managed";
  const normalized = resolved.split(path.sep).join("/");
  if (normalized.includes("/.npm/_npx/") || normalized.includes("/node_modules/.cache/npx/")) return "npx";
  if (normalized.includes("/node_modules/paperclipai/")) return "global-npm";
  let cursor = path.dirname(resolved);
  while (cursor !== path.dirname(cursor)) {
    if (fs.existsSync(path.join(cursor, ".git"))) return "source";
    cursor = path.dirname(cursor);
  }
  return "unknown";
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => { const [core, prerelease = ""] = value.replace(/^v/, "").split("-", 2); return { numbers: core.split(".").map((part) => Number(part) || 0), prerelease }; };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) { const delta = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0); if (delta !== 0) return Math.sign(delta); }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const leftPart = aParts[index];
    const rightPart = bParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftPart) - Number(rightPart));
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function resolveUpdateRequest(manifest: InstallManifest | null, options: Pick<UpdateOptions, "canary" | "latest" | "version">): { spec: string; channel: InstallChannel; explicit: boolean } {
  const selected = Number(Boolean(options.canary)) + Number(Boolean(options.latest)) + Number(Boolean(options.version));
  if (selected > 1) throw new Error("Choose only one of --latest, --canary, or --version.");
  if (options.version) return { spec: options.version.trim(), channel: "pinned", explicit: true };
  if (options.canary) return { spec: "canary", channel: "canary", explicit: true };
  if (options.latest) return { spec: "latest", channel: "latest", explicit: true };
  if (manifest?.channel === "pinned") return { spec: manifest.version, channel: "pinned", explicit: false };
  const channel = manifest?.channel === "canary" ? "canary" : "latest";
  return { spec: channel, channel, explicit: false };
}

export function rollbackManagedInstall(paths = resolveInstallStorePaths()): InstallManifest {
  const manifest = readInstallManifest(paths);
  if (!manifest) throw new Error("No managed install was found to roll back.");
  const target = manifest.previous[0];
  if (!target) throw new Error("No previous managed payload is available for rollback.");
  if (!fs.existsSync(target.payloadPath)) throw new Error(`Previous payload is missing: ${target.payloadPath}`);
  const current: InstallRecord = { source: manifest.source, version: manifest.version, channel: manifest.channel, payloadPath: manifest.payloadPath, repo: manifest.repo, ref: manifest.ref, sha: manifest.sha, installedAt: manifest.installedAt };
  const next: InstallManifest = { schemaVersion: manifest.schemaVersion, ...target, previous: [current, ...manifest.previous.slice(1)].slice(0, 2) };
  const oldTarget = fs.readlinkSync(paths.currentPath);
  flipCurrentAtomic(target.payloadPath, paths);
  try { writeInstallManifestAtomic(next, paths); } catch (error) { flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths); throw error; }
  return next;
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const answer = await p.confirm({ message, initialValue: false });
  return !p.isCancel(answer) && answer === true;
}
function emit(options: UpdateOptions, value: Record<string, unknown>, message: string): void { if (options.json) console.log(JSON.stringify(value, null, 2)); else console.log(message); }

async function rollbackAfterServiceValidationFailure(
  paths: InstallStorePaths,
  restartActiveService: (expectedVersion: string) => Promise<boolean>,
  validationError: unknown,
  payloadLabel: string,
): Promise<never> {
  const rolledBack = await withInstallStoreLock(async () => rollbackManagedInstall(paths), paths);
  try {
    await restartActiveService(rolledBack.version);
  } catch (restartError) {
    throw new Error(
      `${payloadLabel} failed service validation and was rolled back to ${rolledBack.version}, but the rolled-back service also failed to restart.`,
      { cause: new AggregateError([validationError, restartError]) },
    );
  }
  throw new Error(`${payloadLabel} failed service validation and was rolled back to ${rolledBack.version}.`, { cause: validationError });
}

export async function updateCommand(options: UpdateOptions, overrides: Partial<Dependencies> = {}): Promise<void> {
  const paths = overrides.paths ?? resolveInstallStorePaths();
  const executablePath = overrides.executablePath ?? process.argv[1] ?? "";
  const runCommand = overrides.runCommand ?? execFileAsync;
  const mode = detectInstallMode(executablePath, paths);
  const manifest = readInstallManifest(paths);
  if (options.rollback) {
    if (mode !== "managed") throw new Error("--rollback is only available for managed installs.");
    if (options.dryRun) { emit(options, { mode, action: "rollback", dryRun: true, target: manifest?.previous[0]?.version ?? null }, `Would roll back to ${manifest?.previous[0]?.version ?? "the previous payload"}.`); return; }
    const next = await withInstallStoreLock(async () => rollbackManagedInstall(paths), paths);
    const restarted = await (overrides.restartActiveService ?? restartActiveManagedService)(next.version);
    emit(options, { mode, action: "rollback", version: next.version, restarted }, pc.green(`Rolled back to paperclipai ${next.version}${restarted ? " and restarted the active service" : ""}. Database migrations are not reversed; restore the pre-update backup if needed.`));
    return;
  }
  if (mode === "npx") { emit(options, { mode, action: "install" }, "This is an ephemeral npx install. Run `paperclipai install`, then use `paperclipai update` from the managed shim."); return; }
  if (mode === "source" || mode === "unknown") { emit(options, { mode, action: "manual" }, "This appears to be a source checkout. Update it with `git pull` followed by `pnpm install`; Paperclip will not mutate the repository."); return; }
  const request = resolveUpdateRequest(mode === "managed" ? manifest : null, options);
  if (mode === "managed" && manifest?.source === "git") {
    if (!manifest.repo || !manifest.ref || !manifest.sha) throw new Error("Managed git install metadata is incomplete.");
    if (/^[0-9a-f]{7,40}$/i.test(manifest.ref)) { emit(options, { mode, source: "git", pinned: true, sha: manifest.sha }, `Git install is pinned at ${manifest.sha.slice(0, 12)}.`); return; }
    const targetSha = await resolveGitHubRef(manifest.repo, manifest.ref, runCommand);
    if (targetSha === manifest.sha) { emit(options, { mode, source: "git", changed: false, sha: targetSha, ref: manifest.ref }, `${manifest.repo}@${manifest.ref} is already at ${targetSha.slice(0, 12)}.`); return; }
    if (options.check || options.dryRun) { emit(options, { mode, source: "git", changed: true, currentSha: manifest.sha, targetSha, ref: manifest.ref, dryRun: Boolean(options.dryRun) }, `Git update available: ${manifest.sha.slice(0, 12)} → ${targetSha.slice(0, 12)}.`); if (options.check) process.exitCode = 10; return; }
    if (options.backup !== false) await (overrides.backup ?? (() => dbBackupCommand({})))();
    const installed = await withInstallStoreLock(async () => {
      const payload = await installGitPayload(manifest.repo!, targetSha, runCommand, paths);
      const record: InstallRecord = { source: "git", version: payload.version, channel: "pinned", repo: manifest.repo, ref: manifest.ref, sha: targetSha, payloadPath: payload.payloadPath, installedAt: (overrides.now?.() ?? new Date()).toISOString() };
      const next = buildNextManifest(record, manifest); const oldTarget = fs.readlinkSync(paths.currentPath); flipCurrentAtomic(payload.payloadPath, paths);
      try { writeInstallManifestAtomic(next, paths); } catch (error) { flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths); throw error; }
      pruneInstallPayloads(next, paths); return payload;
    }, paths);
    let restarted: boolean;
    try {
      restarted = await (overrides.restartActiveService ?? restartActiveManagedService)(installed.version);
    } catch (error) {
      return rollbackAfterServiceValidationFailure(
        paths,
        overrides.restartActiveService ?? restartActiveManagedService,
        error,
        "Updated git payload",
      );
    }
    emit(options, { mode, source: "git", changed: true, currentSha: manifest.sha, targetSha, reused: installed.reused, restarted }, pc.yellow(`Updated unreleased git payload ${manifest.sha.slice(0, 12)} → ${targetSha.slice(0, 12)} from ${manifest.repo}@${manifest.ref}${restarted ? " and restarted the active service" : ""}.`));
    return;
  }
  const targetVersion = await resolvePublishedVersion(request.spec, runCommand);
  const currentVersion = manifest?.version ?? (mode === "global-npm" ? packageVersion : undefined);
  const comparison = currentVersion ? compareVersions(targetVersion, currentVersion) : 1;
  if (options.check) { emit(options, { mode, currentVersion: currentVersion ?? null, targetVersion, updateAvailable: comparison > 0, downgrade: comparison < 0, channel: request.channel }, comparison > 0 ? `Update available: ${targetVersion}` : comparison < 0 ? `Target ${targetVersion} is older than ${currentVersion}.` : `paperclipai ${targetVersion} is current.`); if (comparison > 0) process.exitCode = 10; return; }
  if (mode === "global-npm") {
    if (comparison < 0 && options.yes !== true) { const confirmed = await (overrides.confirm ?? defaultConfirm)(`Downgrade paperclipai from ${currentVersion} to ${targetVersion}?`); if (!confirmed) throw new Error("Downgrade cancelled. Re-run with --yes to confirm explicitly."); }
    const args = ["install", "-g", `paperclipai@${targetVersion}`, `--registry=${PUBLIC_NPM_REGISTRY}`, `--@paperclipai:registry=${PUBLIC_NPM_REGISTRY}`]; console.log(`Running: npm ${args.join(" ")}`);
    if (!options.dryRun) {
      const npmConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-npm-"));
      const npmUserConfigPath = path.join(npmConfigDir, "npmrc");
      try {
        fs.writeFileSync(npmUserConfigPath, `registry=${PUBLIC_NPM_REGISTRY}\n@paperclipai:registry=${PUBLIC_NPM_REGISTRY}\n`, { mode: 0o600 });
        await runCommand("npm", args, {
          env: {
            ...process.env,
            npm_config_registry: PUBLIC_NPM_REGISTRY,
            NPM_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY,
            npm_config_userconfig: npmUserConfigPath,
            NPM_CONFIG_USERCONFIG: npmUserConfigPath,
          },
          maxBuffer: 16 * 1024 * 1024,
        });
      } finally {
        fs.rmSync(npmConfigDir, { recursive: true, force: true });
      }
    }
    emit(options, { mode, action: "update", targetVersion, dryRun: Boolean(options.dryRun), command: ["npm", ...args] }, options.dryRun ? "Dry run complete." : pc.green(`Updated global npm install to ${targetVersion}.`)); return;
  }
  if (!manifest) throw new Error("Managed install metadata is missing.");
  if (comparison === 0) { emit(options, { mode, currentVersion, targetVersion, changed: false }, `paperclipai ${targetVersion} is already active.`); return; }
  if (comparison < 0 && options.yes !== true) { const confirmed = await (overrides.confirm ?? defaultConfirm)(`Downgrade paperclipai from ${currentVersion} to ${targetVersion}?`); if (!confirmed) throw new Error("Downgrade cancelled. Re-run with --yes to confirm explicitly."); }
  if (options.dryRun) { emit(options, { mode, currentVersion, targetVersion, action: comparison < 0 ? "downgrade" : "update", backup: options.backup !== false, dryRun: true }, `Would ${comparison < 0 ? "downgrade" : "update"} paperclipai ${currentVersion} → ${targetVersion}${options.backup === false ? " without a backup" : " after a database backup"}.`); return; }
  if (options.backup !== false) await (overrides.backup ?? (() => dbBackupCommand({})))();
  const installed = await withInstallStoreLock(async () => {
    const payload = await installNpmPayload(targetVersion, runCommand, paths);
    const record: InstallRecord = { source: "npm", version: targetVersion, channel: request.channel, payloadPath: payload.payloadPath, installedAt: (overrides.now?.() ?? new Date()).toISOString() };
    const next = buildNextManifest(record, manifest); const oldTarget = fs.readlinkSync(paths.currentPath); flipCurrentAtomic(payload.payloadPath, paths);
    try { writeInstallManifestAtomic(next, paths); } catch (error) { flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths); throw error; }
    pruneInstallPayloads(next, paths); return payload;
  }, paths);
  let restarted: boolean;
  try {
    restarted = await (overrides.restartActiveService ?? restartActiveManagedService)(targetVersion);
  } catch (error) {
    return rollbackAfterServiceValidationFailure(
      paths,
      overrides.restartActiveService ?? restartActiveManagedService,
      error,
      "Updated payload",
    );
  }
  emit(options, { mode, currentVersion, targetVersion, changed: true, reused: installed.reused, restarted }, pc.green(`Updated paperclipai ${currentVersion} → ${targetVersion}${restarted ? " and restarted the active service" : ""}. Run \`paperclipai update --rollback\` for an instant payload rollback.`));
}
