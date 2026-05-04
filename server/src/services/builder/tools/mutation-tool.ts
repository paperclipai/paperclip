import type {
  BuilderTool,
  BuilderToolRunContext,
  BuilderToolRunResult,
} from "../types.js";
import type { ProposalApplier } from "../applier-types.js";

/**
 * Helper for declaring a mutation tool whose `run()` simply records a
 * proposal and whose effective change is run later by an applier.
 *
 * The applier function is stored directly on the returned tool (cast as
 * `MutationTool`). The proposal apply route looks up the tool from the
 * catalog by `kind === tool.name` and invokes its applier — no separate
 * registry to keep in sync.
 */

export interface MutationToolDef {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  capability: string;
  /** Source label — `core` for first-party, plugin id otherwise. */
  source?: string;
  /**
   * Validate and shape the proposal payload from the model-supplied params.
   * Throwing here is captured into a `{ ok: false, error }` result.
   */
  buildPayload(
    params: Record<string, unknown>,
    ctx: BuilderToolRunContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Short, model-visible summary of "what will happen if approved". */
  summarize(payload: Record<string, unknown>): string;
  /** Run the actual mutation against core services when the operator approves. */
  apply: ProposalApplier;
  /**
   * Whether to also create a row in the existing `approvals` table so the
   * mutation surfaces in the standard Approvals UI. Used for governed
   * primitives in Phase 2 (hire_agent, set_budget, …).
   */
  approvalType?: string;
}

/** A `BuilderTool` augmented with an applier — used by the proposal route. */
export interface MutationTool extends BuilderTool {
  readonly proposalKind: string;
  readonly apply: ProposalApplier;
  readonly approvalType?: string;
}

export function isMutationTool(tool: BuilderTool): tool is MutationTool {
  return typeof (tool as Partial<MutationTool>).apply === "function";
}

export function defineMutationTool(def: MutationToolDef): MutationTool {
  const tool: MutationTool = {
    name: def.name,
    description: def.description,
    parametersSchema: def.parametersSchema,
    requiresApproval: true,
    capability: def.capability,
    source: def.source ?? "core",
    proposalKind: def.name,
    apply: def.apply,
    approvalType: def.approvalType,
    async run(params, ctx): Promise<BuilderToolRunResult> {
      let payload: Record<string, unknown>;
      try {
        payload = await def.buildPayload(params, ctx);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to build proposal payload",
        };
      }

      let approvalId: string | null = null;
      if (def.approvalType) {
        const { approvalService } = await import("../../approvals.js");
        const approval = await approvalService(ctx.db).create(ctx.companyId, {
          type: def.approvalType,
          requestedByUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
          requestedByAgentId: null,
          payload,
        });
        approvalId = approval.id;
      }

      const proposal = await ctx.proposalStore.create({
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        companyId: ctx.companyId,
        kind: def.name,
        payload,
        approvalId,
      });

      return {
        ok: true,
        proposalId: proposal.id,
        result: {
          status: "pending",
          summary: def.summarize(payload),
          proposalId: proposal.id,
          ...(approvalId ? { approvalId, requiresApproval: true } : {}),
        },
      };
    },
  };
  return tool;
}
