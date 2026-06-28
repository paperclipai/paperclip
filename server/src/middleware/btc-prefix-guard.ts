import type { Response } from "express";

// Case-insensitive to catch variants like btc-9999; shared via /gi with matchAll below.
const BTC_PREFIX_TOKEN_RE = /\bBTC-(\d{1,6})\b/gi;
export const BTC_FULL_PREFIX = "BTCAAAAA";

export type BtcPrefixActorContext = {
  type?: string;
  companyId?: string | null;
  companyIds?: string[] | null;
};

export type BtcPrefixLookup = (
  fullIdentifier: string,
  companyId: string,
) => Promise<{ exists: boolean } | null>;

export type BtcPrefixGuardResult =
  | { ok: true }
  | {
      ok: false;
      offendingToken: string;
      suggestedFull: string;
      actorCompanyId: string;
    };

/** Strip fenced and inline code blocks to avoid false positives on code examples. */
function stripCodeBlocks(text: string): string {
  // Fenced blocks: ```...``` (including optional language hint)
  let out = text.replace(/```[\s\S]*?```/g, " ");
  // Inline code: `...` (single-line only to avoid over-stripping)
  out = out.replace(/`[^`\n]*`/g, " ");
  return out;
}

export function extractBtcPrefixTokens(text: string | null | undefined): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const cleaned = stripCodeBlocks(text);
  const out: string[] = [];
  // matchAll requires the /g flag; /i is safe to combine for case-insensitive extraction.
  for (const match of cleaned.matchAll(new RegExp(BTC_PREFIX_TOKEN_RE.source, "gi"))) {
    out.push(match[0]);
  }
  return out;
}

export function pickActorCompanyId(actor: BtcPrefixActorContext | null | undefined): string | null {
  if (!actor) return null;
  if (typeof actor.companyId === "string" && actor.companyId.length > 0) return actor.companyId;
  if (Array.isArray(actor.companyIds) && actor.companyIds.length > 0) {
    const first = actor.companyIds[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  return null;
}

/** Return ALL unique company IDs from the actor context (for multi-company board actors). */
function pickActorCompanyIds(actor: BtcPrefixActorContext | null | undefined): string[] {
  if (!actor) return [];
  const ids: string[] = [];
  if (typeof actor.companyId === "string" && actor.companyId.length > 0) {
    ids.push(actor.companyId);
  }
  if (Array.isArray(actor.companyIds)) {
    for (const cid of actor.companyIds) {
      if (typeof cid === "string" && cid.length > 0 && !ids.includes(cid)) {
        ids.push(cid);
      }
    }
  }
  return ids;
}

export function suggestedFullForm(token: string, fullPrefix: string = BTC_FULL_PREFIX): string | null {
  // Case-insensitive to handle tokens extracted with /gi (e.g. "btc-9999")
  const numeric = /^BTC-(\d{1,6})$/i.exec(token)?.[1];
  if (!numeric) return null;
  return `${fullPrefix}-${numeric}`;
}

export async function enforceBtcPrefixTokens(params: {
  text: string | null | undefined;
  /** Explicit company scope for validation. Takes precedence over actor when set. */
  companyId?: string | null;
  actor?: BtcPrefixActorContext | null | undefined;
  lookup: BtcPrefixLookup;
  fullPrefix?: string;
}): Promise<BtcPrefixGuardResult> {
  const { text, lookup } = params;
  const fullPrefix = params.fullPrefix ?? BTC_FULL_PREFIX;
  const tokens = extractBtcPrefixTokens(text);
  if (tokens.length === 0) return { ok: true };

  // Prefer explicit companyId (always the right scope for route-level callers).
  // Fall back to ALL actor company IDs so board actors with multiple companies
  // are not falsely rejected when the target issue is in a non-primary company.
  let companyIds: string[];
  let primaryCompanyId: string;
  if (typeof params.companyId === "string" && params.companyId.length > 0) {
    companyIds = [params.companyId];
    primaryCompanyId = params.companyId;
  } else {
    companyIds = pickActorCompanyIds(params.actor);
    primaryCompanyId = companyIds[0] ?? "";
  }
  if (companyIds.length === 0) {
    return { ok: true };
  }

  const candidates: Array<{ token: string; candidate: string }> = [];
  for (const token of tokens) {
    const candidate = suggestedFullForm(token, fullPrefix);
    if (!candidate) continue;
    if (candidates.some((c) => c.candidate === candidate)) continue;
    candidates.push({ token, candidate });
  }
  if (candidates.length === 0) return { ok: true };

  // A token is valid if it resolves in ANY of the actor's companies.
  for (const c of candidates) {
    const lookupResults = await Promise.all(
      companyIds.map((cid) => lookup(c.candidate, cid)),
    );
    const resolvesInAny = lookupResults.some((r) => r?.exists);
    if (!resolvesInAny) {
      return {
        ok: false,
        offendingToken: c.token,
        suggestedFull: c.candidate,
        actorCompanyId: primaryCompanyId,
      };
    }
  }
  return { ok: true };
}

export function respondBtcPrefixGuardFailure(
  res: Response,
  result: Extract<BtcPrefixGuardResult, { ok: false }>,
) {
  res.status(422).json({
    error: "Truncated prefix",
    message: `Comment contains '${result.offendingToken}' which does not resolve to a real identifier in this company. Use the full '${result.suggestedFull}' form.`,
    details: {
      offendingToken: result.offendingToken,
      suggestedFull: result.suggestedFull,
      companyId: result.actorCompanyId,
    },
  });
}
