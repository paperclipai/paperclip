import { isIPv4 } from "node:net";
import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { DEPLOYMENT_MODES, type DeploymentMode } from "@paperclipai/shared";
import {
  createLocalOperatorSignInLink,
  ensureLocalOperatorKey,
  localOperatorSignInUrl,
  resolveLocalOperatorKeyPathForConfig,
} from "@paperclipai/shared/local-operator-credential";
import { openUrl } from "../client/board-auth.js";
import { instanceIdForConfigPath, resolveDefaultConfigPath, resolvePaperclipInstanceId } from "../config/home.js";

export { instanceIdForConfigPath };
import { readConfig, resolveConfigPath } from "../config/store.js";
import { readRuntimeInfo } from "../runtime-info.js";
import { inferApiBaseFromConfig, normalizeApiBase } from "./client/common.js";

interface OpenOptions {
  config?: string;
  instance?: string;
  apiBase?: string;
  browser?: boolean;
}

export interface LocalBoardTarget {
  configPath: string;
  instanceId: string;
  keyPath: string;
  deploymentMode: DeploymentMode;
}

function isLoopbackBase(apiBase: string): boolean {
  try {
    const host = new URL(apiBase).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host === "::1") return true;
    return isIPv4(host) && host.split(".")[0] === "127";
  } catch {
    return false;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The deployment mode the server resolves: the environment first, then the config file. */
export function resolveConfigDeploymentMode(configPath: string): DeploymentMode {
  const fromEnv = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  if (fromEnv && DEPLOYMENT_MODES.includes(fromEnv as DeploymentMode)) return fromEnv as DeploymentMode;
  return readConfig(configPath)?.server?.deploymentMode ?? "local_trusted";
}

/**
 * Resolves the board `open` signs in to, the same way the server finds its own
 * config: `--config`, else `--instance`, else the environment and working
 * directory. The key sits next to that config file.
 */
export function resolveLocalBoardTarget(opts: Pick<OpenOptions, "config" | "instance"> = {}): LocalBoardTarget {
  const instanceOverride = opts.instance?.trim() ? resolvePaperclipInstanceId(opts.instance) : null;
  const configPath = opts.config?.trim()
    ? path.resolve(opts.config)
    : instanceOverride ? resolveDefaultConfigPath(instanceOverride) : resolveConfigPath();
  const instanceId = instanceOverride ?? instanceIdForConfigPath(configPath) ?? resolvePaperclipInstanceId();
  return {
    configPath,
    instanceId,
    keyPath: resolveLocalOperatorKeyPathForConfig(configPath),
    deploymentMode: resolveConfigDeploymentMode(configPath),
  };
}

/** The running server's address for an instance, or the configured one when it is not running. */
export function resolveOpenApiBase(opts: Pick<OpenOptions, "apiBase">, target: Pick<LocalBoardTarget, "instanceId" | "configPath">): string {
  if (opts.apiBase?.trim()) return normalizeApiBase(opts.apiBase);
  const runtime = readRuntimeInfo(target.instanceId);
  if (runtime && processIsRunning(runtime.pid)) return normalizeApiBase(runtime.dashboardUrl);
  return inferApiBaseFromConfig(target.configPath);
}

/** Builds a one-time link that signs this computer's browser in to the local board. */
export function buildLocalBoardSignInUrl(apiBase: string, keyPath: string): string {
  if (!isLoopbackBase(apiBase)) {
    throw new Error(`\`paperclipai open\` signs in to a Paperclip running on this computer; ${apiBase} is not local.`);
  }
  return localOperatorSignInUrl(apiBase, createLocalOperatorSignInLink(ensureLocalOperatorKey(keyPath)));
}

/** The sign-in link for a local_trusted board, or the board's plain address when one cannot be made. */
export function localBoardEntryUrl(dashboardUrl: string, target?: LocalBoardTarget): string {
  try {
    const board = target ?? resolveLocalBoardTarget();
    if (board.deploymentMode !== "local_trusted") return dashboardUrl;
    return buildLocalBoardSignInUrl(dashboardUrl, board.keyPath);
  } catch {
    return dashboardUrl;
  }
}

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("Open the local Paperclip board in your browser, signed in as the operator")
    .option("-c, --config <path>", "Path to Paperclip config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("-i, --instance <id>", "Local instance id (default: the instance of --config, else default)")
    .option("--api-base <url>", "Base URL of the local Paperclip server")
    .option("--no-browser", "Print the link instead of opening a browser")
    .action(async (opts: OpenOptions) => {
      const target = resolveLocalBoardTarget(opts);
      const apiBase = resolveOpenApiBase(opts, target);
      const signIn = target.deploymentMode === "local_trusted";
      const url = signIn ? buildLocalBoardSignInUrl(apiBase, target.keyPath) : apiBase;
      if (opts.browser !== false && await openUrl(url)) {
        console.error(pc.dim("Opened the Paperclip board in your browser."));
        return;
      }
      console.error(signIn
        ? "Open this link in your browser within 10 minutes to sign in to the board:"
        : "Open the board in your browser and sign in with your account:");
      console.log(url);
    });
}
