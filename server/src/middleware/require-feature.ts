import type { Request, Response, NextFunction } from "express";
import { billingService } from "../services/billing.js";
import type { Db } from "@paperclipai/db";

/**
 * Express middleware that gates a route behind a subscription feature.
 *
 * Usage in a route file:
 * ```ts
 * router.post("/path", requireFeature(db, "custom_plugins"), handler);
 * ```
 *
 * The middleware extracts `companyId` from `req.params.companyId`,
 * then delegates to `billing.requireFeature(companyId, featureKey)`.
 * A 403 Paywall error is thrown when the company's subscription does
 * not include the requested feature.
 */
export function requireFeature(db: Db, featureKey: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const companyId = req.params.companyId as string | undefined;
      if (!companyId) {
        next();
        return;
      }
      const billing = billingService(db);
      await billing.requireFeature(companyId, featureKey);
      next();
    } catch (err) {
      next(err);
    }
  };
}