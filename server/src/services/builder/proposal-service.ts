import type { Db } from "@paperclipai/db";
import type { BuilderHandoffTarget } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { builderProposalStore } from "./proposal-store.js";
import { isMutationTool, type MutationTool } from "./tools/mutation-tool.js";
import { getBuilderToolCatalog } from "./tool-registry.js";
import type { BuilderActor, BuilderTool } from "./types.js";
import type { ApplierContext } from "./applier-types.js";

/**
 * Proposal lifecycle service — list / get / apply / reject builder proposals.
 *
 * Apply dispatches to the originating mutation tool's `apply()` method (the
 * tool is looked up in the catalog by `kind === tool.name`), which calls the
 * relevant core service. This preserves the rule that **tools call services**
 * even when execution is deferred.
 */

export function proposalService(db: Db) {
  const store = builderProposalStore(db);

  function entityHandoff(entityType: string, entityId: string): BuilderHandoffTarget | null {
    switch (entityType) {
      case "issue":
        return { kind: "entity", label: "Open issue", href: `/issues/${entityId}`, entityType, entityId };
      case "goal":
        return { kind: "entity", label: "Open goal", href: `/goals/${entityId}`, entityType, entityId };
      case "routine":
        return { kind: "entity", label: "Open routine", href: `/routines/${entityId}`, entityType, entityId };
      case "company":
        return { kind: "entity", label: "Open company settings", href: "/company/settings", entityType, entityId };
      default:
        return null;
    }
  }

  function findApplier(kind: string, catalog: Map<string, BuilderTool>): MutationTool | null {
    for (const tool of catalog.values()) {
      if (isMutationTool(tool) && tool.proposalKind === kind) return tool;
    }
    return null;
  }

  async function markFailedBestEffort(
    proposalId: string,
    decidedByUserId: string | null,
    reason: string,
  ) {
    await store.markFailed(proposalId, decidedByUserId, reason).catch((markFailedErr) =>
      logger.warn(
        { proposalId, markFailedErr, originalReason: reason },
        "builder proposal markFailed failed",
      ),
    );
  }

  return {
    list: store.list,
    get: store.getById,
    pendingCount: store.pendingCount,

    apply: async (
      companyId: string,
      proposalId: string,
      decidedByUserId: string | null,
    ) => {
      const proposal = await store.getById(companyId, proposalId);
      if (!proposal) throw new Error("Proposal not found");
      if (proposal.status !== "pending" && proposal.status !== "approved") {
        throw new Error(`Proposal is ${proposal.status}; cannot apply`);
      }
      if (proposal.approvalId) {
        throw new Error("This proposal is approval-governed and must be resolved from the Approvals queue");
      }

      const catalog = getBuilderToolCatalog(db);
      const tool = findApplier(proposal.kind, catalog);
      if (!tool) {
        const reason = `No registered applier for kind "${proposal.kind}"`;
        await markFailedBestEffort(proposalId, decidedByUserId, reason);
        throw new Error(reason);
      }

      const proposer: BuilderActor = { type: "user", id: decidedByUserId };
      const ctx: ApplierContext = {
        db,
        companyId,
        decidedByUserId,
        proposer,
      };

      try {
        // Wrap tool.apply() and markApplied() in a transaction to prevent orphaned entities
        let result: any;
        let wonRace = true;
        const applied = await db.transaction(async (tx) => {
          // Pass tx as the db connection so entity creation is transactional
          result = await tool.apply(proposal.payload, { ...ctx, db: tx as any });
          // Use transaction-aware proposal store to ensure atomicity
          const txStore = builderProposalStore(tx as any);
          const applied = await txStore.markApplied(proposalId, decidedByUserId, null);
          if (!applied) {
            // Signal conflict so tx rolls back and the entity creation is undone.
            throw Object.assign(new Error("concurrent-apply"), { concurrent: true });
          }
          return applied;
        }).catch(async (err: any) => {
          if (err.concurrent) {
            // Concurrent race — transaction rolled back, re-fetch the current proposal
            wonRace = false;
            result = null; // Clear stale result from rolled-back apply
            try {
              const current = await store.getById(companyId, proposalId);
              if (!current) {
                throw new Error("proposal missing after concurrent apply");
              }
              return current;
            } catch (refetchErr) {
              throw Object.assign(
                new Error("concurrent apply: could not fetch current proposal"),
                { concurrentRefetch: true, cause: refetchErr },
              );
            }
          }
          throw err; // Re-throw non-concurrent errors
        });
        
        // Best-effort activity log — only log if we won the race (result is valid)
        if (wonRace && result) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: decidedByUserId ?? "board",
            action: "builder.proposal.applied",
            entityType: result.entityType ?? "builder_proposal",
            entityId: result.entityId ?? proposalId,
            details: {
              proposalId,
              kind: proposal.kind,
              sessionId: proposal.sessionId,
              summary: result.summary,
              ...(result.auditDetails ?? {}),
            },
          }).catch((logErr) =>
            logger.warn({ logErr, proposalId }, "builder apply: activity log failed"),
          );
        }
        if (wonRace && result && typeof result.entityType === "string" && typeof result.entityId === "string") {
          const handoff = entityHandoff(result.entityType, result.entityId);
          if (handoff) {
            return {
              ...applied,
              handoff,
              entityType: result.entityType,
              entityId: result.entityId,
              applyResult: result,
            };
          }
        }
        return wonRace && result
          ? { ...applied, applyResult: result }
          : applied;
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Apply failed";
        logger.warn(
          { proposalId, kind: proposal.kind, err },
          "builder proposal apply failed",
        );
        if (!(err && typeof err === "object" && "concurrentRefetch" in err)) {
          await markFailedBestEffort(proposalId, decidedByUserId, reason);
        }
        throw err;
      }
    },

    reject: async (
      companyId: string,
      proposalId: string,
      decidedByUserId: string | null,
    ) => {
      const proposal = await store.getById(companyId, proposalId);
      if (!proposal) throw new Error("Proposal not found");
      if (proposal.status !== "pending" && proposal.status !== "approved") {
        throw new Error(`Proposal is ${proposal.status}; cannot reject`);
      }
      const rejected = await store.markRejected(proposalId, decidedByUserId);
      if (!rejected) {
        // Race: another request already rejected this proposal — return the current state
        const current = await store.getById(companyId, proposalId);
        return current;
      }
      // Best-effort activity log — never fail the reject because of logging
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: decidedByUserId ?? "board",
        action: "builder.proposal.rejected",
        entityType: "builder_proposal",
        entityId: proposalId,
        details: { proposalId, kind: proposal.kind, sessionId: proposal.sessionId },
      }).catch((logErr) =>
        logger.warn({ logErr, proposalId }, "builder reject: activity log failed"),
      );
      return rejected;
    },
  };
}
