import type { Db } from "@paperclipai/db";
import type { BuilderActor } from "./types.js";

/**
 * Context handed to a proposal applier when the operator applies a Builder
 * proposal. Each `MutationTool` carries its own `apply` function (see
 * `tools/mutation-tool.ts`). The proposal route looks up the tool by its
 * `proposalKind` and invokes that function.
 */

export interface ApplierContext {
  db: Db;
  companyId: string;
  /** The board user that clicked "Apply". */
  decidedByUserId: string;
  /** The actor that originally produced the proposal. */
  proposer: BuilderActor;
}

export interface ApplierResult {
  /** Short summary of what was done; surfaced back to the operator/log. */
  summary: string;
  /** Optional id of the newly-created or updated entity. */
  entityId?: string | null;
  /** Optional richer payload (e.g. the created routine row). */
  details?: Record<string, unknown>;
  /** Activity-log entity type (e.g. "routine", "goal"). */
  entityType?: string;
}

export type ProposalApplier = (
  payload: Record<string, unknown>,
  ctx: ApplierContext,
) => Promise<ApplierResult>;
