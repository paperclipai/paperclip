import type { Command } from "commander";
import pc from "picocolors";
import {
  createLocalOperatorSignInLink,
  ensureLocalOperatorKey,
  localOperatorSignInUrl,
  resolveLocalOperatorKeyPath,
} from "@paperclipai/shared/local-operator-credential";
import { openUrl } from "../client/board-auth.js";
import { readContext, resolveProfile } from "../client/context.js";
import { resolveApiBase, type BaseClientOptions } from "./client/common.js";

interface OpenOptions extends Pick<BaseClientOptions, "apiBase" | "config" | "context" | "profile"> {
  browser?: boolean;
}

function isLoopbackBase(apiBase: string): boolean {
  try {
    const host = new URL(apiBase).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

/** Builds a one-time link that signs this computer's browser in to the local board. */
export function buildLocalBoardSignInUrl(apiBase: string, keyPath = resolveLocalOperatorKeyPath()): string {
  if (!isLoopbackBase(apiBase)) {
    throw new Error(`\`paperclipai open\` signs in to a Paperclip running on this computer; ${apiBase} is not local.`);
  }
  return localOperatorSignInUrl(apiBase, createLocalOperatorSignInLink(ensureLocalOperatorKey(keyPath)));
}

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("Open the local Paperclip board in your browser, signed in as the operator")
    .option("-c, --config <path>", "Path to Paperclip config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "CLI context profile name")
    .option("--api-base <url>", "Base URL of the local Paperclip server")
    .option("--no-browser", "Print the sign-in link instead of opening a browser")
    .action(async (opts: OpenOptions) => {
      const { profile } = resolveProfile(readContext(opts.context), opts.profile);
      const url = buildLocalBoardSignInUrl(resolveApiBase(opts, profile));
      if (opts.browser !== false && await openUrl(url)) {
        console.error(pc.dim("Opened the Paperclip board in your browser."));
        return;
      }
      console.error("Open this link in your browser within 10 minutes to sign in to the board:");
      console.log(url);
    });
}
