import type { Db } from "@paperclipai/db";
import type { AutoLabelTriggerEvent } from "@paperclipai/shared";
import { autoLabelRulesService } from "./auto-label-rules.js";
import { instanceSettingsService } from "./instance-settings.js";
import { logger } from "../middleware/logger.js";

/**
 * Check whether the auto-label rules engine is enabled.
 * Cached per-call (reads experimental settings from DB).
 */
export async function isAutoLabelRulesEngineEnabled(db: Db): Promise<boolean> {
  try {
    const instSvc = instanceSettingsService(db);
    const experimental = await instSvc.getExperimental();
    return experimental.autoLabelRulesEngine;
  } catch {
    return false;
  }
}

/**
 * Fire the auto-label rules engine for a given event, if the feature flag is on.
 * This is the main hook called from issue lifecycle events.
 *
 * Returns true if the rules engine was invoked (feature on), false if skipped.
 * Callers use this to decide whether to run hardcoded labeling logic (branch-by-abstraction).
 */
export async function fireAutoLabelRules(
  db: Db,
  opts: {
    companyId: string;
    triggerEvent: AutoLabelTriggerEvent;
    issueId: string;
    issue: Record<string, unknown>;
    actor: { type: "user" | "agent"; id: string };
    workProduct?: Record<string, unknown>;
    comment?: Record<string, unknown>;
  },
): Promise<boolean> {
  const enabled = await isAutoLabelRulesEngineEnabled(db);
  if (!enabled) return false;

  try {
    const svc = autoLabelRulesService(db);
    await svc.evaluateRules(opts);
  } catch (err) {
    logger.warn(
      { err, issueId: opts.issueId, triggerEvent: opts.triggerEvent },
      "auto-label rules engine error — falling through to hardcoded labeling",
    );
    // Return false so the hardcoded path still runs as a fallback
    return false;
  }

  return true;
}
