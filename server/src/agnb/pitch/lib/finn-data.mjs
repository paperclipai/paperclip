// Loads the committed Finn content snapshot (data/) + matching helpers.
// Generator/render read ONLY this — no dependency on hf-web-v2.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const D = (f) => JSON.parse(readFileSync(join(root, "snapshot", f), "utf8"));

// Assets live in a public bucket (no binaries committed). A committed manifest
// lists available files; emitted URLs point at the bucket. Base overridable via env.
const PITCH_ASSET_BASE =
  process.env.PITCH_ASSET_BASE || "https://storage.googleapis.com/agnb-pitch-assets";
const MANIFEST = new Set(D("asset-manifest.json"));
const norm = (rel) => rel.replace(/^assets\//, "");
const has = (rel) => MANIFEST.has(norm(rel));
const listDir = (dir) =>
  [...MANIFEST]
    .filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))
    .map((p) => p.slice(dir.length + 1));
export const assetUrl = (rel) => `${PITCH_ASSET_BASE}/${norm(rel)}`;

export const plans = D("plans.json");
export const capabilities = D("capabilities.json");
export const testimonials = D("testimonials.json").TESTIMONIALS;
export const industries = D("industries.json").INDUSTRIES;
export const playbooks = D("playbooks.json").PLAYBOOKS;
export const useCases = D("usecases.json").useCaseDataMap;
export const languages = D("languages.json");
export const pricingFaq = D("pricing-faq.json").pricingFaqData;
export const billing = D("billing.json").FINN_BILLING;

// --- industry match (fuzzy on client's free-text industry) ---
export function matchIndustry(text = "") {
  const t = text.toLowerCase();
  let best = null, score = 0;
  for (const ind of industries) {
    const hay = `${ind.title} ${ind.desc} ${(ind.tags || []).join(" ")} ${ind.href}`.toLowerCase();
    const words = t.split(/\W+/).filter((w) => w.length > 3);
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += 2;
    if (ind.title.toLowerCase().includes(t) || t.includes(ind.title.toLowerCase())) s += 5;
    if (s > score) { score = s; best = ind; }
  }
  return score > 0 ? best : null;
}

// --- testimonial: prefer one whose vertical matches, else strongest ---
// Each testimonial covers a cluster of verticals so all 21 industries match
// a plausibly on-vertical proof slide instead of falling back to one default.
const TESTI_INDUSTRY = {
  snazzy: ["real estate", "home services", "solar"],
  orbit: ["fintech", "financial services", "banking", "mortgage", "insurance", "debt collection", "collections"],
  frinks: ["manufacturing", "logistics", "automotive"],
  tofa: ["retail", "ecommerce", "hospitality", "travel", "wellness"],
  rocketsdr: ["recruitment", "saas", "education"],
  pbs: ["customer service", "customer success", "support", "legal", "non-profit", "healthcare"]
};
export function pickTestimonial(industryText = "") {
  const t = industryText.toLowerCase();
  const list = Object.values(testimonials);
  const hit = list.find((x) =>
    (TESTI_INDUSTRY[x.id] || []).some((v) => v && (t.includes(v) || v.includes(t)))
  );
  return hit || list[0];
}

// --- playbook match by use case / industry ---
export function matchPlaybook(useCaseKey = "", industryText = "") {
  const uc = useCaseKey.toLowerCase();
  const map = {
    inbound_support: ["support", "receptionist", "customer service", "help"],
    receptionist: ["receptionist", "reception", "front desk", "check-in", "inbound"],
    outbound_sales: ["sales", "demo", "lead", "upsell", "offer"],
    collections: ["payment", "collection", "repayment", "reminder"],
    scheduling: ["schedul", "appointment", "booking", "reminder", "setter"],
    qualification: ["qualif", "lead", "screening", "intake"],
    renewals: ["renewal", "retention", "reactivat", "win-back", "reconnect", "upsell", "promo"],
    surveys: ["survey", "feedback", "csat", "nps", "research", "screening"]
  };
  const wants = map[uc] || [];
  const t = industryText.toLowerCase();
  let best = null, score = 0;
  for (const pb of playbooks) {
    const hay = `${pb.name} ${pb.description || ""} ${pb.category || ""} ${(pb.features || []).join(" ")} ${pb.role || ""}`.toLowerCase();
    let s = 0;
    for (const w of wants) if (hay.includes(w)) s += 2;
    if (pb.category && t.includes(pb.category.toLowerCase())) s += 3;
    if (s > score) { score = s; best = pb; }
  }
  return best || playbooks[0];
}

// --- capability hero stats (for capabilities slide) ---
export function capabilityStats() {
  const pg = capabilities.CAPABILITY_PAGES?.capabilities;
  return pg?.stats || [];
}
export function capabilityPillars() {
  return (capabilities.CAPABILITIES || []).map((c) => ({ title: c.title, desc: c.desc }));
}

// --- pricing lines for the region ---
export function planLines(region = "india") {
  const c = region === "india" ? "inr" : "usd";
  const s = region === "india" ? "₹" : "$";
  return plans.PLANS.map((p) => ({
    name: p.name, tagline: p.tagline,
    rate: p.ratePerCredit[c] === undefined ? "Custom" : `${s}${p.ratePerCredit[c]}/credit`,
    concurrency: p.concurrentCalls ? `${p.concurrentCalls} concurrent` : "Unlimited",
    perks: p.perks || []
  }));
}

// --- brand voice sample taglines ---
export function taglines() {
  return [
    "Your outbound, inbound, and CRM data. Acting as one.",
    "Finn is the enterprise voice orchestration layer. It makes thousands of concurrent calls, reasons through them, extracts data, and updates your systems in real-time. No rework. No idle time.",
    "The infrastructure behind every call.",
    "Voice that thinks. At the speed of a heartbeat.",
    "Stop demoing. Start shipping.",
    "The phone still runs the world's businesses, and most are quietly losing on it.",
    "We measure outcomes, not minutes.",
    "We'd rather be boring and reliable than clever and broken."
  ];
}

// --- asset helpers (return /-rooted URL served by the server, or null) ---
const slugify = (s = "") => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function industryHero(industryText = "", matched = null) {
  const tries = [];
  if (matched?.href) tries.push(matched.href.split("/").pop());
  if (matched?.title) tries.push(slugify(matched.title));
  tries.push(slugify(industryText));
  for (const t of tries) {
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
      if (has(`industry-hero/${t}.${ext}`)) return assetUrl(`industry-hero/${t}.${ext}`);
    }
  }
  return null;
}

export function logoUrls(names = []) {
  return names.map((n) => slugify(n))
    .map((n) => (has(`logos/${n}.svg`) ? assetUrl(`logos/${n}.svg`) : null))
    .filter(Boolean);
}
export function allIntegrationLogos(limit = 12) {
  return listDir("logos")
    .filter((f) => f.endsWith(".svg")).slice(0, limit)
    .map((f) => assetUrl(`logos/${f}`));
}
export function customerLogo(testi) {
  if (!testi) return null;
  const f = listDir("customers").find((x) => x.toLowerCase().startsWith(testi.id));
  return f ? assetUrl(`customers/${f}`) : null;
}
export function brandAsset(name) {
  return has(`brand/${name}`) ? assetUrl(`brand/${name}`) : null;
}
