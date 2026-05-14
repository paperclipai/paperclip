import type { PaperclipConfig } from "../config/schema.js";
import {
  removeStoredBoardCredential,
  validateStoredBoardCredential,
} from "../client/board-auth.js";
import type { CheckResult } from "./index.js";

export async function boardAuthCheck(config: PaperclipConfig): Promise<CheckResult> {
  const apiBase = resolveBoardAuthCheckApiBase(config);
  const result = await validateStoredBoardCredential({ apiBase });

  if (result.status === "missing") {
    return {
      name: "CLI board auth cache",
      status: "pass",
      message: `No cached board credential for ${apiBase}`,
    };
  }

  if (result.status === "valid") {
    return {
      name: "CLI board auth cache",
      status: "pass",
      message: `Cached credential for ${apiBase} resolves as ${result.userName ?? result.userId}`,
    };
  }

  if (result.status === "invalid") {
    return {
      name: "CLI board auth cache",
      status: "fail",
      message: `Cached credential for ${apiBase} was rejected (${result.statusCode}: ${result.message})`,
      canRepair: true,
      repair: () => {
        removeStoredBoardCredential(apiBase);
      },
      repairHint: `Run \`paperclipai doctor --repair\` to remove the stale entry from ${result.authPath}, then run \`paperclipai auth login\` if board access is needed.`,
    };
  }

  if (result.status === "unreachable") {
    return {
      name: "CLI board auth cache",
      status: "warn",
      message: `Could not verify cached credential for ${apiBase}: ${result.message}`,
      repairHint: "Start Paperclip or set PAPERCLIP_API_URL to the running instance, then re-run `paperclipai doctor`.",
    };
  }

  return {
    name: "CLI board auth cache",
    status: "warn",
    message: `Could not verify cached credential for ${apiBase}: ${result.statusCode}: ${result.message}`,
    repairHint: "Verify the Paperclip API is healthy, then re-run `paperclipai doctor`.",
  };
}

function resolveBoardAuthCheckApiBase(config: PaperclipConfig): string {
  const explicit =
    process.env.PAPERCLIP_API_URL?.trim() ||
    process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    (config.auth.baseUrlMode === "explicit" ? config.auth.publicBaseUrl?.trim() : undefined);
  if (explicit) return explicit.replace(/\/+$/, "");

  const host = process.env.PAPERCLIP_SERVER_HOST?.trim() || "localhost";
  const port = Number(process.env.PAPERCLIP_SERVER_PORT || config.server.port || 3100);
  return `http://${host}:${Number.isFinite(port) && port > 0 ? port : 3100}`;
}
