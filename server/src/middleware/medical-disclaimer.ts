import type { Request, Response, NextFunction } from "express";

/**
 * Stub middleware for Phase 3 Rx-flag gating.
 *
 * Phase 1: attaches disclaimer header and body field only.
 * Phase 3: will gate responses behind physician-supervision flag
 * when endpoint serves Rx-flagged content (rapamycin, metformin, etc.).
 */
export function medicalDisclaimer(_req: Request, res: Response, next: NextFunction) {
  res.setHeader(
    "X-Medical-Disclaimer",
    "This data is for informational purposes only and does not constitute medical advice.",
  );
  next();
}

export const MEDICAL_DISCLAIMER_TEXT =
  "Environmental health scores are for informational purposes only and do not constitute medical advice. Consult a qualified healthcare provider before making health decisions.";
