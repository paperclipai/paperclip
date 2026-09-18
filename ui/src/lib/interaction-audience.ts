/**
 * Plain-language presentation of *who may resolve* an issue-thread interaction
 * (PAP-17280, Phase 3 of the open-default resolver contract in
 * `doc/SPEC-implementation.md` §9.8.1).
 *
 * The product default is open: an interaction created without an explicit
 * `resolverPolicy` is resolvable by `anyone` in the company — the board or any
 * agent, including the agent that created it. `not_creator`, `human_only`, and a
 * named addressee are *narrowing* controls that a requester asks for on purpose.
 *
 * This module is presentation only. It never decides authority: the server
 * evaluator owns that, and every downstream effect re-runs its own
 * authorization (see the Phase 1S security verdict on PAP-17278). Everything
 * here is derived from the server-provided snapshot fields
 * (`requestedResolverPolicy`, `effectiveResolverPolicy`,
 * `effectiveResolverPolicySource`, `resolverPolicyProvenance`) so the copy a
 * reader sees agrees with the policy the server will apply.
 */

import {
  ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES,
  normalizeIssueThreadInteractionResolverPolicy,
  type AttentionItem,
  type AttentionResolverAudience,
  type IssueThreadInteractionCanonicalResolverPolicy,
  type IssueThreadInteractionEffectiveResolverPolicySource,
  type IssueThreadInteractionResolverPolicy,
  type IssueThreadInteractionResolverPolicyProvenance,
} from "@paperclipai/shared";
import type { IssueThreadInteraction } from "./issue-thread-interactions";

/**
 * The open default. Creation surfaces present this first and requesters omit
 * `resolverPolicy` to get it.
 */
export const DEFAULT_RESOLVER_POLICY: IssueThreadInteractionCanonicalResolverPolicy = "anyone";

/** Short label for a resolver audience — badges, select options, table cells. */
const RESOLVER_POLICY_LABELS: Record<IssueThreadInteractionCanonicalResolverPolicy, string> = {
  anyone: "Anyone",
  not_creator: "Anyone except creator",
  human_only: "Human only",
};

/**
 * Plain-language preview of what a policy *does*, phrased for a surface that is
 * choosing it for future cards (company defaults and caps). Card-specific copy
 * that names the real creator/addressee comes from
 * {@link describeInteractionAudience}.
 */
const RESOLVER_POLICY_EFFECTS: Record<IssueThreadInteractionCanonicalResolverPolicy, string> = {
  anyone:
    "Anyone in the organization can respond — the board or any agent, including the one that asked.",
  not_creator:
    "Anyone in the organization except the agent that created the card, and its run. Use this when the answer has to come from someone else.",
  human_only: "Only a person on the board can respond. Agents are turned away.",
};

/** Accepts canonical values and the deprecated `board_*` compatibility aliases. */
export function resolverPolicyLabel(policy: IssueThreadInteractionResolverPolicy): string {
  return RESOLVER_POLICY_LABELS[normalizeIssueThreadInteractionResolverPolicy(policy)];
}

/** Accepts canonical values and the deprecated `board_*` compatibility aliases. */
export function resolverPolicyEffect(policy: IssueThreadInteractionResolverPolicy): string {
  return RESOLVER_POLICY_EFFECTS[normalizeIssueThreadInteractionResolverPolicy(policy)];
}

/**
 * Ordered choice list for every surface that picks a resolver audience. `anyone`
 * is first and marked as the default so the open option reads as the normal
 * path rather than a permission grant.
 */
export const RESOLVER_POLICY_CHOICES: readonly {
  value: IssueThreadInteractionCanonicalResolverPolicy;
  label: string;
  effect: string;
  isDefault: boolean;
}[] = ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES.map((value) => ({
  value,
  label: RESOLVER_POLICY_LABELS[value],
  effect: RESOLVER_POLICY_EFFECTS[value],
  isDefault: value === DEFAULT_RESOLVER_POLICY,
}));

