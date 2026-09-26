/**
 * Copy contract for denied issue writes (open cross-task writes: failure UX).
 *
 * Cross-issue issue writes are default-open for standard-trust agents on issues
 * they can already read (see SPEC-implementation §9.3). The remaining walls are
 * rare — but a real incident burned a full detour discovering a workaround
 * behind an opaque 403, so every one of them must say three things:
 *
 *   1. which boundary fired,
 *   2. who *can* act,
 *   3. the sanctioned path forward.
 *
 * This module is the single source of truth for that copy, so the API error
 * body an agent reads and the notice a human sees in the UI are the same words.
 * It is the issue-write sibling of `responsible-user-denial.ts`: the two
 * responsible-user ceiling codes delegate to that module's copy so terminology
 * ("on behalf of {user}", never "impersonate") stays consistent.
 */

import {
  describeResponsibleUserDenial,
  responsibleUserLabel,
  type ResponsibleUserDenialCode,
} from "./responsible-user-denial.js";

export const ISSUE_WRITE_DENIAL_CODES = [
  "issue_write_not_visible",
  "issue_write_actor_class_excluded",
  "issue_write_responsible_user_ceiling",
  "issue_write_responsible_user_unavailable",
  "issue_write_assignee_run_lock",
  "cross_issue_influence_cap_exceeded",
  "cross_issue_influence_run_context_required",
  "issue_write_attribution_spoof_rejected",
] as const;

export type IssueWriteDenialCode = (typeof ISSUE_WRITE_DENIAL_CODES)[number];

/**
 * Why the cross-issue run-context gate refused a write.
 *
 * The gate checks the run header *before* it ever looks at the target, so by
 * the time it can report `no_context_source_and_target_unbound` the run has
 * already been found, company-matched and agent-matched. Such a run is
 * perfectly well identified; it is the *target* that is unbound. One prose
 * string cannot serve all three conditions, because only the first two are
 * cleared by sending a run id.
 */
export const CROSS_ISSUE_RUN_CONTEXT_REASONS = [
  "malformed_run_id",
  "run_not_found",
  "no_context_source_and_target_unbound",
] as const;

export type CrossIssueRunContextReason =
  (typeof CROSS_ISSUE_RUN_CONTEXT_REASONS)[number];

/**
 * Why the write stopped, which drives icon + colour. `boundary` is an
 * authorization wall, `lock` is run-lifecycle machinery that will clear on its
 * own, `cap` is a rate backstop, and `attribution` is a rejected spoof.
 */
export type IssueWriteDenialTone = "boundary" | "lock" | "cap" | "attribution";

export interface IssueWriteDenialCopy {
  code: IssueWriteDenialCode;
  /** HTTP status the server pairs with this code. */
  status: 403 | 409 | 422 | 429;
  tone: IssueWriteDenialTone;
  /** The boundary that fired, as a short noun phrase for a banner title. */
  boundary: string;
  /** Short heading. */
  title: string;
  /** What happened and why, in one or two sentences. */
  description: string;
  /** Who is able to perform this write instead. */
  whoCanAct: string;
  /** The supported way to get the work moving. */
  sanctionedPath: string;
}

export interface IssueWriteDenialContext {
  /** Display name of the agent or user that attempted the write. */
  actorLabel?: string | null;
  /** Display name of the responsible ("on behalf of") user for the attempt. */
  responsibleUserName?: string | null;
  /** Display name of the target issue's current assignee. */
  assigneeLabel?: string | null;
  /** Target issue identifier, e.g. `TASK-482`. */
  issueIdentifier?: string | null;
  /** Per-run cross-issue influence cap. */
  cap?: number | null;
  /** Attempt count that tripped the cap. */
  count?: number | null;
  /** ISO timestamp at which log-only rollout becomes enforcement. */
  enforceAt?: string | null;
  /**
   * Which condition the run-context gate refused for. Copy is keyed on this so
   * a reason can never be told to do the thing its own condition rules out.
   */
  reason?: CrossIssueRunContextReason | null;
  /**
   * True when the target issue is assigned to an agent other than the caller.
   * Checkout and run ownership are assignee-scoped, so for such a target the
   * remedy is a child issue or a reassignment, never a direct checkout.
   */
  targetOwnedByAnotherAgent?: boolean | null;
}

export function isIssueWriteDenialCode(
  code: string | null | undefined,
): code is IssueWriteDenialCode {
  return ISSUE_WRITE_DENIAL_CODES.includes(code as IssueWriteDenialCode);
}

/**
 * Bridge the two responsible-user ceiling codes emitted by the authorization
 * layer into this module's code space, so a single UI notice covers every way
 * an issue write can be refused.
 */
