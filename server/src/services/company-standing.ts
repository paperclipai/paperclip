import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyStanding } from "@paperclipai/db";
import {
  COMPANY_STANDING_STATUSES,
  type CompanyStandingStatus,
  type EffectiveStanding,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";

/** Severity order for the merge: blocked > grace > active. */
const STANDING_SEVERITY: Record<CompanyStandingStatus, number> = {
  active: 0,
  grace: 1,
  blocked: 2,
};

export interface SetStandingInput {
  status: CompanyStandingStatus;
  reason: string;
  message: string;
  actionUrl?: string;
}

/**
 * Company standing — the one generic hook a billing/compliance/quota plugin
 * needs: declare that a company may not start new work, without core knowing
 * anything about money (spec §5).
 *
 * Rows are always scoped to the writing plugin (row-per-plugin composite PK),
 * and the effective standing per company is the most severe row. Fail-safe:
 * no rows / unknown values ⇒ `active`; only an explicit persisted `blocked`
 * row stops work.
 */
export function companyStandingService(db: Db) {
  return {
    /** Insert or replace the calling plugin's standing row for a company. */
    async setStanding(pluginId: string, companyId: string, input: SetStandingInput): Promise<void> {
      if (!COMPANY_STANDING_STATUSES.includes(input.status)) {
        throw badRequest(
          `Invalid standing status '${String(input.status)}'. Expected one of: ${COMPANY_STANDING_STATUSES.join(", ")}`,
        );
      }
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!reason) throw badRequest("Standing 'reason' is required");
      if (!message) throw badRequest("Standing 'message' is required");
      const actionUrl =
        typeof input.actionUrl === "string" && input.actionUrl.trim().length > 0
          ? input.actionUrl.trim()
          : null;

      await db
        .insert(companyStanding)
        .values({
          companyId,
          pluginId,
          status: input.status,
          reason,
          message,
          actionUrl,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [companyStanding.companyId, companyStanding.pluginId],
          set: {
            status: input.status,
            reason,
            message,
            actionUrl,
            updatedAt: new Date(),
          },
        });
    },

    /** Delete the calling plugin's standing row for a company (idempotent). */
    async clearStanding(pluginId: string, companyId: string): Promise<void> {
      await db
        .delete(companyStanding)
        .where(
          and(
            eq(companyStanding.pluginId, pluginId),
            eq(companyStanding.companyId, companyId),
          ),
        );
    },

    /** Effective standing for one company (most severe row; none ⇒ active). */
    async getEffectiveStanding(companyId: string): Promise<EffectiveStanding> {
      const standings = await this.getEffectiveStandings([companyId]);
      return standings[companyId] ?? { status: "active" };
    },

    /**
     * Effective standings for a set of companies in one query. Every requested
     * company is present in the result (fail-safe default `{ status: "active" }`).
     */
    async getEffectiveStandings(companyIds: string[]): Promise<Record<string, EffectiveStanding>> {
      const result: Record<string, EffectiveStanding> = {};
      for (const companyId of companyIds) {
        result[companyId] = { status: "active" };
      }
      if (companyIds.length === 0) return result;

      const rows = await db
        .select()
        .from(companyStanding)
        .where(inArray(companyStanding.companyId, companyIds));

      for (const row of rows) {
        const status = row.status as CompanyStandingStatus;
        // Fail-safe: ignore rows with values outside the known enum.
        if (!COMPANY_STANDING_STATUSES.includes(status)) continue;
        const current = result[row.companyId] ?? { status: "active" };
        if (STANDING_SEVERITY[status] > STANDING_SEVERITY[current.status]) {
          result[row.companyId] = {
            status,
            reason: row.reason,
            message: row.message,
            ...(row.actionUrl ? { actionUrl: row.actionUrl } : {}),
          };
        }
      }
      return result;
    },

    /**
     * Delete every standing row a plugin has written, across all companies.
     * Called on plugin uninstall / instance-disable so a removed governance
     * plugin can never leave companies stranded (spec §5.2).
     */
    async clearAllForPlugin(pluginId: string): Promise<void> {
      await db.delete(companyStanding).where(eq(companyStanding.pluginId, pluginId));
    },
  };
}

export type CompanyStandingService = ReturnType<typeof companyStandingService>;