/** Why an effective audience ended up narrower than the requested one. */
export type InteractionAudienceNarrowing =
  | "requested"
  | "company_cap"
  | "governed_action"
  | "addressee"
  | "legacy_restriction";

export interface InteractionAudienceDescription {
  /** Effective canonical policy the server will enforce. */
  policy: IssueThreadInteractionCanonicalResolverPolicy;
  /** Canonical policy the creator asked for (before caps/clamps). */
  requestedPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  /** Short badge label for the effective audience. */
  label: string;
  /** One sentence naming exactly who can respond to *this* card. */
  summary: string;
  /**
   * The same fact in a glanceable clause, for a dense surface that shows the
   * audience beside compact decision buttons (collapsed attention rows).
   */
  shortSummary: string;
  /** True when the card is open to the whole company with no addressee. */
  isOpen: boolean;
  /** Set when something narrows the audience below the open default. */
  narrowedBy: InteractionAudienceNarrowing | null;
  /** Extra sentence explaining a narrowing the requester did not ask for. */
  narrowedNote: string | null;
}

/**
 * The server-evaluated facts an audience description is derived from. Both the
 * full interaction snapshot (issue thread) and the attention feed's
 * `resolverAudience` (collapsed queue rows) reduce to this shape, so one copy
 * table serves both surfaces and they cannot drift.
 */
export interface InteractionAudienceFacts {
  effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  requestedResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  effectiveResolverPolicySource: IssueThreadInteractionEffectiveResolverPolicySource;
  resolverPolicyProvenance: IssueThreadInteractionResolverPolicyProvenance;
  hasAddressee: boolean;
  isUserAddressee?: boolean;
}

/**
 * Describe the effective audience of one interaction.
 *
 * Precedence mirrors the server evaluator's *narrowing* order so the copy can
 * never promise a wider audience than the API allows: `human_only` (including a
 * governed-action clamp) beats a named addressee, which beats `not_creator`,
 * which beats the open default.
 */
export function describeInteractionAudience({
  interaction,
  creatorLabel,
  addresseeLabel,
}: {
  interaction: IssueThreadInteraction;
  /** Display label of the creating actor, when known. */
  creatorLabel?: string | null;
  /** Display label of the named addressee, when the card has one. */
  addresseeLabel?: string | null;
}): InteractionAudienceDescription {
  return describeResolverAudience({
    facts: {
      effectiveResolverPolicy: interaction.effectiveResolverPolicy,
      requestedResolverPolicy: interaction.requestedResolverPolicy,
      effectiveResolverPolicySource: interaction.effectiveResolverPolicySource,
      resolverPolicyProvenance: interaction.resolverPolicyProvenance,
      hasAddressee: Boolean(interaction.addresseeAgentId || interaction.addresseeUserId),
      isUserAddressee: Boolean(interaction.addresseeUserId),
    },
    creatorLabel,
    addresseeLabel,
  });
}

/**
 * Describe an effective audience from the server-evaluated facts alone — used
 * where the full interaction is not loaded, such as a collapsed attention row
 * (PAP-17287).
 */