export function issueWriteDenialCodeForResponsibleUserDenial(
  code: ResponsibleUserDenialCode,
): IssueWriteDenialCode {
  return code === "RESPONSIBLE_USER_UNAVAILABLE"
    ? "issue_write_responsible_user_unavailable"
    : "issue_write_responsible_user_ceiling";
}

/** "this task" when the identifier is unknown, so copy never shows a raw id. */
function issueLabel(identifier: string | null | undefined): string {
  const trimmed = identifier?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "this task";
}

/** "the assignee" when the name is unknown. */
function assigneeLabel(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "the current assignee";
}

/** "this agent" when the name is unknown. */
function actorLabel(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "this agent";
}

/**
 * The escape hatch an earlier incident had to discover by trial and error. Naming it in
 * every boundary denial is the point of plan §6 — an agent that reads the error
 * should not need a detour to find the supported path.
 */
const CHILD_ISSUE_PATH =
  "create a child issue with the request in its description (issue creation is a " +
  "separate, open write path) and let its assignee act";

/**
 * Two calls can put a run and a task in a binding the gate recognises, and the
 * gate does not read the same row for both.
 *
 * `POST /api/issues/{id}/checkout` writes the run onto the **issue** row, which
 * is the auditable binding and stays the one we want: a header that silently
 * bound would move the gate's strength without moving the gate. But the gate
 * attributes a write to the **run's** own task — `contextSnapshot` on the run
 * row — and checkout never writes there, and a checkout with your own run
 * deliberately starts no replacement run to inherit the task.
 *
 * `POST /api/agents/{id}/wakeup` with `payload.issueId` does write there: the
 * wake folds `issueId` into the new run's `contextSnapshot`, which is the one
 * input this gate cannot be satisfied without. Both are named below so no
 * version of the gate can turn this message into a dead end, and neither is
 * claimed to be sufficient on its own.
 */
const CHECKOUT_BINDING =
  "bind the task to this run with `POST /api/issues/{issueId}/checkout` and retry";

const WAKE_BINDING =
  "or, if this run holds no task at all — checkout records the run on the task " +
  "but does not give the run a task, and checking out with your own run starts " +
  "no replacement run — start a run for the task with " +
  "`POST /api/agents/{agentId}/wakeup` and `{\"payload\":{\"issueId\":\"<issueId>\"}}`, " +
  "and make the write from the run it returns";

/**
 * Refusal for a run the gate could not identify at all. The run id genuinely
 * did not arrive, or did not arrive as a run belonging to this agent, so the
 * header advice below is the whole remedy and is true here.
 */
function unidentifiedRunContextCopy(
  code: IssueWriteDenialCode,
  issue: string,
  actor: string,
): IssueWriteDenialCopy {
  return {
    code,
    status: 403,
    tone: "boundary",
    boundary: "Heartbeat run context",
    title: "Cross-issue writes need a run to attribute them to",
    description:
      `Every agent comment and task update is attributed to a heartbeat run so the ` +
      `cross-issue cap can be counted and the audit trail can name who acted for whom. ` +
      `This request did not arrive under a valid run of ${actor}'s, so it could not be ` +
      `contained.`,
    whoCanAct: `${actor}, once the request carries its own run id.`,
    sanctionedPath:
      `Send the \`X-Paperclip-Run-Id\` header with your current run (\`$PAPERCLIP_RUN_ID\`) ` +
      `and retry.`,
  };
}

/**
 * Refusal for a run that *is* identified but is not bound to the target.
 *
 * This is the reason that used to ship the header advice above, and it made the
 * error path unsatisfiable: the gate resolves the run, company and agent before
 * it ever reaches this condition, so the caller is provably already carrying a
 * valid run id and retrying the header returns a byte-identical 403 forever.
 *
 * The missing half is the target binding. Naming only `checkout` would have
 * reproduced the same defect one step along — checkout records the run on the
 * issue, while this gate reads the run's own task, so a task-less run that
 * checks out the target and retries is refused with the same body it already
 * had. So the copy names both bindings and says which one each writes.
 */
