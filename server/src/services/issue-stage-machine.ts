// MyHive board stage machine (M12 / E3).
//
// The 5-column board projects the 7 issue statuses onto an ordered delivery
// pipeline. Board users may drag a card forward, reopen a closed card back to
// the Open column, or stop it (cancel) from anywhere. They may NOT drag a card
// *backward* through the review gate (e.g. In Review -> In Development): the only
// legitimate backward motion is the review loopback, which the execution-policy
// state machine produces on `changes_requested` and which is therefore exempt.
//
// This guard is a server-side backstop for the board UI's own drag rules. It is
// opt-in via the `strictBoardTransitions` experimental flag and only applies to
// human/board actors, never to agent/engine writers (recovery, heartbeat,
// routines), so unattended engine flows are never blocked.

const STAGE_INDEX: Record<string, number> = {
  backlog: 0,
  todo: 0,
  in_progress: 1,
  blocked: 1,
  in_review: 2,
  done: 3,
  cancelled: 3,
};

// Targets a board user may always move to regardless of current stage.
const ALWAYS_ALLOWED_TARGETS = new Set(["cancelled", "todo", "backlog"]);

export interface StageTransitionContext {
  from: string;
  to: string;
  actorType: "user" | "agent" | string;
  // True when the move was produced by the execution-policy state machine
  // (review loopback, workflow-controlled assignment). Such moves are exempt.
  workflowControlled: boolean;
}

export interface StageTransitionResult {
  allowed: boolean;
  reason?: string;
}

export function evaluateStageTransition(ctx: StageTransitionContext): StageTransitionResult {
  if (ctx.from === ctx.to) return { allowed: true };
  // Only board/human actors are constrained; engine + agent writers bypass.
  if (ctx.actorType !== "user") return { allowed: true };
  // Workflow-driven moves (changes_requested loopback, etc.) are the sanctioned
  // backward motion.
  if (ctx.workflowControlled) return { allowed: true };
  // Reopening to the Open column and stopping (cancel) are always permitted.
  if (ALWAYS_ALLOWED_TARGETS.has(ctx.to)) return { allowed: true };

  const fromIdx = STAGE_INDEX[ctx.from];
  const toIdx = STAGE_INDEX[ctx.to];
  if (fromIdx === undefined || toIdx === undefined) return { allowed: true };

  if (toIdx < fromIdx) {
    return {
      allowed: false,
      reason:
        "Cards cannot be moved backward through the review gate from the board. " +
        "A reviewer must request changes to return a ticket to In Development.",
    };
  }
  return { allowed: true };
}
