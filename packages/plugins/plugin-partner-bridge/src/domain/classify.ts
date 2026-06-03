import type { ChannelItem, Classification } from "../types.js";

const COMMITMENT_KEYWORDS = [
  "budget", "montant", "€", "eur", "contrat", "signature", "signer",
  "engagement", "devis", "avenant", "sow", "prix", "facture", "commande",
];

/**
 * Priority: explicit metadata.class -> explicit [COMMITMENT] prefix -> keyword
 * heuristic -> ambiguity fail-safe (commitment). Routine is only ever the
 * explicit "safe" path: a non-empty body with no commitment signal.
 */
export function classifyItem(item: ChannelItem): Classification {
  const explicit = item.metadata?.class;
  if (explicit === "commitment" || explicit === "routine") return explicit;

  const body = (item.body ?? "").trim();
  if (body === "") return "commitment"; // ambiguous -> over-gate

  if (/^\[COMMITMENT\]/i.test(body)) return "commitment";

  const lower = body.toLowerCase();
  if (COMMITMENT_KEYWORDS.some((k) => lower.includes(k))) return "commitment";

  return "routine";
}