export function describeResolverAudience({
  facts,
  creatorLabel,
  addresseeLabel,
}: {
  facts: InteractionAudienceFacts;
  creatorLabel?: string | null;
  addresseeLabel?: string | null;
}): InteractionAudienceDescription {
  const policy = facts.effectiveResolverPolicy;
  const requestedPolicy = facts.requestedResolverPolicy;
  const hasAddressee = facts.hasAddressee;
  const isUserAddressee = facts.isUserAddressee === true;
  // `formatAssigneeUserLabel` returns the display-cased "You" for the signed-in
  // reader, which is right for a badge and wrong mid-sentence ("Only You can
  // respond."). Every use below is inside a sentence.
  const midSentence = (label: string) => (label === "You" ? "you" : label);
  const addressee = midSentence(
    addresseeLabel?.trim() || (isUserAddressee ? "the addressed user" : "the addressed agent"),
  );
  const creator = midSentence(creatorLabel?.trim() || "the agent that created it");

  const summary = isUserAddressee
    ? `Only ${addressee} can respond.`
    : policy === "human_only"
    ? `${hasAddressee ? `Assigned to ${addressee}. ` : ""}Only a person on the board can respond — agents cannot resolve this card.`
    : hasAddressee
      ? `Only ${addressee} or a person on the board can respond.`
      : policy === "not_creator"
        ? `Anyone in the organization except ${creator} can respond.`
        : "Anyone in the organization can respond — the board or any agent, including the one that asked.";

  // Same fact, fewer words: a collapsed row has to answer "is this mine to
  // decide?" in one glance, next to the buttons that act on the answer.
  const shortSummary = isUserAddressee
    ? `Only ${addressee} can respond`
    : policy === "human_only"
    ? hasAddressee
      ? `Assigned to ${addressee} · board only`
      : "Only the board can respond"
    : hasAddressee
      ? `Only ${addressee} or the board can respond`
      : policy === "not_creator"
        ? `Anyone except ${creator} can respond`
        : "Anyone can respond";

  const source = facts.effectiveResolverPolicySource;
  const provenance = facts.resolverPolicyProvenance;

  // Narrowing the requester did *not* ask for is the only thing worth an extra
  // sentence: a governed-action clamp, a company cap, or a card created before
  // open resolution existed. An explicitly requested restriction is already
  // fully described by `summary`.
  const narrowedNote = source === "governed_action"
    ? "This card runs a governed action, so it stays human-only whatever audience was requested."
    : source === "company_cap"
      ? `Organization interaction governance narrowed this from ${RESOLVER_POLICY_LABELS[requestedPolicy]} to ${RESOLVER_POLICY_LABELS[policy]}.`
      : provenance === "legacy_inherited_restriction"
        ? "Created before Anyone became the default, so it stays restricted. A new card would be open."
        : null;

  const narrowedBy: InteractionAudienceNarrowing | null = source === "governed_action"
    ? "governed_action"
    : source === "company_cap"
      ? "company_cap"
      : provenance === "legacy_inherited_restriction"
        ? "legacy_restriction"
        : policy !== "anyone"
          ? "requested"
          : hasAddressee
            ? "addressee"
            : null;

  return {
    policy,
    requestedPolicy,
    // A named addressee owns the response, so the label must not read "Anyone"
    // while the sentence next to it names one actor. `human_only` wins for an
    // agent addressee, while a user addressee is the narrower human audience.
    label: (policy !== "human_only" || isUserAddressee) && hasAddressee
      ? "Addressed"
      : RESOLVER_POLICY_LABELS[policy],
    summary,
    shortSummary,
    isOpen: policy === "anyone" && !hasAddressee,
    narrowedBy,
    narrowedNote,
  };
}

/**
 * Audience of an `issue_thread_interaction` attention row, from the server
 * metadata the feed ships with the item (PAP-17287). Returns `null` for every
 * other source kind and for a feed built before the metadata existed, so a
 * caller renders nothing rather than guessing a policy client-side.
 */
export function describeAttentionResolverAudience(
  item: Pick<AttentionItem, "sourceKind" | "resolverAudience">,
): InteractionAudienceDescription | null {
  if (item.sourceKind !== "issue_thread_interaction") return null;
  const audience: AttentionResolverAudience | null | undefined = item.resolverAudience;
  if (!audience) return null;
  return describeResolverAudience({
    facts: {
      effectiveResolverPolicy: audience.effectiveResolverPolicy,
      requestedResolverPolicy: audience.requestedResolverPolicy,
      effectiveResolverPolicySource: audience.effectiveResolverPolicySource,
      resolverPolicyProvenance: audience.resolverPolicyProvenance,
      hasAddressee: Boolean(audience.addresseeAgentId || audience.addresseeUserId),
      isUserAddressee: Boolean(audience.addresseeUserId),
    },
    creatorLabel: audience.createdByAgentName,
    addresseeLabel: audience.addresseeName,
  });
}
