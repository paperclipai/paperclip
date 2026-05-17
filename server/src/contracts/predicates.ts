import type { ContractType, IssueForContracts, CommentForContracts, VerificationResult } from "./types.js";

type Predicate = (issue: IssueForContracts, comments: CommentForContracts[]) => VerificationResult;

const TELEGRAM_INBOUND_RE = /^\[telegram:inbound\]/m;
const TELEGRAM_REPLY_RE = /^\[telegram:reply\]/m;
const BRIDGE_SECTION_TECHNICAL_RE = /^##\s+Technical notes/m;
const BRIDGE_SECTION_DECISIONS_RE = /^##\s+Decisions and outcomes/m;

function latestInboundTimestamp(comments: CommentForContracts[]): Date | null {
  const inbounds = comments
    .filter((c) => TELEGRAM_INBOUND_RE.test(c.body))
    .map((c) => c.createdAt);
  if (inbounds.length === 0) return null;
  return inbounds.reduce((latest, d) => (d > latest ? d : latest));
}

const telegramOriginPredicate: Predicate = (_issue, comments) => {
  const latestInbound = latestInboundTimestamp(comments);
  if (latestInbound === null) {
    // No inbound marker — may be originKind-based only; check for any reply
    const hasReply = comments.some((c) => TELEGRAM_REPLY_RE.test(c.body));
    if (!hasReply) {
      return {
        ok: false,
        missing: "Telegram-origin issue has no [telegram:reply] comment",
        evidenceQuery: "look for [telegram:reply] markers in comment thread",
      };
    }
    return { ok: true };
  }
  const hasReplyAfterInbound = comments.some(
    (c) => TELEGRAM_REPLY_RE.test(c.body) && c.createdAt >= latestInbound,
  );
  if (!hasReplyAfterInbound) {
    return {
      ok: false,
      missing:
        "Telegram-origin issue has no [telegram:reply] comment after the most recent [telegram:inbound]",
      evidenceQuery: "look for [telegram:reply] markers in comment thread after the latest [telegram:inbound]",
    };
  }
  return { ok: true };
};

const bridgeDispatchedPredicate: Predicate = (_issue, comments) => {
  // The close comment must contain both required H2 sections with non-empty bodies.
  // Check the last comment in the thread (the close comment).
  const closeComment = comments.at(-1);
  if (!closeComment) {
    return {
      ok: false,
      missing: "bridge-dispatched issue has no close comment with required two-section format",
      evidenceQuery: "close comment must contain '## Technical notes' and '## Decisions and outcomes' sections",
    };
  }

  const hasTechnical = BRIDGE_SECTION_TECHNICAL_RE.test(closeComment.body);
  const hasDecisions = BRIDGE_SECTION_DECISIONS_RE.test(closeComment.body);

  if (!hasTechnical || !hasDecisions) {
    return {
      ok: false,
      missing: `bridge-dispatched issue close comment missing required sections: ${[
        !hasTechnical && "'## Technical notes'",
        !hasDecisions && "'## Decisions and outcomes'",
      ]
        .filter(Boolean)
        .join(", ")}`,
      evidenceQuery:
        "close comment must contain both '## Technical notes' and '## Decisions and outcomes' H2 headers with non-empty bodies",
    };
  }

  // Check non-empty bodies: text must exist between the two headers (or after the last one)
  const body = closeComment.body;
  const technicalIdx = body.search(BRIDGE_SECTION_TECHNICAL_RE);
  const decisionsIdx = body.search(BRIDGE_SECTION_DECISIONS_RE);

  const technicalBody = body.slice(
    body.indexOf("\n", technicalIdx) + 1,
    decisionsIdx > technicalIdx ? decisionsIdx : body.length,
  ).trim();
  const decisionsBody = body
    .slice(body.indexOf("\n", decisionsIdx) + 1)
    .trim();

  if (!technicalBody || !decisionsBody) {
    return {
      ok: false,
      missing: "bridge-dispatched close comment section bodies must be non-empty",
      evidenceQuery: "ensure '## Technical notes' and '## Decisions and outcomes' sections have content",
    };
  }

  return { ok: true };
};

const codeChangePredicate: Predicate = (issue, comments) => {
  // Check for PR URL in comments or description
  const PR_URL_RE = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;
  const NO_PR_RE = /\[?no-pr\]?|no pr:/i;

  const hasPrUrl =
    PR_URL_RE.test(issue.description ?? "") ||
    comments.some((c) => PR_URL_RE.test(c.body));
  const hasNoPrJustification = comments.some((c) => NO_PR_RE.test(c.body));
  const hasMergedLabel = issue.labels.some((l) => l.name === "github/pr-merged");

  if (!hasPrUrl && !hasNoPrJustification && !hasMergedLabel) {
    return {
      ok: false,
      missing: "code-change issue has no PR URL referenced and no 'no-pr' justification comment",
      evidenceQuery:
        "add a comment with the GitHub PR URL or a 'no-pr: <reason>' justification; or ensure the github/pr-merged label is applied",
    };
  }

  return { ok: true };
};

const designOnlyPredicate: Predicate = (issue, comments) => {
  // Check for plan document existence (signaled by a comment or by the contract context)
  // We check via comment bodies since we don't have document API access in-predicate
  const hasPlanSignal =
    comments.some((c) => /\[?plan document\]?|#document-plan/i.test(c.body)) ||
    /plan only|do not write code/i.test(issue.description ?? "");

  if (!hasPlanSignal) {
    return {
      ok: false,
      missing: "design-only issue has no plan document signal in thread or description",
      evidenceQuery: "ensure a plan document exists (PUT /api/issues/{id}/documents/plan) and is referenced in a comment",
    };
  }

  // Check for approval signal: accepted request_confirmation interaction or approver comment
  const hasApprovalSignal = comments.some(
    (c) =>
      /approved|self-approve|self approve|approval.*accepted/i.test(c.body) ||
      /\[contract-override\]/i.test(c.body),
  );

  if (!hasApprovalSignal) {
    return {
      ok: false,
      missing: "design-only issue has no approval signal — need accepted request_confirmation or explicit approver comment",
      evidenceQuery: "create a request_confirmation interaction and wait for acceptance, or post an explicit approval comment",
    };
  }

  return { ok: true };
};

const metaNoArtifactPredicate: Predicate = (_issue, _comments) => {
  // We cannot check child issue statuses from within a pure predicate without DB access.
  // This predicate is intentionally permissive in the pure check — the server-side gate
  // enriches with child status data before calling. Signal: if called here without enrichment,
  // we return ok (the gate layer will handle the DB check).
  return { ok: true };
};

export const PREDICATES: Record<ContractType, Predicate> = {
  "telegram-origin": telegramOriginPredicate,
  "bridge-dispatched": bridgeDispatchedPredicate,
  "code-change": codeChangePredicate,
  "design-only": designOnlyPredicate,
  "meta-no-artifact": metaNoArtifactPredicate,
};
