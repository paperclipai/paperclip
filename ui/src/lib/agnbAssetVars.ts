/**
 * Variable extractor + renderer for AGNB marketing assets.
 * Ported verbatim from AGNB lib/agnb/asset-vars.ts (keep in sync).
 */
export type VarType = "text" | "number" | "date" | "image" | "textarea";

export interface AssetVar {
  name: string;
  type: VarType;
  label: string;
  defaultValue: string;
}

function stripBlocks(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ");
}

const TYPES = new Set<VarType>(["text", "number", "date", "image", "textarea"]);

const ACRONYMS = new Set([
  "inr", "usd", "eur", "gbp", "did", "dnc", "did_pool", "ifsc", "gst", "gstin",
  "pan", "tan", "iban", "swift", "ach", "upi", "kyc", "aml", "soc2", "soc",
  "hipaa", "pci", "dpdp", "gdpr", "sla", "mou", "nda", "api", "sdk", "url",
  "uri", "ssl", "tls", "jwt", "hmac", "mrr", "arr", "cac", "ltv", "cogs",
  "ebitda", "ebit", "rfp", "rfq", "po", "sow", "msa", "eula", "ai", "ml",
  "llm", "rag", "tts", "stt", "asr", "nlu", "crm", "erp", "saas", "paas",
  "iaas", "etl",
]);

function humanize(name: string): string {
  return name
    .split("_")
    .map((tok) =>
      ACRONYMS.has(tok.toLowerCase())
        ? tok.toUpperCase()
        : tok.charAt(0).toUpperCase() + tok.slice(1),
    )
    .join(" ");
}

function asVar(name: string, rawType: string | undefined): AssetVar {
  const t = (rawType ?? "text").toLowerCase();
  const type: VarType = (TYPES.has(t as VarType) ? t : "text") as VarType;
  return {
    name,
    type,
    label: humanize(name),
    defaultValue: type === "date" ? new Date().toISOString().slice(0, 10) : "",
  };
}

export function extractVars(html: string): AssetVar[] {
  const cleaned = stripBlocks(html);
  const seen = new Map<string, AssetVar>();

  const mustache = /\{\{\s*([a-z_][a-z0-9_]*)(?:\s*\|\s*([a-z]+))?\s*\}\}/gi;
  let m: RegExpExecArray | null;
  while ((m = mustache.exec(cleaned)) !== null) {
    const name = m[1].toLowerCase();
    if (!seen.has(name)) seen.set(name, asVar(name, m[2]));
  }

  const single = /(?<!\{)\{\s*([a-z_][a-z0-9_]*)(?:\s*\|\s*([a-z]+))?\s*\}(?!\})/gi;
  while ((m = single.exec(cleaned)) !== null) {
    const name = m[1].toLowerCase();
    if (seen.has(name)) continue;
    if (/[:;=]/.test(m[0])) continue;
    seen.set(name, asVar(name, m[2]));
  }

  return Array.from(seen.values());
}

/** HTML-escape a fill value so it can't break out of text/attribute context. */
function escapeValue(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function render(html: string, values: Record<string, string>): string {
  const blocks: string[] = [];
  const placeholder = (i: number) => ` AGNBBLOCK${i} `;
  // Drop <script> entirely — rendered output is downloaded/saved and reopened as
  // a live document, so template scripts are an XSS vector with no legit use here.
  // <style> is stashed (not stripped) so variable substitution can't corrupt CSS.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, (mm) => {
      blocks.push(mm);
      return placeholder(blocks.length - 1);
    });

  // Fill values are user-supplied plain text — always escaped. The template
  // markup itself is author-controlled and passes through untouched.
  let out = stripped.replace(
    /\{\{\s*([a-z_][a-z0-9_]*)(?:\s*\|\s*[a-z]+)?\s*\}\}/gi,
    (_full, name: string) => escapeValue(String(values[name.toLowerCase()] ?? "")),
  );
  out = out.replace(
    /(?<!\{)\{\s*([a-z_][a-z0-9_]*)(?:\s*\|\s*[a-z]+)?\s*\}(?!\})/gi,
    (full, name: string) => {
      if (/[:;=]/.test(full)) return full;
      const v = values[name.toLowerCase()];
      return v === undefined ? full : escapeValue(String(v));
    },
  );

  return out.replace(/ AGNBBLOCK(\d+) /g, (_match, i: string) => blocks[Number(i)] ?? "");
}

/** Semantic grouping for the fill form (mirrors AGNB asset-editor groups). */
const GROUP_DEFS: Array<{ label: string; match: RegExp }> = [
  { label: "Customer", match: /^(client|customer|contact|company|account|recipient|prospect|name|representative)/i },
  { label: "Pricing", match: /(price|amount|cost|rate|fee|payment|invoice|total|discount|min|max|commitment|inr|usd|eur)/i },
  { label: "Dates", match: /(date|month|year|day|deadline|start|end|signed|expire|effective|term)/i },
  { label: "Identifiers", match: /(id$|number|code|sku|po_|ref|invoice_no|order)/i },
  { label: "Notes & terms", match: /(note|memo|comment|term|condition|legal|description|summary)/i },
];

export function groupVars(vars: AssetVar[]): Array<{ label: string; vars: AssetVar[] }> {
  const groups = GROUP_DEFS.map((g) => ({ label: g.label, vars: [] as AssetVar[] }));
  const other: AssetVar[] = [];
  for (const v of vars) {
    const idx = GROUP_DEFS.findIndex((g) => g.match.test(v.name));
    if (idx >= 0) groups[idx].vars.push(v);
    else other.push(v);
  }
  if (other.length) groups.push({ label: "Other", vars: other });
  return groups.filter((g) => g.vars.length > 0);
}
