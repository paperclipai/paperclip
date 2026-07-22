// KS-DG Disclosure-Guard — the single most important unit (design): the deterministic GATE every
// outward draft must pass before a human ever sees it as "ready to send". It encodes the Divino
// `divino-sales` Hard rules VERBATIM (SKILL.md), migrated into a governed CK unit — NOT a call into
// the legacy skill. Pure, deterministic, zero-spend: text in → {pass, violations} out. It never
// sends, never rewrites; it only judges and explains.
//
// Severity:
//   "block"  — a hard disclosure/identity/timing breach. ANY block ⇒ pass=false (gate fails).
//   "warn"   — advisory (style, language hygiene, unverifiable claims). Surfaced for the human/judge;
//              does not by itself fail the gate (the drafter should still resolve warns before send).
//
// What is deliberately OUT of deterministic scope: full "truthful-or-omit" fact-checking (needs the
// live catalog as ground truth) and exact per-line price-floor matching (needs product↔price binding).
// Those get a high-precision heuristic WARN here and a judgment check downstream.

export type Severity = "block" | "warn";
export type Channel = "buyer" | "listing" | "relay" | "unknown";

export interface GuardContext {
  channel?: Channel;            // buyer-facing text gets the AI-tell style rules
  targetLanguage?: string;      // "de" | "fr" | "it" | "en" — enables language-leftover checks
  hasOrdered?: boolean;         // payment details are only allowed AFTER the buyer has ordered
  priceFloorChf?: number;       // lowest price allowed (>= treshermanos.ch); below ⇒ warn (undercut)
}

export interface Violation {
  rule: string;        // KS-DG-N code
  severity: Severity;
  message: string;     // why it tripped (verbatim-rule grounded)
  evidence: string;    // the offending excerpt
  fix?: string;        // deterministic remedy when one exists
}

export interface GuardResult {
  pass: boolean;          // no block-severity violations
  clean: boolean;         // no violations at all (block or warn)
  violations: Violation[];
}

const firstMatch = (re: RegExp, text: string): string | null => {
  const m = re.exec(text);
  return m ? m[0] : null;
};

// KS-DG-2 relay-disclosure phrases. "Tres Hermanos" alone is ALLOWED (brand shown openly); these are
// the relationship/relay/invoicing constructions that must NEVER appear. DE / FR / EN.
const RELAY_PATTERNS: RegExp[] = [
  /versand\s+(über|via|durch)\s+tres\s+hermanos/i,
  /(versand|lieferung|versendet|geliefert|verschickt|verschicken|versenden|liefert)\b[^.?!]{0,40}\b(über|von|durch|via)\s+tres\s+hermanos/i,
  /\bwir\s+bestellen\b[^.?!]{0,30}\b(bei|über|von)\b/i,
  /\b(bestellen|beziehen|ordern)\b[^.?!]{0,30}\bbei\s+tres\s+hermanos/i,
  /im\s+auftrag\s+(von|der)\s+tres\s+hermanos/i,
  /\b(weiterleiten|weitergeleitet|weiter\s+an|leiten\s+.{0,20}\s+weiter)\b[^.?!]{0,30}tres\s+hermanos/i,
  /\bdrop[\s-]?ship(ping)?\b/i,
  /\bwe\s+(order|buy|source|forward|relay|ship)\b[^.?!]{0,40}\b(from|through|via|to)\s+tres\s+hermanos/i,
  /\b(forward|relay|pass)\b[^.?!]{0,30}\byour\s+order\b/i,
  /nous\s+(commandons|transmettons|expédions)\b[^.?!]{0,30}tres\s+hermanos/i,
  /expédié\s+par\s+tres\s+hermanos/i,
  /\b(reseller|wiederverkäufer|zwischenhändler|intermediär|middleman)\b[^.?!]{0,30}tres\s+hermanos/i,
];

// KS-DG-4 payment-detail patterns (only allowed once the buyer has ordered).
const PAYMENT_PATTERNS: RegExp[] = [
  /\bCH\d{2}(?:[ ]?\d{4}){3}[ ]?\d{1,4}\b/,           // Swiss IBAN
  /\bIBAN\b/i,
  /\bkonto(nummer|inhaber)?\b/i,
  /\b(überweis(en|ung)|einzahlung\s+auf)\b/i,
  /\bbank\s*(details|verbindung|account)\b/i,
  /\bTWINT\b[^.?!]{0,20}\d/i,
];

// KS-DG-6 source-language tokens that must be translated out of a DE/IT/EN listing.
const UNTRANSLATED: Array<{ token: RegExp; fix: string }> = [
  { token: /\bEquateur\b/i, fix: "Ecuador (DE/EN) / Ecuador" },
  { token: /\bR[ée]publique\s+Dominicaine\b/i, fix: "Dominikanische Republik / Dominican Republic" },
  { token: /\bR[ée]p\.?\s+Dominicaine\b/i, fix: "Dominikanische Republik / Dominican Republic" },
  { token: /\bSaint-Domingue\b/i, fix: "Dominikanische Republik / Dominican Republic" },
  { token: /\bBr[ée]sil\b/i, fix: "Brasilien / Brazil" },
];

