/**
 * Server-side ccrotate tier-cache writeback for runtime quota burns.
 *
 * Background — without this writeback, runtime quota events are invisible
 * to ccrotate's pool state machine. ccrotate's own probe (Usage API) is
 * throttled by Anthropic's per-org rate limit AFTER a 429, so its
 * `tier-cache.json` stays "unknown / no per-account data" while paperclip
 * agents are observing real burns. `ccrotate next` then keeps rotating
 * back to exhausted accounts and the pool spirals into a retry storm.
 *
 * This module closes that gap: when paperclip-server detects a recoverable
 * quota outcome with a `retryNotBefore` for an adapter that goes through
 * ccrotate, it writes a `serviceTier: 'exhausted'` entry into the shared
 * tier-cache so the next `ccrotate next` skips the burned account
 * immediately. ccrotate's `refresh` path uses upsert, so a subsequent
 * probe can correct the entry without clobbering it.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { markAccountExhausted, type TierCacheTarget } from "@paperclipai/shared/ccrotate-state";

import { mapAdapterToCcrotateTarget } from "./ccrotate-tier-gate.js";

export interface QuotaWritebackLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}

export interface QuotaWritebackInput {
  adapterType: string;
  retryNotBefore: Date | null;
  /** For tests: override the resolved home dir. */
  homeDir?: string;
  log?: QuotaWritebackLogger;
}

export interface QuotaWritebackResult {
  status:
    | "skipped_no_target"
    | "skipped_no_email"
    | "skipped_email_lookup_failed"
    | "skipped_codex_unsupported"
    | "wrote";
  target?: TierCacheTarget;
  email?: string;
  resetEpochSec?: number | null;
}

/** Read the active claude OAuth account email from `~/.claude.json`. */
async function readActiveClaudeEmail(homeDir: string): Promise<string | null> {
  const claudeJsonPath = path.join(homeDir, ".claude.json");
  let raw: string;
  try {
    raw = await fs.readFile(claudeJsonPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } };
    const email = parsed?.oauthAccount?.emailAddress;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort writeback of a runtime quota burn into ccrotate's shared
 * tier-cache. Never throws — failures are logged and swallowed.
 *
 * Currently scoped to the `claude` ccrotate target (claude_local +
 * claude_k8s). The codex/opencode path needs a JWT-decode of
 * `~/.codex/auth.json` `tokens.id_token` to identify the active email
 * which adds complexity not yet justified by an observed pool spiral
 * on that target — defer until needed.
 */
export async function captureQuotaBurnIntoCcrotateTierCache(
  input: QuotaWritebackInput,
): Promise<QuotaWritebackResult> {
  const log = input.log;
  const target = mapAdapterToCcrotateTarget(input.adapterType);
  if (!target) {
    return { status: "skipped_no_target" };
  }
  if (target === "codex") {
    // See JSDoc — codex active-email lookup deferred.
    log?.info(
      { adapterType: input.adapterType, target },
      "ccrotate writeback skipped: codex target unsupported",
    );
    return { status: "skipped_codex_unsupported", target };
  }

  const homeDir = input.homeDir ?? os.homedir();
  const profilesDir = path.join(homeDir, ".ccrotate");

  let email: string | null;
  try {
    email = await readActiveClaudeEmail(homeDir);
  } catch (err) {
    log?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ccrotate writeback: active-email lookup failed",
    );
    return { status: "skipped_email_lookup_failed", target };
  }
  if (!email) {
    return { status: "skipped_no_email", target };
  }

  const resetEpochSec =
    input.retryNotBefore && Number.isFinite(input.retryNotBefore.getTime())
      ? Math.floor(input.retryNotBefore.getTime() / 1000)
      : null;

  try {
    await markAccountExhausted(profilesDir, email, {
      target,
      reset5h: resetEpochSec,
    });
  } catch (err) {
    log?.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        target,
        email,
        profilesDir,
      },
      "ccrotate writeback: tier-cache update failed",
    );
    return { status: "skipped_email_lookup_failed", target, email };
  }

  log?.info(
    { target, email, resetEpochSec },
    "ccrotate writeback: marked account exhausted",
  );
  return { status: "wrote", target, email, resetEpochSec };
}
