import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { claudeAuthSwitchDecision } from "@paperclipai/db";
import {
  decideClaudeAuthSwitch,
  type ClaudeSwitchDecision,
  type ClaudeSwitchPolicyConfig,
} from "@paperclipai/shared";
import { desc, eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { claudeAccountUsageService } from "./claude-account-usage.js";
import { instanceSettingsService } from "./instance-settings.js";

const execFileAsync = promisify(execFile);

/** Hourly cadence for the smart-switch tick (self-gated inside maybeTick). */
const TICK_INTERVAL_MS = 60 * 60_000;
/** claude-auth-switch runs a real `claude -p` smoke on the target — allow time. */
const SWITCH_TIMEOUT_MS = 150_000;

function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

function profileDir(): string {
  return process.env.CLAUDE_AUTH_PROFILE_DIR?.trim() || path.join(claudeConfigDir(), "auth-profiles");
}

function switchBinPath(): string {
  return (
    process.env.CLAUDE_AUTH_SWITCH_BIN?.trim() ||
    path.join(os.homedir(), ".local", "bin", "claude-auth-switch")
  );
}

/** Whether the hourly decision tick runs at all (compute + audit). Default on. */
function autoSwitchEnabled(): boolean {
  return process.env.PAPERCLIP_CLAUDE_AUTOSWITCH_ENABLED !== "false";
}

/**
 * Whether a decided switch is actually EXECUTED against host auth. Default OFF:
 * flipping the host login affects every claude_local agent at once, so the engine
 * ships in shadow/dry-run mode — it records what it WOULD do — until an operator
 * opts in with `PAPERCLIP_CLAUDE_AUTOSWITCH_EXECUTE=1`.
 */
function executeEnabled(): boolean {
  const v = process.env.PAPERCLIP_CLAUDE_AUTOSWITCH_EXECUTE;
  return v === "1" || v === "true";
}

function policyFromEnv(): Partial<ClaudeSwitchPolicyConfig> {
  const out: Partial<ClaudeSwitchPolicyConfig> = {};
  const num = (raw: string | undefined): number | undefined => {
    if (raw == null || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const minHeadroom = num(process.env.CLAUDE_SWITCH_MIN_HEADROOM_PCT);
  const nearReset = num(process.env.CLAUDE_SWITCH_WAMELING_NEAR_RESET_HOURS);
  const margin = num(process.env.CLAUDE_SWITCH_MATERIAL_MARGIN_PCT);
  const dwellMin = num(process.env.CLAUDE_SWITCH_MIN_DWELL_MINUTES);
  if (minHeadroom != null) out.minHeadroomPct = minHeadroom;
  if (nearReset != null) out.wamelingNearResetHours = nearReset;
  if (margin != null) out.materialMarginPct = margin;
  if (dwellMin != null) out.minDwellMs = dwellMin * 60_000;
  return out;
}

async function readActiveProfile(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(profileDir(), "active"), "utf8");
    const name = raw.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export interface TickResult {
  ran: boolean;
  action: "switch" | "hold" | "skipped";
  applied: boolean;
  targetProfile: string | null;
  fromProfile: string | null;
  reason: string;
  error?: string;
}

export function claudeAuthSwitchService(db: Db) {
  const usage = claudeAccountUsageService(db);
  const settings = instanceSettingsService(db);
  let lastTickAt = 0;
  let ticking = false;

  /** ISO of the most recent executed switch, for min-dwell. */
  async function lastAppliedSwitchAt(): Promise<string | null> {
    const rows = await db
      .select({ decidedAt: claudeAuthSwitchDecision.decidedAt })
      .from(claudeAuthSwitchDecision)
      .where(eq(claudeAuthSwitchDecision.applied, true))
      .orderBy(desc(claudeAuthSwitchDecision.decidedAt))
      .limit(1);
    return rows[0]?.decidedAt ? rows[0].decidedAt.toISOString() : null;
  }

  /** Clear a stale Claude master-runtime cooldown after switching accounts, so
   *  auto-mode re-probes Claude immediately instead of routing to Codex on a
   *  timestamp that no longer reflects reality. */
  async function clearClaudeFailoverCooldown(reason: string): Promise<boolean> {
    const experimental = await settings.getExperimental();
    const failover = experimental.masterRuntimeFailover;
    if (!failover.claudeLimitedUntil) return false;
    await settings.updateExperimental({
      masterRuntimeFailover: {
        ...failover,
        claudeLimitedUntil: null,
        activeRuntime: "claude",
        reason: `cleared by smart auth-switch: ${reason}`,
        updatedAt: new Date().toISOString(),
      },
    });
    return true;
  }

  async function recordDecision(
    decision: ClaudeSwitchDecision,
    applied: boolean,
    error: string | null,
  ): Promise<void> {
    await db.insert(claudeAuthSwitchDecision).values({
      action: decision.action,
      fromProfile: decision.fromProfile,
      toProfile: decision.targetProfile,
      targetTier: decision.targetTier,
      applied,
      reason: decision.reason,
      candidates: decision.candidates,
      error,
    });
  }

  async function executeSwitch(profile: string): Promise<void> {
    await execFileAsync(switchBinPath(), ["use", profile], { timeout: SWITCH_TIMEOUT_MS });
  }

  /** Run one decision cycle unconditionally (used by the manual/API path). */
  async function runOnce(): Promise<TickResult> {
    if (!autoSwitchEnabled()) {
      return {
        ran: false,
        action: "skipped",
        applied: false,
        targetProfile: null,
        fromProfile: null,
        reason: "auto-switch disabled (PAPERCLIP_CLAUDE_AUTOSWITCH_ENABLED=false)",
      };
    }

    // Fresh usage snapshot (rate-limit/backoff enforced inside the capture service).
    const snapshot = await usage.refreshAll();
    const activeProfile =
      snapshot.accounts.find((a) => a.active)?.profile ?? (await readActiveProfile());
    const lastSwitchAt = await lastAppliedSwitchAt();

    const decision = decideClaudeAuthSwitch({
      accounts: snapshot.accounts,
      activeProfile,
      lastSwitchAt,
      now: new Date().toISOString(),
      policy: policyFromEnv(),
    });

    if (decision.action === "hold" || !decision.targetProfile) {
      await recordDecision(decision, false, null);
      return {
        ran: true,
        action: "hold",
        applied: false,
        targetProfile: null,
        fromProfile: decision.fromProfile,
        reason: decision.reason,
      };
    }

    // Decided to switch. Shadow mode: record intent without touching host auth.
    if (!executeEnabled()) {
      await recordDecision(decision, false, null);
      logger.info(
        { from: decision.fromProfile, to: decision.targetProfile, reason: decision.reason },
        "smart claude auth-switch (shadow): would switch (execution disabled)",
      );
      return {
        ran: true,
        action: "switch",
        applied: false,
        targetProfile: decision.targetProfile,
        fromProfile: decision.fromProfile,
        reason: `[shadow] ${decision.reason}`,
      };
    }

    // Execute the host switch (transactional in claude-auth-switch: validates the
    // target, restores previous creds + active marker on failure, exits non-zero).
    try {
      await executeSwitch(decision.targetProfile);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordDecision(decision, false, message);
      logger.error(
        { from: decision.fromProfile, to: decision.targetProfile, err },
        "smart claude auth-switch: execution failed",
      );
      return {
        ran: true,
        action: "switch",
        applied: false,
        targetProfile: decision.targetProfile,
        fromProfile: decision.fromProfile,
        reason: decision.reason,
        error: message,
      };
    }

    let cooldownCleared = false;
    try {
      cooldownCleared = await clearClaudeFailoverCooldown(decision.reason);
    } catch (err) {
      // Non-fatal: the switch succeeded; a lingering cooldown just delays Claude
      // re-probe. Log and continue.
      logger.warn({ err }, "smart claude auth-switch: failed to clear failover cooldown");
    }

    await recordDecision(decision, true, null);
    logger.info(
      {
        from: decision.fromProfile,
        to: decision.targetProfile,
        reason: decision.reason,
        cooldownCleared,
      },
      "smart claude auth-switch: switched host Claude account",
    );
    return {
      ran: true,
      action: "switch",
      applied: true,
      targetProfile: decision.targetProfile,
      fromProfile: decision.fromProfile,
      reason: decision.reason,
    };
  }

  return {
    runOnce,

    /** Hourly-gated entry point for the heartbeat scheduler. No-ops if the last
     *  tick was < 1h ago or another tick is in flight. */
    async maybeTick(now: Date): Promise<TickResult | null> {
      if (!autoSwitchEnabled()) return null;
      const nowMs = now.getTime();
      if (ticking) return null;
      if (nowMs - lastTickAt < TICK_INTERVAL_MS) return null;
      ticking = true;
      lastTickAt = nowMs;
      try {
        return await runOnce();
      } catch (err) {
        logger.error({ err }, "smart claude auth-switch tick failed");
        return null;
      } finally {
        ticking = false;
      }
    },

    /** Recent decision audit rows (newest first) for the UI / API. */
    async recentDecisions(limit = 50) {
      return db
        .select()
        .from(claudeAuthSwitchDecision)
        .orderBy(desc(claudeAuthSwitchDecision.decidedAt))
        .limit(Math.min(200, Math.max(1, limit)));
    },
  };
}

export type ClaudeAuthSwitchService = ReturnType<typeof claudeAuthSwitchService>;
