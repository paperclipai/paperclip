import { isIPv4 } from "node:net";
import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import {
  createLocalOperatorSignInLink,
  ensureLocalOperatorKey,
  localOperatorSignInUrl,
  resolveLocalOperatorKeyPath,
} from "@paperclipai/shared/local-operator-credential";
import { openUrl } from "../client/board-auth.js";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceId } from "../config/home.js";
import { readRuntimeInfo } from "../runtime-info.js";
import { readConfig } from "../config/store.js";
import { inferApiBaseFromConfig, normalizeApiBase } from "./client/common.js";

interface OpenOptions {
  config?: string;
  instance?: string;
  apiBase?: string;
  browser?: boolean;
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

/** The instance a config file belongs to, when it sits in `<home>/instances/<id>/`. */
export function instanceIdForConfigPath(configPath: string, homeDir = resolvePaperclipHomeDir()): string | null {
  const directory = path.dirname(path.resolve(configPath));
  if (path.dirname(directory) !== path.join(path.resolve(homeDir), "instances")) return null;
  return path.basename(directory);
}

export function resolveOpenInstanceId(opts: Pick<OpenOptions, "config" | "instance">): string {
  if (opts.instance?.trim()) return resolvePaperclipInstanceId(opts.instance);
  const fromConfig = opts.config ? instanceIdForConfigPath(opts.config) : null;
  return resolvePaperclipInstanceId(fromConfig ?? undefined);
}

/** The running server's address for an instance, or the configured one when it is not running. */
export function resolveOpenApiBase(opts: OpenOptions, instanceId: string): string {
  if (opts.apiBase?.trim()) return normalizeApiBase(opts.apiBase);
  const runtime = readRuntimeInfo(instanceId);
  if (runtime && processIsRunning(runtime.pid)) return normalizeApiBase(runtime.dashboardUrl);
  return inferApiBaseFromConfig(opts.config);
}

/** Builds a one-time link that signs this computer's browser in to the local board. */
export function buildLocalBoardSignInUrl(apiBase: string, keyPath = resolveLocalOperatorKeyPath()): string {
  if (!isLoopbackBase(apiBase)) {
    throw new Error(`\`paperclipai open\` signs in to a Paperclip running on this computer; ${apiBase} is not local.`);
  }
  return localOperatorSignInUrl(apiBase, createLocalOperatorSignInLink(ensureLocalOperatorKey(keyPath)));
}

/** The sign-in link for a local board, or the board's plain address when one cannot be made. */
export function localBoardEntryUrl(dashboardUrl: string, instanceId = resolvePaperclipInstanceId()): string {
  try {
    return buildLocalBoardSignInUrl(dashboardUrl, resolveLocalOperatorKeyPath({ instanceId }));
  } catch {
    return dashboardUrl;
  }
}

/** Boards that use accounts sign in on their own page, so they open without a link. */
export function configDeploymentMode(configPath?: string): string | null {
  try {
    return readConfig(configPath)?.server?.deploymentMode ?? null;
  } catch {
    return null;
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
    .option("--no-browser", "Print the sign-in link instead of opening a browser")
    .action(async (opts: OpenOptions) => {
      const instanceId = resolveOpenInstanceId(opts);
      const apiBase = resolveOpenApiBase(opts, instanceId);
      const url = configDeploymentMode(opts.config) === "authenticated"
        ? apiBase
        : buildLocalBoardSignInUrl(apiBase, resolveLocalOperatorKeyPath({ instanceId }));
      if (opts.browser !== false && await openUrl(url)) {
        console.error(pc.dim("Opened the Paperclip board in your browser."));
        return;
      }
      console.error("Open this link in your browser within 10 minutes to sign in to the board:");
      console.log(url);
    });
}
