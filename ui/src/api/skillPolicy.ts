/**
 * @fileoverview Frontend client for the core company skill-policy endpoints
 * (§9.10). Core owns a concise, read-only effective-policy summary; the detailed
 * editor lives in Paperclip EE. Phase 3 (PAP-13865) only reads the effective
 * policy for the "View skill policy" peek — it never writes.
 *
 * @see server/src/routes/company-skill-policy.ts
 */

import type { EffectiveSkillPolicy } from "@paperclipai/shared";
import { api } from "./client";

export const skillPolicyApi = {
  /** Effective versioned policy, its revision, and materialized-vs-open-default flag. */
  get: (companyId: string) =>
    api.get<EffectiveSkillPolicy>(`/companies/${companyId}/skill-policy`),
};