// KS-DG-8 unverifiable superlative/award claims (truthful-or-omit needs the catalog → advisory).
const SUPERLATIVE = /\b(award[\s-]?winning|pr[äa]miert|preisgekr[öo]nt|weltbest\w*|world'?s\s+best|100\s*punkte|9\d\s*(points|punkte)|robert\s+parker|james\s+suckling|beste[rs]?\s+zigarre\s+der\s+welt)\b/i;

export function guard(text: string, ctx: GuardContext = {}): GuardResult {
  const v: Violation[] = [];
  const t = text ?? "";

  // The identity + relay-disclosure rules protect BUYER-facing text. The internal order-relay mail
  // (channel "relay", Alan -> Tres Hermanos) legitimately names CK and states the relationship — TH is
  // the supplier and already knows it. So these two rules are scoped to everything EXCEPT relay.
  const buyerFacing = ctx.channel !== "relay";

  // KS-DG-1 IDENTITY — never name CK IT Solutions GmbH in buyer-facing text.
  if (buyerFacing) {
    const ck = firstMatch(/\bCK[\s-]?IT[\s-]?Solutions(?:\s+GmbH)?\b/i, t) ?? firstMatch(/\bckitsolutions\b/i, t);
    if (ck) v.push({ rule: "KS-DG-1", severity: "block", message: "Never name CK IT Solutions GmbH in buyer-facing text.", evidence: ck, fix: 'Seller identity is "Divino Cigars" only.' });
  }

  // KS-DG-2 RELAY — never reveal the Tres Hermanos relay/invoicing relationship to buyers.
  if (buyerFacing) {
    for (const re of RELAY_PATTERNS) {
      const hit = firstMatch(re, t);
      if (hit) { v.push({ rule: "KS-DG-2", severity: "block", message: "Never reveal the Tres Hermanos relay/invoicing relationship to buyers. The TH brand may be shown; the relationship may not.", evidence: hit.trim() }); break; }
    }
  }

  // KS-DG-3 SCHARFES-S — Swiss «ss», never «ß».
  if (t.includes("ß")) {
    const idx = t.indexOf("ß");
    v.push({ rule: "KS-DG-3", severity: "block", message: 'Swiss orthography: use «ss», never «ß».', evidence: t.slice(Math.max(0, idx - 8), idx + 4), fix: "replace ß → ss" });
  }

  // KS-DG-4 PAYMENT-TIMING — payment details go out only once the buyer has ordered.
  if (ctx.hasOrdered !== true) {
    for (const re of PAYMENT_PATTERNS) {
      const hit = firstMatch(re, t);
      if (hit) { v.push({ rule: "KS-DG-4", severity: "block", message: "Payment/bank details may be sent only AFTER the buyer has placed an order.", evidence: hit.trim() }); break; }
    }
  }

  // KS-DG-5 PRICE-FLOOR — don't undercut treshermanos.ch (advisory; product↔price binding is fuzzy).
  if (typeof ctx.priceFloorChf === "number") {
    const prices = [...t.matchAll(/(?:CHF|Fr\.?)\s*([0-9]+(?:[.,][0-9]{1,2})?)/gi)].map((m) => Number(m[1].replace(",", ".")));
    const below = prices.find((p) => p > 0 && p < ctx.priceFloorChf!);
    if (below !== undefined) v.push({ rule: "KS-DG-5", severity: "warn", message: `Price CHF ${below} is below the supplier floor CHF ${ctx.priceFloorChf} — confirm it does not undercut treshermanos.ch.`, evidence: `CHF ${below}` });
  }

  // KS-DG-6 LANGUAGE-HYGIENE — translate origins/wrapper names into the target language.
  if (ctx.targetLanguage && ctx.targetLanguage !== "fr") {
    for (const u of UNTRANSLATED) {
      const hit = firstMatch(u.token, t);
      if (hit) v.push({ rule: "KS-DG-6", severity: "warn", message: `Untranslated source-language term in a ${ctx.targetLanguage} text.`, evidence: hit, fix: `translate → ${u.fix}` });
    }
  }

  // KS-DG-7 STYLE — buyer-facing text: no dashes/bullets/markdown (AI tells).
  if (ctx.channel === "buyer") {
    const dash = firstMatch(/[—–]| - /, t);
    if (dash) v.push({ rule: "KS-DG-7", severity: "warn", message: "Buyer-facing style: no dashes used as punctuation (looks AI-generated).", evidence: dash.trim() || "- ", fix: "rewrite as plain prose" });
    const bullet = firstMatch(/^\s*[-*•]\s+/m, t);
    if (bullet) v.push({ rule: "KS-DG-7", severity: "warn", message: "Buyer-facing style: no bullet points.", evidence: bullet.trim() });
    const md = firstMatch(/\*\*|^#{1,6}\s|\[[^\]]+\]\([^)]+\)/m, t);
    if (md) v.push({ rule: "KS-DG-7", severity: "warn", message: "Buyer-facing style: no markdown formatting.", evidence: md.trim() });
  }

  // KS-DG-8 TRUTHFULNESS (heuristic) — flag unverifiable superlative/award claims for a fact-check.
  const sup = firstMatch(SUPERLATIVE, t);
  if (sup) v.push({ rule: "KS-DG-8", severity: "warn", message: "Unverifiable claim — truthful-or-omit: verify against treshermanos.ch / TH or remove.", evidence: sup });

  const pass = !v.some((x) => x.severity === "block");
  return { pass, clean: v.length === 0, violations: v };
}

// ── Golden set (rule-definitional ground truth — like GOV-01's C1–C8) ────────────────────────────
// Each case asserts the gate verdict and, when it must block, the rule that must fire. These are
// objective rule encodings (not subjective human judgment), so they are authored + active directly.
export interface GuardCase { source: string; text: string; ctx: GuardContext; pass: boolean; rule?: string; note: string; }
export const GUARD_GOLDEN: GuardCase[] = [
  { source: "G1-clean-buyer", text: "Hallo Andreas, danke für deine Nachricht. Die Tres Hermanos Piramide Nr. 2 ist verfügbar. Ich bringe dir gern ein paar vorbei. Liebe Grüsse", ctx: { channel: "buyer", targetLanguage: "de" }, pass: true, note: "clean buyer reply, TH brand shown openly" },
  { source: "G2-ck-name", text: "Diese Zigarren werden von CK IT Solutions GmbH vertrieben.", ctx: { channel: "buyer" }, pass: false, rule: "KS-DG-1", note: "names CK IT Solutions" },
  { source: "G3-relay-de", text: "Kein Problem, wir bestellen sie bei Tres Hermanos und leiten deine Bestellung weiter.", ctx: { channel: "buyer" }, pass: false, rule: "KS-DG-2", note: "reveals the relay" },
  { source: "G4-relay-versand", text: "Der Versand über Tres Hermanos dauert etwa drei Tage.", ctx: { channel: "buyer" }, pass: false, rule: "KS-DG-2", note: "reveals versand über TH" },
  { source: "G5-relay-en", text: "No problem, we forward your order to Tres Hermanos who ship it directly.", ctx: { channel: "buyer", targetLanguage: "en" }, pass: false, rule: "KS-DG-2", note: "EN relay disclosure" },
  { source: "G6-brand-ok", text: "Wir führen die Tres Hermanos Linie. Schau dir die Gordito an, ein toller Rauch.", ctx: { channel: "buyer" }, pass: true, note: "TH brand named openly — must NOT block" },
  { source: "G7-sharfes-s", text: "Die Cigarre ist groß und kräftig im Geschmack.", ctx: { channel: "buyer" }, pass: false, rule: "KS-DG-3", note: "contains ß" },
  { source: "G8-payment-before", text: "Bitte überweise den Betrag auf IBAN CH93 0076 2011 6238 5295 7.", ctx: { channel: "buyer", hasOrdered: false }, pass: false, rule: "KS-DG-4", note: "payment details before order" },
  { source: "G9-payment-after", text: "Bitte überweise den Betrag auf IBAN CH93 0076 2011 6238 5295 7.", ctx: { channel: "relay", hasOrdered: true }, pass: true, note: "same text, but buyer has ordered — allowed" },
  { source: "G10-style-dash", text: "Hallo - die Zigarren sind da. Melde dich einfach.", ctx: { channel: "buyer" }, pass: true, note: "dash is a warn, not a block — gate still passes" },
  { source: "G11-lang-leftover", text: "Deckblatt aus Equateur, sehr aromatisch.", ctx: { channel: "listing", targetLanguage: "de" }, pass: true, note: "untranslated origin is a warn, not a block" },
  { source: "G12-clean-listing", text: "Tres Hermanos Gordito. Deckblatt aus Ecuador, Einlage aus der Dominikanischen Republik. Versandkostenfrei ab CHF 250.", ctx: { channel: "listing", targetLanguage: "de" }, pass: true, note: "fully clean listing" },
  { source: "G13-relay-mail-legit", text: "Hallo, bitte folgende Bestellung versenden: Produkt Tres Hermanos Gordito, Menge 10. Zahlung über Divino / CK IT Solutions GmbH, Kunde hat an uns bezahlt. Bitte Tracking an mich.", ctx: { channel: "relay", hasOrdered: true }, pass: true, note: "internal TH order-relay mail: names CK + relationship — ALLOWED on the relay channel (recipient is TH)" },
  { source: "G14-relay-but-ck-to-buyer", text: "Diese Zigarren werden von CK IT Solutions GmbH geliefert.", ctx: { channel: "buyer" }, pass: false, rule: "KS-DG-1", note: "same CK name, but buyer channel — must still block" },
];