function unboundTargetRunContextCopy(
  code: IssueWriteDenialCode,
  issue: string,
  actor: string,
  assignee: string,
  targetOwnedByAnotherAgent: boolean,
): IssueWriteDenialCopy {
  if (targetOwnedByAnotherAgent) {
    return {
      code,
      status: 403,
      tone: "boundary",
      boundary: "Run binding",
      title: "This run is not bound to the task, and the task is not yours",
      description:
        `Cross-issue writes are attributed to a heartbeat run and to the task that run ` +
        `owns. This run is valid and already identified itself on this request, but it ` +
        `holds no task and ${issue} is not bound to it — and ${issue} is assigned to ` +
        `${assignee}, so the direct route is not this run's to take: a checkout on a ` +
        `task another run holds returns 409 \`Issue checkout conflict\`, which is the ` +
        `same wall one step later with no guidance attached.`,
      whoCanAct:
        `${assignee} on ${issue}, or the board if ${issue} should be reassigned to ${actor}.`,
      sanctionedPath:
        `Either ${CHILD_ISSUE_PATH}, or ask the board to reassign ${issue} to you and ` +
        `retry on your next run. Re-sending \`X-Paperclip-Run-Id\` cannot help — this ` +
        `request already carries it, which is how the server knew it was ${actor}.`,
    };
  }
  return {
    code,
    status: 403,
    tone: "boundary",
    boundary: "Run binding",
    title: "This run is not bound to the task it is writing to",
    description:
      `Cross-issue writes are attributed to a heartbeat run and to the task that run owns. ` +
      `This run is valid and already identified itself on this request, so the run id is ` +
      `not the problem — what is missing is a binding between this run and ${issue}. The ` +
      `gate attributes the write to the run's own task, so the binding has to be a run ` +
      `started for ${issue}, or a task bound to this run; ${issue} records neither for ` +
      `this run, so the write had nothing to count against the cross-issue cap or name in ` +
      `the audit trail.`,
    whoCanAct: `${actor}, from a run bound to ${issue}.`,
    sanctionedPath:
      `This write has to come from a run bound to ${issue}: either ${CHECKOUT_BINDING}, ` +
      `${WAKE_BINDING}. Re-sending \`X-Paperclip-Run-Id\` cannot help — this request ` +
      `already carries it, which is how the server knew the write came from ${actor}. If ` +
      `${issue} is not ${actor}'s to take, ${CHILD_ISSUE_PATH} instead.`,
  };
}

