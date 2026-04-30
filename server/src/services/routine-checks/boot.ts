import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import { Registry } from "./registry.js";
import { catchUpAll, tickAll, type WebhookCfg } from "./runner.js";
import type { CheckLogger } from "./types.js";
import { workspaceDriftGuard } from "./checks/workspace-drift-guard.js";
import { subscriptionShadowSync } from "./checks/subscription-shadow-sync.js";
import { creativeLintNightly } from "./checks/creative-lint-nightly.js";
import { driveMarkerTtl } from "./checks/drive-marker-ttl.js";
import { approvedFreshness } from "./checks/approved-freshness.js";

export function buildRegistry(): Registry {
  const r = new Registry();
  r.register(workspaceDriftGuard);
  r.register(subscriptionShadowSync);
  r.register(creativeLintNightly);
  r.register(driveMarkerTtl);
  r.register(approvedFreshness);
  return r;
}

async function readToken(): Promise<string | null> {
  try {
    const path = join(homedir(), ".paperclip/secrets/notify-token");
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

const TICK_INTERVAL_MS = 60_000;

export interface StartRoutineChecksArgs {
  db: Db;
  logger: CheckLogger;
}

export interface RoutineChecksHandle {
  stop: () => Promise<void>;
}

export async function startRoutineChecks(
  args: StartRoutineChecksArgs,
): Promise<RoutineChecksHandle | null> {
  if (process.env.PAPERCLIP_ROUTINE_CHECKS !== "1") {
    args.logger.info("routine-checks: disabled (PAPERCLIP_ROUTINE_CHECKS != 1)");
    return null;
  }

  const registry = buildRegistry();
  const token = await readToken();
  const webhook: WebhookCfg | undefined = token
    ? {
        url: process.env.HERMES_NOTIFY_URL ?? "http://127.0.0.1:8765/paperclip/notify",
        token,
      }
    : undefined;

  if (!webhook) {
    args.logger.warn(
      { reason: "no notify-token at ~/.paperclip/secrets/notify-token" },
      "routine-checks: webhook disabled — notifications will not fire",
    );
  } else {
    args.logger.info(
      { url: webhook.url, checks: registry.list().length },
      "routine-checks: enabled",
    );
  }

  // Initial catch-up for missed slots.
  await catchUpAll({
    db: args.db,
    registry,
    now: () => new Date(),
    logger: args.logger,
    webhook,
  }).catch((err) => args.logger.error({ err }, "routine-checks: catchUpAll failed"));

  let inFlight: Promise<void> = Promise.resolve();
  const interval = setInterval(() => {
    inFlight = tickAll({
      db: args.db,
      registry,
      now: () => new Date(),
      logger: args.logger,
      webhook,
    }).catch((err) => args.logger.error({ err }, "routine-checks: tickAll failed"));
  }, TICK_INTERVAL_MS);

  // Don't keep the event loop alive on a clean shutdown.
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop: async () => {
      clearInterval(interval);
      await inFlight; // wait for any in-flight tick to complete
    },
  };
}
