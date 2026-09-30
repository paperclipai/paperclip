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
   * Whether the raw `X-Paperclip-Run-Id` request header reached the server.
   *
   * Presence only — the run id itself is never echoed into an agent-visible body.
   * Leave unset when the request is not in hand; the copy then hedges instead of
   * asserting a cause it cannot observe.
   */
  runHeaderPresent?: boolean | null;
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

    case "cross_issue_influence_run_context_required": {
      // Three distinct failures share this code, and the caller can only act on the
      // one it is actually in. `runHeaderPresent` is the server's own observation of
      // the raw request header — presence only, never the value, since this body is
      // agent-visible and the value is a run id.
      //
      // Leaving it unset keeps the OIG-221 hedge, which is the honest copy when the
      // request is not in hand (the UI renders these from a persisted code).
      //
      // Do not offer the header alone on any branch. An on-demand run has an empty
      // `contextSnapshot`, which no caller can populate, so "send the header and retry"
      // was unreachable advice in the most common case and cost agents retry loops plus
      // a wrong conclusion about their own permissions (OIG-221). Worse, a probe agent
      // that had *already* sent the header read advice it had satisfied, concluded the
      // server was broken, invented a root cause and burned its heartbeat (OIG-308).
      const OPEN_CHANNELS =
        `Issue documents and new issues are not gated by this, so they stay available ` +
        `meanwhile.`;
      const OWNERSHIP_PATH =
        `Act from a heartbeat bound to a task, or on an issue assigned to you or checked ` +
        `out by this run.`;

      const headerArrived = context.runHeaderPresent === true;
      const headerMissing = context.runHeaderPresent === false;

      const description =
        `Every agent comment and task update is attributed to a heartbeat run so the ` +
        `cross-issue cap can be counted and the audit trail can name who acted for whom. ` +
        (headerArrived
          ? `The \`X-Paperclip-Run-Id\` header did reach the server on this request, but it ` +
            `did not resolve to a run with issue scope, and ${issue} is not one this run ` +
            `owns, so the write could not be contained.`
          : headerMissing
            ? `No \`X-Paperclip-Run-Id\` header reached the server at all, so there was no ` +
              `run to attribute the write to and it could not be contained.`
            : `Either this request carried no valid run, or its run has no issue scope and ` +
              `${issue} is not one it owns, so the write could not be contained.`);

      const sanctionedPath = headerArrived
        ? // Never tell this caller to send the header: the server saw it arrive.
          `The \`X-Paperclip-Run-Id\` header already arrived, so re-sending it cannot help. ` +
          `${OWNERSHIP_PATH} If you believe your run *is* scoped, the value did not resolve — ` +
          `check that it is your current run (\`$PAPERCLIP_RUN_ID\`, a UUID) and that the ` +
          `sandbox-bridge header allowlist forwards \`x-paperclip-run-id\` unmodified. ` +
          `${OPEN_CHANNELS}`
        : headerMissing
          ? `Send the \`X-Paperclip-Run-Id\` header with your current run (\`$PAPERCLIP_RUN_ID\`) ` +
            `and retry. The server received no such header, so if your client did send one, ` +
            `the sandbox-bridge header allowlist stripped it in transit. ${OPEN_CHANNELS}`
          : `If the request had no run id, send the \`X-Paperclip-Run-Id\` header with your ` +
            `current run (\`$PAPERCLIP_RUN_ID\`) and retry. If you already did, the run is ` +
            `unscoped — resending it cannot help. ${OWNERSHIP_PATH} ${OPEN_CHANNELS}`;

      return {
        code,
        status: 403,
        tone: "boundary",
        boundary: "Heartbeat run context",
        title: "Cross-issue writes need a run to attribute them to",
        description,
        whoCanAct: `${actor}, from a run that carries an issue scope or owns ${issue}.`,
        sanctionedPath,
      };
    }

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
