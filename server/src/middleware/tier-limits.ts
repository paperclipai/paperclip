/**
 * Tier enforcement middleware and helpers.
 *
 * Checks resource usage against the company's current subscription plan
 * and rejects requests that exceed plan limits.
 */

import type { Request, Response, NextFunction } from "express";
import type { Db } from "@ironworksai/db";
import {
  billingService,
  PLAN_DEFINITIONS,
  type PlanTier,
} from "../services/billing.js";
import { HttpError } from "../errors.js";

interface TierLimitErrorBody {
  error: string;
  limit: string;
  currentPlan: PlanTier;
  upgradeUrl: string;
}

function tierLimitError(message: string, limit: string, currentPlan: PlanTier): HttpError {
  const body: TierLimitErrorBody = {
    error: message,
    limit,
    currentPlan,
    upgradeUrl: "/settings/billing",
  };
  return new HttpError(403, message, body);
}

/**
 * Returns a middleware that blocks project creation when the company has
 * reached its plan limit.
 */
export function enforceProjectLimit(db: Db) {
  const billing = billingService(db);

  return async (req: Request, _res: Response, next: NextFunction) => {
    const companyId = req.params.companyId as string | undefined;
    if (!companyId) {
      next();
      return;
    }

    try {
      const sub = await billing.getOrCreateSubscription(companyId);
      const plan = PLAN_DEFINITIONS[sub.planTier];
      if (plan.projects === -1) {
        // unlimited
        next();
        return;
      }

      const count = await billing.getProjectCount(companyId);
      if (count >= plan.projects) {
        throw tierLimitError(
          `Plan limit reached: ${plan.projects} projects allowed on ${plan.label}. Upgrade to create more.`,
          `${plan.projects} projects`,
          sub.planTier,
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Returns a middleware that blocks file uploads when the company has
 * reached its storage limit.
 */
export function enforceStorageLimit(db: Db) {
  const billing = billingService(db);

  return async (req: Request, _res: Response, next: NextFunction) => {
    const companyId = req.params.companyId as string | undefined;
    if (!companyId) {
      next();
      return;
    }

    try {
      const sub = await billing.getOrCreateSubscription(companyId);
      const plan = PLAN_DEFINITIONS[sub.planTier];
      const maxBytes = plan.storageGB * 1024 * 1024 * 1024;
      const usedBytes = await billing.getStorageUsageBytes(companyId);
      if (usedBytes >= maxBytes) {
        const usedGB = Math.round((usedBytes / (1024 * 1024 * 1024)) * 10) / 10;
        throw tierLimitError(
          `Storage limit reached: ${plan.storageGB}GB allowed on ${plan.label} (${usedGB}GB used). Upgrade for more storage.`,
          `${plan.storageGB}GB storage`,
          sub.planTier,
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Utility function (not middleware) to check tier limits programmatically.
 * Returns null if within limits, or an error body if limit exceeded.
 */
export async function checkProjectLimit(
  db: Db,
  companyId: string,
): Promise<TierLimitErrorBody | null> {
  const billing = billingService(db);
  const sub = await billing.getOrCreateSubscription(companyId);
  const plan = PLAN_DEFINITIONS[sub.planTier];
  if (plan.projects === -1) return null;

  const count = await billing.getProjectCount(companyId);
  if (count >= plan.projects) {
    return {
      error: `Plan limit reached: ${plan.projects} projects allowed on ${plan.label}.`,
      limit: `${plan.projects} projects`,
      currentPlan: sub.planTier,
      upgradeUrl: "/settings/billing",
    };
  }
  return null;
}

/**
 * Returns a middleware that blocks playbook runs when the company has
 * reached its monthly plan limit.
 */
export function enforcePlaybookRunLimit(db: Db) {
  const billing = billingService(db);

  return async (req: Request, _res: Response, next: NextFunction) => {
    const companyId = req.params.companyId as string | undefined;
    if (!companyId) {
      next();
      return;
    }

    try {
      const sub = await billing.getOrCreateSubscription(companyId);
      const plan = PLAN_DEFINITIONS[sub.planTier];
      if (plan.playbookRuns === -1) {
        next();
        return;
      }

      const count = await billing.getPlaybookRunCount(companyId);
      if (count >= plan.playbookRuns) {
        throw tierLimitError(
          `Playbook run limit reached: ${plan.playbookRuns} runs/month allowed on ${plan.label}. Upgrade for unlimited runs.`,
          `${plan.playbookRuns} playbook runs/month`,
          sub.planTier,
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function checkStorageLimit(
  db: Db,
  companyId: string,
): Promise<TierLimitErrorBody | null> {
  const billing = billingService(db);
  const sub = await billing.getOrCreateSubscription(companyId);
  const plan = PLAN_DEFINITIONS[sub.planTier];
  const maxBytes = plan.storageGB * 1024 * 1024 * 1024;
  const usedBytes = await billing.getStorageUsageBytes(companyId);
  if (usedBytes >= maxBytes) {
    const usedGB = Math.round((usedBytes / (1024 * 1024 * 1024)) * 10) / 10;
    return {
      error: `Storage limit reached: ${plan.storageGB}GB allowed on ${plan.label} (${usedGB}GB used).`,
      limit: `${plan.storageGB}GB storage`,
      currentPlan: sub.planTier,
      upgradeUrl: "/settings/billing",
    };
  }
  return null;
}
