/**
 * TSMC-21471 — deterministic, ZERO-LLM triage of board asks.
 *
 * The problem this exists for. On 2026-08-24 all 30 board-owned unblock
 * descriptors across the portfolio were the SAME two generated sentences, both
 * emitted by the generation/token-ceiling guard:
 *
 *   "Record the business disposition, split the remaining work into bounded
 *    issues, or approve a deterministic route before resuming generation."
 *   "Review the token-cap partial work and approve a bounded split or
 *    deterministic route before explicitly resuming."
 *
 * Not one names a credential, a payment, a legal signature or an irreversible
 * public action. "Split the remaining work into bounded issues" is agent work.
 * The guard was parking agent-doable work on a human and — until the derivation
 * fix — doing it invisibly.
 *
 * Making them visible without triaging them would have been WORSE: thirty
 * near-identical non-asks in the operator's queue teaches them to ignore it, and
 * a queue nobody reads is the same failure one layer down.
 *
 * The vocabulary is deliberately the platform's own. `humanCategory` already
 * exists as the required gate on agent-created board interactions
 * (credential | identity | spend | oauth | g_class); an agent that cannot name
 * one is told `agent_owns_this_work`. Board-owned DESCRIPTORS never had that
 * gate. This applies the same standard to the same question.
 *
 * ⛔ Bias: when nothing matches, the answer is HUMAN-ONLY. Over-flagging costs
 * one queue entry; under-flagging silently swallows a real decision. Work is only
 * routed back when there is a POSITIVE agent-actionable signal AND no human-only
 * signal — never on the absence of evidence alone.
 */

export type BoardAskCategory = "credential" | "identity" | "spend" | "oauth" | "g_class";

export type BoardAskClassification = {
  humanOnly: boolean;
  category: BoardAskCategory | null;
  /** Human-readable justification, safe to put in a comment. */
  reason: string;
  /** The phrase that decided it, for auditability. */
  matched: string | null;
};

type Rule = { category: BoardAskCategory; label: string; patterns: RegExp[] };

/**
 * Human-only signals. Word-boundary anchored on purpose: "token-cap" and "token
 * budget" must NOT match the credential rule, which is exactly the confusion that
 * would have mis-routed the ceiling templates in the opposite direction.
 */
const HUMAN_ONLY_RULES: Rule[] = [
  {
    category: "credential",
    label: "a credential or secret",
    patterns: [
      /\bcredential(s)?\b/i, /\bsecret(s)?\b/i, /\bpassword(s)?\b/i, /\bpassphrase\b/i,
      /\bapi[-\s]?key(s)?\b/i, /\baccess[-\s]?token\b/i, /\brefresh[-\s]?token\b/i,
      /\bbearer[-\s]?token\b/i, /\brotate\s+(the\s+)?(key|secret|credential)/i,
      /\b2fa\b/i, /\bmfa\b/i, /\bone[-\s]?time[-\s]?code\b/i,
    ],
  },
  {
    category: "oauth",
    label: "an OAuth or sign-in flow only a person can complete",
    patterns: [/\boauth\b/i, /\bsign[-\s]?in\b/i, /\blog[-\s]?in\b/i, /\bre-?authenticat/i, /\bconsent screen\b/i, /\bauthori[sz]e the app\b/i],
  },
  {
    category: "spend",
    label: "money",
    patterns: [/\bpayment(s)?\b/i, /\binvoice(s)?\b/i, /\bpurchase\b/i, /\brefund\b/i, /\bbilling\b/i, /\bspend\b/i, /\bbudget increase\b/i, /\bsubscription\b/i, /\bcard\b/i],
  },
  {
    category: "identity",
    label: "identity, legal or contractual authority",
    patterns: [/\blegal\b/i, /\bcontract(s)?\b/i, /\bsignature\b/i, /\bcountersign\b/i, /\bkyc\b/i, /\bidentity verification\b/i, /\bcompany registration\b/i, /\bdirector\b/i],
  },
  {
    category: "g_class",
    label: "an irreversible or outward-facing action",
    patterns: [/\bpublish(ing|ed|es)?\b/i, /\bgo[-\s]?live\b/i, /\bmake (it |them )?live\b/i, /\birreversible\b/i, /\bdelete (the )?production\b/i, /\bsend (the )?email\b/i, /\bpost publicly\b/i, /\blive trad/i, /\bwithdraw\b/i, /\btransfer funds\b/i],
  },
];

/**
 * Positive agent-actionable signals. These are documented procedures or work a
 * lane can simply do. Presence of one of these AND absence of every human-only
 * signal is what permits routing back.
 */
const AGENT_ACTIONABLE_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bsplit the remaining work into bounded issues\b/i, why: "splitting work into bounded child issues is a lane's job" },
  { pattern: /\bapprove a (bounded split|deterministic route)\b/i, why: "choosing a bounded route is a routing decision a lane can make and record" },
  { pattern: /\brecord the business disposition\b/i, why: "recording a disposition is a lane action, not a board decision" },
  { pattern: /\btoken[-\s]?cap\b/i, why: "a token-cap stop is a budget/route decision with a documented procedure" },
  { pattern: /\baggregate input ceiling\b/i, why: "an input-ceiling stop has a documented split-and-resume procedure" },
  { pattern: /\bgeneration ceiling\b/i, why: "a generation-ceiling stop has a documented procedure" },
  { pattern: /\brotate (the )?(session|token)\b/i, why: "rotation with a documented runbook is a lane action" },
  { pattern: /\bre-?(run|measure|try|deploy|generate|start)\b/i, why: "re-running or re-measuring is a lane action" },
  { pattern: /\bprovide (a |the )?(governed )?export\b/i, why: "producing an export is a lane action" },
  { pattern: /\brestart\b/i, why: "a restart is a documented operational procedure" },
];

/** Classify one board ask. Pure, deterministic, no I/O, no model. */
export function classifyBoardAsk(actionText: string | null | undefined): BoardAskClassification {
  const text = (actionText ?? "").trim();
  if (!text) {
    return {
      humanOnly: true,
      category: null,
      reason: "The ask has no action text, so it cannot be shown to be agent-actionable. Defaulting to the operator.",
      matched: null,
    };
  }

  for (const rule of HUMAN_ONLY_RULES) {
    for (const pattern of rule.patterns) {
      const hit = text.match(pattern);
      if (hit) {
        return {
          humanOnly: true,
          category: rule.category,
          reason: `Names ${rule.label}, which only a person can supply or authorise.`,
          matched: hit[0],
        };
      }
    }
  }

  for (const { pattern, why } of AGENT_ACTIONABLE_PATTERNS) {
    const hit = text.match(pattern);
    if (hit) {
      return {
        humanOnly: false,
        category: null,
        reason: `No credential, spend, identity, OAuth or irreversible action is named, and ${why}.`,
        matched: hit[0],
      };
    }
  }

  return {
    humanOnly: true,
    category: null,
    reason:
      "No positive agent-actionable signal was found. Defaulting to the operator — "
      + "an ask is only routed back on evidence, never on the absence of it.",
    matched: null,
  };
}