export function describeIssueWriteDenial(
  code: IssueWriteDenialCode,
  context: IssueWriteDenialContext = {},
): IssueWriteDenialCopy {
  const issue = issueLabel(context.issueIdentifier);
  const actor = actorLabel(context.actorLabel);
  const assignee = assigneeLabel(context.assigneeLabel);
  const responsible = responsibleUserLabel(context.responsibleUserName);

  switch (code) {
    case "issue_write_not_visible":
      return {
        code,
        status: 403,
        tone: "boundary",
        boundary: "Issue visibility",
        title: "Task is outside this actor's visibility",
        description:
          `Issue writes are open by default, but only for tasks the actor can already ` +
          `read. ${issue} is not visible to ${actor}, so its comment, update, child, and ` +
          `assignment channels are all closed — the wall is visibility, not the write itself.`,
        whoCanAct:
          `${assignee}, and any agent or board member the task is visible to.`,
        sanctionedPath:
          `Ask the board to widen visibility for ${actor}, or ${CHILD_ISSUE_PATH}.`,
      };

    case "issue_write_actor_class_excluded":
      return {
        code,
        status: 403,
        tone: "boundary",
        boundary: "Actor-class boundary",
        title: "This actor class cannot write to tasks",
        description:
          `Default-open issue writes are a standard-trust privilege. Low-trust, ` +
          `skill-test, and task-bridge scopes keep their existing tight walls, so ` +
          `${actor} cannot write to ${issue} no matter who it acts for.`,
        whoCanAct:
          `A standard-trust agent in this company, or a board member.`,
        sanctionedPath:
          `Report the request upward and let a standard-trust agent make the write — ` +
          `actor-class scope cannot be widened per task.`,
      };

    case "issue_write_responsible_user_ceiling": {
      const ceiling = describeResponsibleUserDenial("RESPONSIBLE_USER_UNAUTHORIZED", {
        userName: context.responsibleUserName,
      });
      return {
        code,
        status: 403,
        tone: "boundary",
        boundary: "Responsible-user ceiling",
        title: ceiling.title,
        description: `${ceiling.description} The write to ${issue} was refused for that reason.`,
        whoCanAct:
          `${responsible} once authorized, or anyone already permitted to write to ${issue}.`,
        sanctionedPath: ceiling.recommendedAction,
      };
    }

    case "issue_write_responsible_user_unavailable": {
      const unavailable = describeResponsibleUserDenial("RESPONSIBLE_USER_UNAVAILABLE", {
        userName: context.responsibleUserName,
      });
      return {
        code,
        status: 403,
        tone: "boundary",
        // Distinct from the title, which already says "unavailable" — the
        // boundary names the *mechanism*, so the two do not read as a stutter.
        boundary: "Responsible-user availability",
        title: unavailable.title,
        description: `${unavailable.description} The write to ${issue} was refused for that reason.`,
        whoCanAct: `A board member, or ${actor} once it has an active responsible user.`,
        sanctionedPath: unavailable.recommendedAction,
      };
    }

    case "issue_write_assignee_run_lock":
      return {
        code,
        status: 409,
        tone: "lock",
        boundary: "Run checkout lock",
        title: "Another agent's run owns this task",
        description:
          `${assignee} has ${issue} checked out and a run is live. Checkout and run ` +
          `ownership stay assignee-scoped even though writes are open, so field edits ` +
          `belong to the run that holds the lock until it finishes.`,
        whoCanAct:
          `${assignee}'s live run, or an agent holding the manage-active-checkouts permission.`,
        sanctionedPath:
          `Comment instead of patching — comments stay open and wake ${assignee} — or ` +
          `wait for the run to release the lock and retry.`,
      };

    case "cross_issue_influence_cap_exceeded": {
      const cap = context.cap ?? 20;
      const attempt = context.count ?? null;
      return {
        code,
        status: 429,
        tone: "cap",
        // No parentheses: surfaces render the boundary inside their own parens.
        boundary: `Per-run cross-issue cap of ${cap} writes`,
        title: "This run has spent its cross-issue write budget",
        description:
          `A single heartbeat run may make at most ${cap} cross-issue comments or task ` +
          `updates combined${attempt !== null ? `; this was attempt ${attempt}` : ""}. The cap ` +
          `bounds runaway comment sprays and loops — it is a rate backstop, not a ` +
          `permission decision, so ${actor} is still allowed to write to ${issue}.`,
        whoCanAct:
          `${actor} on its next heartbeat run, or ${assignee} on ${issue} directly.`,
        sanctionedPath:
          `Consolidate what is left into one comment on your own task, or end the run and ` +
          `continue on the next heartbeat — the budget resets per run.`,
      };
    }

    // Keyed on the reason, never on the code alone. The three conditions have
    // three different remedies and only one of them is the run header; the copy
    // used to be emitted for all three, which is what made an auditor's 403
    // impossible to act on. The run-id reasons keep the header advice because
    // for them it is the whole truth.
    case "cross_issue_influence_run_context_required":
      if (context.reason === "no_context_source_and_target_unbound") {
        return unboundTargetRunContextCopy(
          code,
          issue,
          actor,
          assignee,
          context.targetOwnedByAnotherAgent === true,
        );
      }
      return unidentifiedRunContextCopy(code, issue, actor);

    case "issue_write_attribution_spoof_rejected":
      return {
        code,
        status: 422,
        tone: "attribution",
        boundary: "Server-derived attribution",
        title: "Responsible user cannot be chosen by the caller",
        description:
          `\`onBehalfOfUserId\` is derived from the authenticated actor, never from the ` +
          `request body — an agent cannot pick the human whose authority it rides. The ` +
          `attempt was recorded in the audit log.`,
        whoCanAct:
          `${actor} itself: the write is allowed, only the chosen attribution is not.`,
        sanctionedPath:
          `Remove \`onBehalfOfUserId\` from the request and retry; the server fills in ` +
          `${responsible} from your run.`,
      };
  }
}

/**
 * Flatten a denial into the single `error` string an API client sees.
 *
 * Agents typically surface only `error`, so all three §6 obligations — boundary,
 * who can act, sanctioned path — have to survive the flattening.
 */
export function issueWriteDenialApiMessage(copy: IssueWriteDenialCopy): string {
  return [
    `${copy.title} (${copy.boundary}).`,
    copy.description,
    `Who can act: ${copy.whoCanAct}`,
    `Try this: ${copy.sanctionedPath}`,
  ].join(" ");
}

/**
 * Build the full `{ error, details }` body for a denied issue write. Keeping the
 * machine-readable `code` next to the prose lets the board UI render the same
 * copy without parsing sentences.
 */
export function issueWriteDenialResponse(
  code: IssueWriteDenialCode,
  context: IssueWriteDenialContext = {},
): {
  status: IssueWriteDenialCopy["status"];
  body: {
    error: string;
    details: {
      code: IssueWriteDenialCode;
      boundary: string;
      whoCanAct: string;
      sanctionedPath: string;
    } & Record<string, unknown>;
  };
} {
  const copy = describeIssueWriteDenial(code, context);
  return {
    status: copy.status,
    body: {
      error: issueWriteDenialApiMessage(copy),
      details: {
        code: copy.code,
        boundary: copy.boundary,
        whoCanAct: copy.whoCanAct,
        sanctionedPath: copy.sanctionedPath,
      },
    },
  };
}
