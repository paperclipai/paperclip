import type { PluginContext } from "@paperclipai/plugin-sdk";
import { initialMemoryStatus, normalizeMemoryWrite } from "./memory-write-policy.js";
import type { Espo } from "./espo.js";
import { readFileSync, writeFileSync } from "node:fs";
import { selfHealCityFromStreet } from "./crm-selfheal.js";
import { looksLikeTestOrExperiment, resolveEspoSendRoute, isAlanSafeRecipient } from "./send-guard.js";
import {
  matchProspectIssueWork,
  paginateEspo,
  rankProspectAccounts,
  type ProspectAccount,
} from "./prospect-priority.js";
import {
  buildOutreachTaskPairBrief,
  calculateQueueRefill,
  fetchDrivingMetrics,
  selectDistanceQueue,
  type OutreachQueueCandidate,
} from "./prospect-distance.js";
import {
  approvalQueueCollision,
  outreachApprovalContinuationPolicy,
  outreachApprovalSupersedesOnUserComment,
} from "./approval-lifecycle.js";
import { rejectionFeedbackLesson } from "./outreach-learning.js";
import { isEspoRecordId } from "./espo-record-id.js";
import { quoteMentionsMeetingDate, validateMeetingWrite } from "./meeting-write-guard.js";

// CK agent tools — registered NATIVELY via ctx.tools.register (agent.tools.register capability), so any
// agent/adapter can discover them (GET /api/plugins/tools) and run them (POST /api/plugins/tools/execute).
// Replaces the tools that were hardcoded in the CK runner. web_fetch falls back to the camofox+phone
// stealth bridge; espo_set_email enforces the anti-cross-write guard.
const STEALTH_URL = process.env.CK_STEALTH_URL || "http://127.0.0.1:9378";
const MAIL_RELAY_URL = process.env.CK_MAIL_RELAY_URL || "http://127.0.0.1:9390";
// Brave Search API key: env first, then /work/.brave-api.key (host ~/paperclip/.brave-api.key, gitignored).
// File path lets us wire a key WITHOUT a server restart — the plugin upgrade reloads this module.
function readBraveKey(): string | undefined {
  const e = process.env.CK_BRAVE_API_KEY;
  if (e && e.trim()) return e.trim();
  try { const f = readFileSync("/work/.brave-api.key", "utf8").trim(); return f || undefined; } catch { return undefined; }
}

// ── Route planning for in-person prospect visits: geocode via OpenStreetMap/Nominatim (free, no key,
// cached to /work/.route-geocache.json) + optimize the driving order via OSRM. Returns a Google Maps
// multi-stop link Alan can open on his phone for turn-by-turn. All free/open-source.
type LatLon = [number, number];
const GEO_CACHE_FILE = "/work/.route-geocache.json";
let GEO_CACHE: Record<string, LatLon | null> | null = null;
function geoCache(): Record<string, LatLon | null> {
  if (!GEO_CACHE) { try { GEO_CACHE = JSON.parse(readFileSync(GEO_CACHE_FILE, "utf8")); } catch { GEO_CACHE = {}; } }
  return GEO_CACHE!;
}
async function geocodeCH(q: string): Promise<LatLon | null> {
  const c = geoCache();
  if (q in c) return c[q];
  await new Promise((r) => setTimeout(r, 1100)); // Nominatim usage policy: max 1 req/sec
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ch&q=" + encodeURIComponent(q),
      { headers: { "User-Agent": "CK-route-planner/1.0 (alan@treshermanos.ch)" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const j = (await r.json()) as Array<{ lat: string; lon: string }>;
    c[q] = j.length ? [parseFloat(j[0].lat), parseFloat(j[0].lon)] : null;
  } catch {
    // A network error or rate limit is transient. Never poison the durable
    // cache with a permanent "not found" result unless Nominatim returned a
    // successful empty search.
    return null;
  }
  try { writeFileSync(GEO_CACHE_FILE, JSON.stringify(c)); } catch { /* best effort */ }
  return c[q];
}
function geocodeCacheHit(q: string): LatLon | null | undefined {
  return geoCache()[q];
}
function normalizedLocationText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
async function geocodeSwissLocality(postalCode: string, city: string): Promise<LatLon | null> {
  const query = `${postalCode} ${city}`.trim();
  const cacheKey = `geo-admin-locality:${query}`;
  const cached = geocodeCacheHit(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(
      "https://api3.geo.admin.ch/rest/services/api/SearchServer"
      + `?searchText=${encodeURIComponent(query)}&type=locations&limit=1&sr=4326`,
      { signal: AbortSignal.timeout(12_000) },
    );
    if (!response.ok) return null;
    const payload = await response.json() as {
      results?: Array<{ attrs?: { lat?: unknown; lon?: unknown; label?: unknown; detail?: unknown } }>;
    };
    const attrs = payload.results?.[0]?.attrs;
    const lat = Number(attrs?.lat);
    const lon = Number(attrs?.lon);
    const returned = normalizedLocationText(`${String(attrs?.label || "")} ${String(attrs?.detail || "")}`);
    const expectedCity = normalizedLocationText(city);
    const expectedPostal = normalizedLocationText(postalCode);
    const identityMatches = expectedCity.length >= 2
      && returned.includes(expectedCity)
      && (!expectedPostal || returned.includes(expectedPostal));
    const coordinates: LatLon | null = identityMatches && Number.isFinite(lat) && Number.isFinite(lon)
      ? [lat, lon]
      : null;
    geoCache()[cacheKey] = coordinates;
    try { writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoCache())); } catch { /* best effort */ }
    return coordinates;
  } catch {
    return null;
  }
}
function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371, dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
const CANTON_MAP: Record<string, string> = { solothurn: "SO", bern: "BE", berne: "BE", aargau: "AG", "basel-landschaft": "BL", baselland: "BL", jura: "JU", luzern: "LU", lucerne: "LU", "basel-stadt": "BS", "neuchâtel": "NE", neuenburg: "NE", fribourg: "FR", freiburg: "FR", "zürich": "ZH", zurich: "ZH" };
function normCanton(s: string): string { const t = String(s || "").trim().toLowerCase(); return CANTON_MAP[t] || t.toUpperCase().slice(0, 2); }
// Alan's real Tres Hermanos HTML signature (logo + contact block + QR, images hosted publicly on
// Infomaniak so they render in any client). Infomaniak's webmail signature is NOT applied to
// programmatic/SMTP sends, so espo_send_email sends HTML and appends this. Override via CK_TH_SIGNATURE_HTML.
const TH_SIGNATURE_HTML = process.env.CK_TH_SIGNATURE_HTML || `
<br><br>
<table style="border-collapse:collapse" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
<td style="width:150px;border-right:1px solid #999;padding:6px;vertical-align:top">
<a href="http://www.treshermanos.ch/"><img alt="Tres Hermanos Logo" src="https://workspace.storage.infomaniak.com/signature/e620f0798bb460e4fb7a6c12ee7ed8d2540eeb61" height="120" width="121" border="0" style="display:block"></a>
</td>
<td style="width:177px;padding:6px;vertical-align:top;font-family:Arial,sans-serif;color:#000;font-size:11pt">
<b>&nbsp;Alan Christopherson</b><br>
<b style="font-size:8pt">&nbsp;Tres Hermanos Cigars</b><br>
<a style="text-decoration:none;color:#000" href="https://maps.app.goo.gl/frndDjtFg4NitZxU6">Tres Hermanos SA, Av. du Theatre 7, 1005 Lausanne, Switzerland</a><br>
<a style="text-decoration:none;color:#000" href="tel:+41766827610">+41 76 682 76 10</a><br>
<a style="text-decoration:none;color:#0645ad" href="mailto:alan@treshermanos.ch">alan@treshermanos.ch</a><br>
<a style="text-decoration:none;color:#000" href="http://www.treshermanos.ch/">http://www.treshermanos.ch</a>
</td>
<td style="width:150px;padding:6px;vertical-align:top;text-align:center;font-family:'Times New Roman',serif">
Scan me to save my contact<br>
<img alt="Scan to save Alan Christopherson's contact" src="https://divinocigars.ch/alan-contact-qr.png" height="130" width="130" border="0" style="display:block;margin:6px auto 0">
</td>
</tr></tbody></table>`;
function htmlBody(plain: string): string {
  const esc = String(plain || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:11pt;color:#212121">${esc.replace(/\n/g, "<br>")}</div>${TH_SIGNATURE_HTML}`;
}

export interface LinkedPendingSend {
  account_id?: unknown;
  to_email?: unknown;
  subject?: unknown;
  body?: unknown;
  in_reply_to?: unknown;
}

export function resolveApprovedSendContent(
  params: { to?: string; subject?: string; body?: string; account_id?: string },
  payload: Record<string, unknown>,
  linkedPending?: LinkedPendingSend | null,
): { to: string; subject: string; body: string; accountId: string } {
  // queue_email_for_approval binds the editable outbox row to the task card.
  // That row is authoritative: it contains the exact current copy, including
  // any edits Alan made in Outreach outbox after the card was created.
  if (linkedPending) {
    return {
      to: String(linkedPending.to_email || "").trim().toLowerCase(),
      subject: String(linkedPending.subject || "").trim(),
      body: String(linkedPending.body || "").trim(),
      accountId: String(linkedPending.account_id || "").trim(),
    };
  }

  const details = String(payload.detailsMarkdown || payload.prompt || "");
  const parseField = (labels: string[]): string => {
    for (const label of labels) {
      const match = details.match(
        new RegExp(`(?:\\*\\*)?${label}\\s*:(?:\\*\\*)?\\s*([^\\n]+)`, "i"),
      );
      if (match) return match[1].trim().replace(/[<>]/g, "").replace(/\s*<[^>]+>\s*$/, "").trim();
    }
    return "";
  };
  const emailIn = (value: string): string => {
    const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0].toLowerCase() : value.trim().toLowerCase();
  };

  let to = String(params.to || "").trim();
  let subject = String(params.subject || "").trim();
  let body = String(params.body || "").trim();
  if (!to) to = emailIn(parseField(["To", "An", "Recipient"]));
  if (!subject) subject = parseField(["Subject", "Betreff"]).replace(/^Re:\s*/i, "Re: ");
  if (!body) {
    const afterSeparator = details.split(/\n---\n/).slice(1).join("\n---\n").trim();
    const afterBodyLabel = details.match(/(?:^|\n)Body:\s*\n?([\s\S]+)/i);
    const afterHeaderBlock = details.match(
      /(?:^|\n)(?:\*\*)?(?:Subject|Betreff)\s*:(?:\*\*)?[^\n]+\n\s*\n([\s\S]+)/i,
    );
    body = (
      afterSeparator
      || afterBodyLabel?.[1]
      || afterHeaderBlock?.[1]
      || ""
    ).trim();
  }
  return {
    to,
    subject,
    body,
    accountId: String(params.account_id || "").trim(),
  };
}
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const BAD = ["sentry", "wixpress", "example.", "@2x", ".png", ".jpg", ".gif", "domain.com", "noreply", "no-reply", "googlemail", "schema.org", "polyfill", ".webp", ".svg"];
// registrable-domain -> emails seen on THAT site (module-level: persists across tool calls in the worker)
const fetchedByDomain = new Map<string, Set<string>>();

function regDomain(u: string): string {
  const h = String(u || "").replace(/^https?:\/\//, "").split("/")[0].toLowerCase().replace(/^www\./, "");
  const p = h.split(".");
  return p.length >= 2 ? p.slice(-2).join(".") : h;
}

interface EspoEmailAddressData {
  emailAddress: string;
  lower?: string;
  primary?: boolean;
  optOut?: boolean;
  invalid?: boolean;
}

export function mergeEmailAddressData(
  currentPrimary: unknown,
  currentData: unknown,
  newEmail: string,
): { emailAddress: string; emailAddressData: EspoEmailAddressData[]; alreadyPresent: boolean } {
  const normalized = String(newEmail || "").trim().toLowerCase();
  const rows = Array.isArray(currentData)
    ? currentData
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
        .map((row) => ({
          emailAddress: String(row.emailAddress || row.lower || "").trim().toLowerCase(),
          lower: String(row.lower || row.emailAddress || "").trim().toLowerCase(),
          primary: row.primary === true,
          optOut: row.optOut === true,
          invalid: row.invalid === true,
        }))
        .filter((row) => row.emailAddress)
    : [];
  const primary = String(currentPrimary || rows.find((row) => row.primary)?.emailAddress || normalized)
    .trim()
    .toLowerCase();
  if (primary && !rows.some((row) => row.emailAddress === primary)) {
    rows.unshift({ emailAddress: primary, lower: primary, primary: true, optOut: false, invalid: false });
  }
  const alreadyPresent = rows.some((row) => row.emailAddress === normalized);
  if (!alreadyPresent) {
    rows.push({
      emailAddress: normalized,
      lower: normalized,
      primary: rows.length === 0,
      optOut: false,
      invalid: false,
    });
  }
  const chosenPrimary = primary || normalized;
  return {
    emailAddress: chosenPrimary,
    emailAddressData: rows.map((row) => ({ ...row, primary: row.emailAddress === chosenPrimary })),
    alreadyPresent,
  };
}

export function verifyInboundEmailEvidence(
  evidence: Record<string, unknown>,
  accountId: string,
  expectedEmail: string,
): { ok: true } | { ok: false; error: string } {
  const from = String(evidence.fromAddress || evidence.from || evidence.fromString || "")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    ?.toLowerCase() || "";
  if (from !== expectedEmail.toLowerCase()) {
    return { ok: false, error: `evidence sender '${from || "unknown"}' does not match '${expectedEmail}'` };
  }
  if (String(evidence.parentType || "") !== "Account" || String(evidence.parentId || "") !== accountId) {
    return { ok: false, error: "evidence email is not parented to this Account" };
  }
  if (["Draft", "Sending", "Sent"].includes(String(evidence.status || ""))) {
    return { ok: false, error: `evidence status '${String(evidence.status)}' is not inbound` };
  }
  return { ok: true };
}
// Normalize a company name for dedup: lowercase, drop legal suffixes + punctuation, collapse spaces.
// "Tabac-Trends AG" and "tabac trends" normalize to the same key.
function normName(s: string): string {
  return String(s || "").toLowerCase()
    .replace(/\b(ag|gmbh|sa|s[aà]rl|sagl|ltd|inc|holding|group|co|kg|snc|schweiz|suisse|svizzera|switzerland)\b/g, " ")
    .replace(/[^a-z0-9äöü]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
// Extract a canonical Swiss UID (CHE-number) from any string. "" if none.
function extractUid(s: string): string {
  const m = String(s || "").match(/CHE[-\s]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})/i);
  return m ? `CHE-${m[1]}.${m[2]}.${m[3]}` : "";
}
function extractEmails(html: string): string[] {
  const out: string[] = [];
  for (const m of html.match(EMAIL_RE) || []) {
    const e = m.toLowerCase().replace(/\.$/, "");
    if (BAD.some((b) => e.includes(b))) continue;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}
async function webFetch(rawUrl: string): Promise<{ url: string; emails: string[]; via: string; note: string }> {
  let base = String(rawUrl || "").trim();
  if (!/^https?:/.test(base)) base = "https://" + base;
  base = base.replace(/\/+$/, "");
  const found = new Set<string>();
  for (const p of ["", "/kontakt", "/impressum", "/contact", "/kontakt/"]) {
    try {
      const r = await fetch(base + p, { headers: { "User-Agent": "Mozilla/5.0 (CK Contact-Finder)" }, signal: AbortSignal.timeout(8000) });
      if (r.ok) for (const e of extractEmails((await r.text()).slice(0, 400000))) found.add(e);
    } catch { /* timeout/unreachable */ }
    if (found.size && p !== "") break;
  }
  let via = "plain";
  if (!found.size) { // stealth fallback: camofox + phone residential IP (renders JS, decodes Cloudflare)
    try {
      const r = await fetch(`${STEALTH_URL}/fetch?url=${encodeURIComponent(base)}`, { signal: AbortSignal.timeout(130000) });
      if (r.ok) { const j = (await r.json()) as { emails?: string[] }; for (const e of j.emails || []) found.add(e); via = "camofox+phone"; }
    } catch { /* stealth bridge down */ }
  }
  const dom = regDomain(base);
  if (found.size) { if (!fetchedByDomain.has(dom)) fetchedByDomain.set(dom, new Set()); for (const e of found) fetchedByDomain.get(dom)!.add(e); }
  return { url: base, emails: [...found], via, note: found.size ? `found ${found.size} (${via})` : "no email (plain + camofox/phone + CF-decode) — skip, do not guess" };
}

// browser_act — the general "do anything a person can do in a browser" surface. Proxies to the
// stealth service's /browser endpoint, which drives the SAME Camofox stealth Firefox on a Swiss
// residential IP. Tabs persist by tabId across calls, so a multi-step flow is a sequence of tool
// calls: open -> snapshot (see refs) -> click/type by ref -> snapshot again -> ... -> close.
const BROWSER_ACTIONS = ["open", "navigate", "snapshot", "click", "type", "press", "scroll", "evaluate", "links", "screenshot", "allow_dialogs", "close"] as const;
async function browserAct(params: Record<string, unknown>): Promise<{ content: string; data?: unknown }> {
  const action = String(params.action || "");
  if (!BROWSER_ACTIONS.includes(action as (typeof BROWSER_ACTIONS)[number])) {
    return { content: JSON.stringify({ error: `action must be one of: ${BROWSER_ACTIONS.join(", ")}` }) };
  }
  // screenshots can be large; keep the timeout generous for real pages behind the residential proxy
  const timeoutMs = action === "open" || action === "navigate" ? 140000 : 90000;
  try {
    const r = await fetch(`${STEALTH_URL}/browser`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) return { content: JSON.stringify({ error: j.error || `browser bridge ${r.status}` }) };
    // Never dump a full base64 screenshot into the model transcript — summarize, keep the data payload.
    if (action === "screenshot") {
      return { content: JSON.stringify({ ok: true, action, bytes: j.bytes, note: "screenshot captured (base64 in data.screenshotBase64)" }), data: j };
    }
    return { content: JSON.stringify({ ok: true, action, ...j }), data: j };
  } catch (e) {
    return { content: JSON.stringify({ error: `browser bridge unreachable: ${String(e).slice(0, 160)} — is the phone online as Tailscale exit node?` }) };
  }
}

// web_search: DuckDuckGo HTML endpoint (no JS, no API key). Returns real result links for the ~58
// website-less venues so the agent can then feed a URL into web_fetch. DDG wraps hrefs in a
// /l/?uddg= redirect — decode it back to the real URL. Never invents; returns [] on block/empty.
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
function decodeDdg(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith("//") ? "https:" + href : href;
}
function parseDdgHtml(html: string, limit: number): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    const url = decodeDdg(m[1]);
    const title = stripTags(m[2]);
    if (url && title && !out.some((o) => o.url === url)) out.push({ title, url });
  }
  return out;
}
// Brave HTML search — unlike DDG/Mojeek/Ecosia, Brave serves results to DATACENTER IPs (no key, no
// proxy). This is what lets search work from the Hetzner box without the phone exit node.
// torproject/tb-manual = the sidebar link Brave's JS-shell serves when it RATE-LIMITS (429) a
// datacenter IP; without filtering it we'd emit that as a fake "result" (bug caught on the Divino
// side 2026-07-05). Filtering it means a rate-limited response yields [] and falls through to the
// stealth/DDG fallback instead of lying.
const BRAVE_SKIP = ["brave.com", "search.brave", "torproject.org", "tb-manual", "/settings", "javascript:", "imgs.", "cdn.", "gstatic", "google.com", "/videos", "/images", "/news", "youtube.com/redirect"];
function parseBraveHtml(html: string, limit: number): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html)) && out.length < limit) {
    const url = m[1];
    if (BRAVE_SKIP.some((b) => url.includes(b))) continue;
    const key = url.split("#")[0];
    if (seen.has(key)) continue;
    let title = stripTags(m[2]);
    // Brave prepends a breadcrumb ("Storchen storchen.ch › en › ...") — keep the leading site name.
    title = title.split(/\s+›\s+|\s+»\s+/)[0].trim();
    if (title.length < 3) continue;
    seen.add(key);
    out.push({ title: title.slice(0, 120), url });
  }
  return out;
}
async function braveSearch(q: string, limit: number): Promise<Array<{ title: string; url: string }>> {
  // Reliable path: the official Brave Search API (free 2000/mo) is NOT per-IP rate-limited like the
  // HTML endpoint. Set CK_BRAVE_API_KEY (or /work/.brave-api.key) to use it. Falls back to HTML scrape when no key.
  const key = readBraveKey();
  if (key) {
    try {
      const r = await fetch("https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(q) + "&count=" + limit, {
        headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        const j = (await r.json()) as { web?: { results?: Array<{ title?: string; url: string }> } };
        return (j.web?.results || []).slice(0, limit).map((x) => ({ title: (x.title || "").slice(0, 120), url: x.url }));
      }
    } catch { /* fall through to scrape */ }
  }
  const r = await fetch("https://search.brave.com/search?q=" + encodeURIComponent(q) + "&source=web", {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(14000),
  });
  if (!r.ok) return [];   // 429/rate-limited -> [] -> webSearch falls back to stealth bridge / DDG
  return parseBraveHtml((await r.text()).slice(0, 800000), limit);
}
async function webSearch(query: string, limit: number): Promise<{ query: string; results: Array<{ title: string; url: string }>; via: string; note: string }> {
  const q = String(query || "").trim();
  if (!q) return { query: q, results: [], via: "none", note: "empty query" };
  // PRIMARY: Brave HTML — serves datacenter IPs, so this works from the Hetzner box with NO phone
  // exit node, NO key, NO proxy. This is the free path that removed the single-phone dependency for search.
  try {
    const res = await braveSearch(q, limit);
    if (res.length) return { query: q, results: res, via: "brave", note: `${res.length} results` };
  } catch { /* brave down — try the residential bridge */ }
  // FALLBACK 1: residential-IP stealth bridge (phone exit node), if it's up — covers the rare case Brave blocks
  try {
    const r = await fetch(`${STEALTH_URL}/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: AbortSignal.timeout(70000) });
    if (r.ok) {
      const j = (await r.json()) as { results?: Array<{ title: string; url: string }> };
      const res = (j.results || []).slice(0, limit);
      if (res.length) return { query: q, results: res, via: "camofox+phone", note: `${res.length} results (brave empty)` };
    }
  } catch { /* bridge down — try plain DDG */ }
  // FALLBACK 2: plain DDG (only yields results if this host itself has a residential IP)
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36" },
      signal: AbortSignal.timeout(12000),
    });
    const res = parseDdgHtml((await r.text()).slice(0, 600000), limit);
    return { query: q, results: res, via: "plain", note: res.length ? `${res.length} results` : "no results (brave + bridge + plain all empty)" };
  } catch (e) {
    return { query: q, results: [], via: "error", note: `search failed: ${String(e).slice(0, 140)}` };
  }
}

// EVALUATION GATE (deterministic) — CK's differentiator as CODE, not an LLM. Catches the mechanically
// checkable disclosure/quality violations before any draft reaches a human. Determinism-first: the hard
// rules are enforced, never trusted to the model.

// Canonical single-stick/box CHF prices — the machine-readable mirror of the th-product-facts skill
// (v4). Used by the gate to catch INVENTED prices: any CHF amount in a non-first-contact draft that is
// not in this set is flagged. Keep in sync when the skill's price list changes.
const KNOWN_PRICES_CHF = new Set([
  14, 15, 16, 18, 19, 22, 23, 24, 28, 29.9, 32, 69, 75, 78, 80, 100, 127, 132, 154, 180, 205, 240, 264, 312, 348, 495,
  1, 2, 3, 4, 5, 6, 7, 8, 30, 40, // lighters/cutters ranges
]);

function extractChfAmounts(t: string): number[] {
  const out: number[] = [];
  const re = /(?:CHF|Fr\.)\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:CHF|Franken)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) out.push(Number((m[1] || m[2]).replace(",", ".")));
  return out;
}

export interface CrossVenueAccount {
  id: string;
  name?: string;
  type?: string;
}

function isApprovedFirstContactReference(name: string): boolean {
  const normalized = String(name || "").toLocaleLowerCase("de-CH");
  return normalized.includes("bürgenstock")
    || normalized.includes("suvretta house")
    || normalized.includes("schweizerhof bern");
}

export function crossVenueNames(accounts: CrossVenueAccount[], targetAccountId: string): string[] {
  return accounts
    .filter((account) => String(account.id) !== String(targetAccountId))
    .filter((account) => !/^(partner|supplier|vendor)$/i.test(String(account.type || "").trim()))
    .map((account) => String(account.name || "").trim())
    .filter(Boolean);
}

export function reviewDraft(
  text: string,
  context: string,
  opts: { venueName?: string; otherVenueNames?: string[] } = {},
): { pass: boolean; violations: string[]; checks: number } {
  const t = String(text || "");
  const v: string[] = [];
  if (/CK\s*IT\s*Solutions/i.test(t)) v.push("Reveals internal identity 'CK IT Solutions' — forbidden outward (seller face is Tres Hermanos).");
  if (/ß/.test(t)) v.push("Contains 'ß' — Swiss German must use 'ss'.");
  if (/\b(?:Gruezi|Gruesse|fuer|Praesent\w*|wuensch\w*|moechte\w*|koenn\w*)\b/i.test(t))
    v.push("Uses ASCII substitutions such as 'fuer' or 'Gruezi' — write normal German umlauts (für, Grüezi, Grüsse, Präsentation). Only ß becomes ss in Swiss German.");
  if (/\bAlan\b/i.test(t) && !/\bAlan\s+Christopherson\b/i.test(t))
    v.push("Incorrect sender name — outward mail signed by Alan must use 'Alan Christopherson'.");
  if (
    context === "first_contact"
    && !/\bAlan\s+Christopherson\s*\n\s*Tres\s+Hermanos\s*$/i.test(t.trim())
  )
    v.push("Incomplete outward signature — end with the exact two lines 'Alan Christopherson' and 'Tres Hermanos'.");
  if (/\bCanonazo\b/i.test(t))
    v.push("Misspells Cañonazo as 'Canonazo' — preserve the verified product name 'Cañonazo'.");
  // Anti-AI-tell (owner rule): NEVER em/en dashes, never connective/suspended hyphens — they read as
  // machine-written. Enforced here (not just in instructions) so no draft can pass with them.
  if (/[‒–—―−]/.test(t))
    v.push("Contains an em/en dash (— or –) — FORBIDDEN in outreach: it reads as AI-written. Use a comma, a period, or reword (owner rule).");
  if (/\s-\s/.test(t))
    v.push("Contains a spaced hyphen used as a separator — FORBIDDEN in outreach. Use a colon, comma, period, or reword.");
  {
    // suspended ('Fumoir- und ...') or compound ('Zigarren-Lounge', 'cremig-milde') hyphens; allow a
    // tiny set of genuinely-hyphenated terms. Fix = close the compound (Zigarrenlounge) or reword.
    const scrubbed = t.replace(/\b(E-Mail|E-Mails|Make-up|Know-how|Boutique-Fabrik|Center-|Café-)\b/gi, " ");
    const hy = scrubbed.match(/[A-Za-zÀ-ÿ]+-(?:\s|[A-Za-zÀ-ÿ])/g);
    if (hy) v.push(`Contains connective/suspended hyphen(s) (e.g. ${[...new Set(hy)].slice(0, 3).map((s) => s.trim() + "…").join(", ")}) — FORBIDDEN: close the compound (e.g. 'Zigarrenlounge') or reword. Hyphenated compounds read as AI-written (owner rule).`);
  }
  if (/\b(wir\s+bestellen\s+(bei|über)|bestellen\s+wir\s+(bei|über)\s+Tres\s+Hermanos|Versand\s+(erfolgt\s+)?über|im\s+Auftrag\s+von|liefern\s+lassen|beziehen\s+wir\s+(bei|über))\b/i.test(t))
    v.push("Discloses the order relay / invoicing chain — forbidden (the TH relationship is not shown outward).");
  if ((context === "first_contact" || context === "") && /\b(IBAN|Kontonummer|Bankverbindung|CH\d{2}[\s\d]{6,})\b/i.test(t))
    v.push("Contains bank/payment details — never in first contact, only after a confirmed order.");
  if (/[äöü]/i.test(t) && /\b(Equateur|République|nous|votre|bonjour)\b/.test(t))
    v.push("French-language leakage in a German text (language purity).");
  if (
    /\b(?:Bonjour|Madame|Monsieur|votre|République|cordialement)\b/i.test(t)
    && /\bcigars\b/i.test(t)
  ) {
    v.push("English word 'cigars' leaked into French prose — write 'cigares'.");
  }
  if (
    /\b(?:Sehr geehrte|Guten Tag|Grüezi|Freundliche Grüsse|Zigarren|Sortiment)\b/i.test(t)
    && /\b(?:full|medium)\b/i.test(t)
  ) {
    v.push("English strength term 'full' or 'medium' leaked into German prose — write 'voll', 'kräftig', 'vollmundig', or 'mittelkräftig'.");
  }
  if (
    /\b(?:Sehr geehrte|Guten Tag|Grüezi|Freundliche Grüsse|Zigarren|Sortiment)\b/i.test(t)
    && /\bBlend\b/i.test(t)
  ) {
    v.push("English product jargon 'Blend' leaked into German prose — use a natural German description or omit it.");
  }
  if (
    /\b(?:Sehr geehrte|Guten Tag|Grüezi|Freundliche Grüsse|Zigarren|Sortiment)\b/i.test(t)
    && /\bprime\b/i.test(t)
  ) {
    v.push("English adjective 'prime' leaked into German prose — omit it or use a natural, sourced German description.");
  }
  if (/\bNo\.\s*6\s+Big\s+Hermano\b/i.test(t)) {
    v.push("Misspells the verified format 'N°6 Big Hermano' as 'No. 6 Big Hermano' — preserve the canonical product name.");
  }
  if (/\b(?:der|die)\s+Gasthaus\b/i.test(t)) {
    v.push("Uses the wrong German article for 'Gasthaus' — write 'das Gasthaus' (or reword around the proper venue name).");
  }
  if (/\b(?:Gäste|Auswahl|Zusammenstellung|Formate|Zigarren)\s+(?:die|der|das)\b/i.test(t)) {
    v.push("Missing comma before a German relative clause (for example 'Gäste, die' or 'Zusammenstellung, die').");
  }
  if (/\beinem\s+(?:mittelkräftigen\s+)?Favorit\b/i.test(t)) {
    v.push("Uses the wrong German weak-noun ending — write 'einem ... Favoriten', not 'einem ... Favorit'.");
  }
  if (
    context === "first_contact"
    && /\b(?:Ich\s+wende\s+mich(?:\s+heute)?\s+an\s+Sie|Ich\s+möchte\s+Ihnen[\s\S]{0,80}\bvorstellen)\b/i.test(t)
  ) {
    v.push("Uses a generic sender-centred opener ('Ich wende mich an Sie' / 'Ich möchte Ihnen ... vorstellen') — Alan rejected this tone. Introduce Alan normally, then move to one purpose or question shaped by the dossier.");
  }
  if (
    context === "first_contact"
    && /\b(?:Sie\s+führen|Sie\s+betreiben|Ihr(?:e|er|es)?\s+Hotel\s+(?:bietet|verfügt))\b/i.test(t)
  ) {
    v.push("Narrates the recipient's own business or facilities back to them ('Sie führen ...' / 'Ihr Hotel bietet ...') — this sounds like CRM fields converted into prose. Let the dossier shape one natural purpose or question instead.");
  }
  if (
    context === "first_contact"
    && /\b(?:ist|sind)\s+mir(?:\s+als[\s\S]{0,120}?)?\s+(?:bekannt|aufgefallen)\b/i.test(t)
  ) {
    v.push("Uses a researched-observation formula ('ist mir ... bekannt/aufgefallen') — this still narrates the dossier instead of giving a natural reason for writing. Omit it and move from the sender introduction to the purpose.");
  }
  if (
    context === "first_contact"
    && /\bIch\s+denke\s*,?\s+Tres\s+Hermanos\s+könnte\s+für\s+Ihre\s+Gäste\s+interessant\s+sein\b/i.test(t)
  ) {
    v.push("Assumes that Tres Hermanos will interest the recipient's guests — do not speculate about guest demand. Ask the venue one direct, low-pressure question instead.");
  }
  if (
    context === "first_contact"
    && /\b(?:Ihr(?:e|er|en|em|es)?|unser(?:e|er|en|em|es)?)\s+The\s+Council\s+Lounge\b/i.test(t)
  ) {
    v.push("Uses an ungrammatical possessive before the branded venue name ('Ihrer The Council Lounge') — write a natural construction such as 'in der Lounge The Council'.");
  }
  if (
    context === "first_contact"
    && /\bHandgerollte\s+Premiumzigarren\s*,\s*von\s+mild\s+bis\s+kräftig\s*\./i.test(t)
  ) {
    v.push("Uses a catalogue-like sentence fragment ('Handgerollte Premiumzigarren, von mild bis kräftig.') — remove it; first contact needs a purpose, not product-range filler.");
  }
  if (
    context === "first_contact"
    && /\b(?:kennerischst\w*|jeden\s+Anspruch|für\s+jeden\s+Gast|passt[\s\S]{0,60}\bideal\b|\bperfekt(?:e|en|er|es)?\b)\b/i.test(t)
  ) {
    v.push("Uses inflated or absolute-fit marketing language in first contact — describe the sourced fit plainly and let the prospect decide.");
  }
  if (
    context === "first_contact"
    && /\b(?:Da\s+liegt\s+eine\s+gute\s+Zigarre\s+nah|das\s+Passende(?:\s+zu\s+finden)?|echte\s+Ergänzung|Neugier\s+wecken|Gespräche\s+einleiten|verdient\s+ein\s+Angebot|passt\s+ausgezeichnet|kommt\s+bei\s+Gästen[\s\S]{0,30}gut\s+an)\b/i.test(t)
  ) {
    v.push("Uses polished, synthetic sales-copy phrasing that does not sound like Alan — state the sourced fact plainly and ask one direct question.");
  }
  if (context === "first_contact") {
    const formatNames = [
      ...t.matchAll(/\b(?:Cañonazo|Gordito|Robusto|Lonsdale|Piramide|Salomon|Big\s+Hermano|El\s+Caimán)\b/gi),
    ].map((match) => match[0].toLowerCase());
    if (new Set(formatNames).size > 1) {
      v.push("Lists multiple cigar formats in a first contact — this reads like a catalogue. Name at most one format, and only when the dossier gives a clear reason.");
    }
  }
  if (
    /\bLigne(?:\s+classique)?\b/i.test(t)
    && /\b(?:Sehr geehrte|Guten Tag|Grüezi|Freundliche Grüsse|Zigarren|Sortiment)\b/i.test(t)
  ) {
    v.push("French product-line wording 'Ligne classique' leaked into German prose — write 'klassische Linie' or omit the line name.");
  }
  // Owner-corrected company identity (2026-07-19): Tres Hermanos is Swiss.
  // The cigars are made in its own factory in the Dominican Republic. Do not
  // collapse production origin into company nationality.
  if (
    /\b(?:dominikanisch(?:e|en|er|es)?\s+(?:Firma|Unternehmen|Haus|Marke|Manufaktur)|maison\s+dominicaine|entreprise\s+dominicaine|soci[ée]t[ée]\s+dominicaine|Dominican\s+(?:company|house|brand|manufacturer))\b/i.test(t)
  ) {
    v.push("Misstates Tres Hermanos as a Dominican company/house/brand — Tres Hermanos is a Swiss company with its own cigar-production factory in the Dominican Republic (owner-corrected fact, 2026-07-19).");
  }
  // Anti-hallucination: prices. First contact carries NO prices at all (policy); later drafts may only
  // quote prices that exist in the canonical table — an unknown number is an invented number.
  const amounts = extractChfAmounts(t);
  if (context === "first_contact" && amounts.length)
    v.push(`Contains price(s) (CHF ${amounts.join(", ")}) — no prices in first contact (policy).`);
  if (
    context === "first_contact"
    && /\b(?:Konditionen|Rabatte?|Marge|Mindestbestell(?:menge|wert)|Zahlungsziel|wir\s+liefern|Liefermöglichkeit(?:en)?|direkte?\s+Lieferung)\b/i.test(t)
  ) {
    v.push("Introduces commercial terms or conditions in first contact — establish interest first; discuss conditions only after the prospect engages.");
  }
  if (context !== "first_contact") {
    const unknown = amounts.filter((a) => !KNOWN_PRICES_CHF.has(a));
    if (unknown.length)
      v.push(`Price(s) CHF ${unknown.join(", ")} not in the canonical price table (th-product-facts) — invented or outdated; use only listed prices.`);
  }
  // First contact may ask whether a conversation or visit is interesting, but
  // it must not commit Alan to a specific weekday/date. A concrete slot needs
  // calendar evidence and belongs in the meeting-booking/reply workflow.
  if (
    context === "first_contact" &&
    (
      /\b(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b/i.test(t) ||
      /\b\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?\b/.test(t)
    ) &&
    /\b(ich|wir)\b[\s\S]{0,120}\b(unterwegs|vor\s+Ort|verfügbar|Zeit|komme|kommen|vorbei(?:kommen|schauen)?|kann|könnte|können|wäre|wären)\b/i.test(t)
  ) {
    v.push("Makes a specific weekday/date availability or travel commitment in first contact without calendar evidence — ask generally whether a conversation or visit is interesting; concrete slots belong in the meeting-booking workflow.");
  }
  if (
    context === "first_contact"
    && /\b(?:ich\s+komme|wir\s+kommen)\b[\s\S]{0,60}\b(?:persönlich\s+)?vorbei\b/i.test(t)
  ) {
    v.push("Commits to an in-person visit in first contact — ask whether a presentation or visit is of interest; schedule only after the prospect agrees.");
  }
  if (
    context === "first_contact"
    && (
      /\b(?:Musterpaket|Probierpaket|Mustersendung)\b/i.test(t)
      ||
      /\b(?:envoyer|faire\s+parvenir|expédier)\b[\s\S]{0,80}(?:échantillon|échantillons)/i.test(t)
      || /\b(?:Muster|Probe|Probierpaket)\b[\s\S]{0,80}\b(?:send(?:e|en|et|est)|schick(?:e|en|t|st)|zustell(?:e|en|t|st))\b/i.test(t)
      || /\b(?:send(?:e|en|et|est)|schick(?:e|en|t|st)|zustell(?:e|en|t|st))\b[\s\S]{0,80}\b(?:Muster|Probe|Probierpaket)\b/i.test(t)
      || /\b(?:send|ship|deliver)\b[\s\S]{0,80}\b(?:sample|samples)\b/i.test(t)
      || /\b(?:sample|samples)\b[\s\S]{0,80}\b(?:send|ship|deliver)\b/i.test(t)
      || /\b(?:Kollektion|Sortiment|Zigarren|Produkte|Auswahl)\b[\s\S]{0,80}\b(?:send(?:e|en|et|est)|schick(?:e|en|t|st)|zustell(?:e|en|t|st)|vorbeibringen|mitbringen|bringen)\b/i.test(t)
      || /\b(?:send(?:e|en|et|est)|schick(?:e|en|t|st)|zustell(?:e|en|t|st)|vorbeibringen|mitbringen|bringen)\b[\s\S]{0,80}\b(?:Kollektion|Sortiment|Zigarren|Produkte|Auswahl)\b/i.test(t)
    )
  ) {
    v.push("Promises to send samples or goods in first contact — the owner-approved Muster may offer a few samples during a requested presentation, but must not commit a package, shipment, delivery, or inventory before agreement.");
  }
  // Anti-mixing: cross-PRODUCT contamination. Owner-corrected 2026-07-02: Bordas makes ONLY Rum Don
  // Isidro — any Bordas mention in text that isn't about that rum is the "Manufaktur Bordas" failure
  // (a cigar draft borrowing the rum maker's heritage).
  if (/Bordas/i.test(t) && !/Don\s+Isidro|Rum/i.test(t))
    v.push("Mentions 'Bordas' outside a Rum Don Isidro context — Bordas makes ONLY the rum, never the cigars/brand (owner-corrected fact, th-product-facts v5).");
  // Anti-misrepresentation: NEVER describe TH tobacco/wrapper/leaf origin or construction (owner rule
  // 2026-07-06). Naming one leaf (e.g. "Habano wrapper from Ecuador") wrongly implies the WHOLE range
  // uses only that tobacco. Format names + strength are fine; leaf/wrapper/origin/construction is not.
  if (/\b(Habanos?|Ecuadors?|Ecuadorian|ecuadorianisch\w*|Équateur|Equateur|Deckbl[aä]tt\w*|Umbl[aä]tt\w*|Cameroun|Cameroon)\b/i.test(t))
    v.push("Describes TH tobacco/wrapper/leaf origin or construction (e.g. 'Habano', 'Ecuador', 'Deckblatt') — FORBIDDEN: it misrepresents the range as using only that leaf. Say only: hand-rolled, from the Dominican Republic, own production, strength range mild→full. OMIT all construction/leaf detail (owner rule 2026-07-06, th-product-facts v6).");
  // Anti-mixing: a draft for venue X must not mention any OTHER venue from the CRM (the classic
  // cross-contamination failure). Only names ≥5 chars and not contained in the target venue's own
  // name are checked, to avoid false hits on generic words.
  if (opts.venueName && opts.otherVenueNames?.length) {
    const own = opts.venueName.toLowerCase();
    const leaked = opts.otherVenueNames.filter((n) => {
      const nn = String(n || "").trim();
      return nn.length >= 5
        && !isApprovedFirstContactReference(nn)
        && !own.includes(nn.toLowerCase())
        && t.toLowerCase().includes(nn.toLowerCase());
    });
    if (leaked.length)
      v.push(`Mentions other venue(s) from the CRM: ${leaked.slice(0, 3).join(", ")} — cross-venue information mixing; a draft may only reference its own venue.`);
  }
  return { pass: v.length === 0, violations: v, checks: 12 };
}

export function reviewOutreachMessage(
  subject: string,
  body: string,
  opts: { venueName?: string; otherVenueNames?: string[] } = {},
): { pass: boolean; violations: string[]; checks: number } {
  // Subject and body are one outward artifact. Checking only the body allowed
  // forbidden punctuation and mixed-language wording to escape in subject
  // lines even though the approval was labelled gate-passed.
  const result = reviewDraft(`${String(subject || "")}\n\n${String(body || "")}`, "first_contact", opts);
  if (
    !/^\s*(?:Sehr\s+geehrt(?:e|er)|Guten\s+Tag|Grüezi|Bonjour|Madame|Monsieur|Buongiorno|Gentil[ei]|Hello|Dear)\b/i.test(String(body || ""))
  ) {
    result.violations.push("Missing a professional greeting at the start of the first-contact body.");
    result.pass = false;
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = any;

// ── Deterministic address enrichment (search.ch directory + own-website) ──────────────────
// A TS port of ~/ck-hermes/tools/crm-address-enricher/enrich_web.py. KEEP THE GATES IN SYNC
// with that Python (it stays the CLI/cron path); both must NEVER write an unverified address.
// The whole point: an address is filled only when town + name identity agree — so a judgment
// agent gets "verified or nothing", it never free-types (and hallucinates) a street.
const ENRICH_UA = "divino-crm-enricher/1.0 (alan@treshermanos.ch)";
const STREET_TOKENS_RE = /strasse|str\.|gasse|platz|weg|allee|ring|quai|kai|route|rue|via|chemin|promenade|damm|hof|matte|steig|halde|rain|boulevard|avenue|piazza|contrada|zelg|graben|markt|bahnhof/i;
const ENRICH_GENERIC = new Set(["shop", "store", "bar", "restaurant", "cafe", "café", "grill", "bistro", "pub", "kiosk", "hotel", "club", "golf", "golfpark", "golfclub", "lounge", "cigar", "cigars", "zigarren", "tobacco", "tobaccos", "smoker", "smokers", "fumoir", "kitchen", "winebar", "restaurants", "boutique", "swiss"]);
const ENRICH_STOP = new Set(["the", "and", "und", "der", "die", "das", "les", "del", "de", "la", "le", "du", "des", "ag", "gmbh", "sa", "sarl", "sagl", "grand"]);
function eTok(s: string): Set<string> {
  return new Set((String(s || "").toLowerCase().match(/[a-zäöü0-9]+/g) || []).filter((t) => t.length > 2 && !ENRICH_STOP.has(t)));
}
function coreVenueName(name: string): string {
  let n = String(name || "").split(/[–—|·]| - | – /)[0];
  n = n.replace(/\b(cigar\s*lounge|zigarren\s*lounge|smoker'?s?\s*lounge|lounge|bar\s*&\s*lounge|humidor|cigar\s*club|cigarclub|club)\b/gi, "");
  n = n.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim().replace(/^[-–—|]+|[-–—|]+$/g, "").trim();
  return n || String(name || "");
}
function normTownE(s: string): string {
  let t = String(s || "").trim().replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+[A-Z]{2}$/, "").replace(/\s+\d+$/, "");
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}
// Identity gate: the directory/site entry must plausibly BE this account (not a neighbour sharing a
// generic word + the town). Matches must share a DISTINCTIVE token (not generic, not the city name);
// purely generic+town names (golf clubs) match only when near-identical; an entry carrying >=2
// distinctive tokens the account lacks is a different business -> reject.
function nameIdentityMatch(entryTitle: string, accountName: string, city: string): boolean {
  const c = eTok(city), a = eTok(coreVenueName(accountName)), b = eTok(entryTitle);
  if (!a.size || !b.size) return false;
  const da = new Set([...a].filter((t) => !ENRICH_GENERIC.has(t) && !c.has(t)));
  const db = new Set([...b].filter((t) => !ENRICH_GENERIC.has(t) && !c.has(t)));
  const shared = [...da].filter((t) => db.has(t));
  if (shared.length) return [...db].filter((t) => !da.has(t)).length < 2;
  if (!da.size && !db.size) return [...a].filter((t) => b.has(t)).length >= 2;
  return false;
}
function validStreetE(street: string, town: string): boolean {
  const s = String(street || "").trim();
  if (!s) return false;
  if (/\d/.test(s) && /[a-zäöü]/i.test(s)) return normTownE(s.replace(/\d/g, "")) !== normTownE(town);
  return STREET_TOKENS_RE.test(s);
}
type FoundAddr = { street: string; zip: string; town: string; src: string; ref: string };
// search.ch: Atom feed -> name-gate on the cheap title -> fetch <=3 vCards -> structured ADR, town-gated.
async function searchChAddress(name: string, city: string): Promise<FoundAddr | { err: string }> {
  const q = new URLSearchParams({ was: coreVenueName(name), wo: city, maxnum: "10" }).toString();
  let feed: string;
  try {
    const r = await fetch("https://tel.search.ch/api/?" + q, { headers: { "User-Agent": ENRICH_UA }, signal: AbortSignal.timeout(15000) });
    feed = await r.text();
  } catch { return { err: "searchch-no-response" }; }
  if (feed.includes("Too many requests")) return { err: "searchch-quota" };
  const entries = [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const title = (m[1].match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || "").replace(/\s+/g, " ").trim();
    const v = m[1].match(/(\/vcard\/[^"?]+\.vcf)\?key=([0-9a-f]+)/);
    return v ? { title, vcard: `https://tel.search.ch${v[1]}?key=${v[2]}` } : null;
  }).filter((e): e is { title: string; vcard: string } => !!e);
  const named = entries.filter((e) => nameIdentityMatch(e.title, name, city));
  if (!named.length) return { err: "searchch-no-name-match" };
  const cands: FoundAddr[] = [];
  for (const e of named.slice(0, 3)) {
    let vcf: string;
    try {
      const r = await fetch(e.vcard, { headers: { "User-Agent": ENRICH_UA }, signal: AbortSignal.timeout(12000) });
      vcf = await r.text();
    } catch { continue; }
    const m = vcf.match(/^ADR[^:]*:(.*)$/m);
    if (!m) continue;
    const parts = m[1].split(";").map((x) => x.replace(/\\,/g, ",").replace(/\\;/g, ";").trim());
    if (parts.length < 7) continue;
    const [street, cty, zip] = [parts[2], parts[3], parts[5]];
    if (normTownE(cty) !== normTownE(city)) continue;
    if (!validStreetE(street, cty)) continue;
    cands.push({ street, zip, town: cty, src: "search.ch", ref: e.title });
  }
  if (!cands.length) return { err: "searchch-no-confident-match" };
  if (new Set(cands.map((c) => c.street.toLowerCase().replace(/[^a-z0-9]/g, ""))).size > 1) return { err: "searchch-ambiguous" };
  return cands[0];
}
async function fetchTextE(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": ENRICH_UA }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 400000);
  } catch { return null; }
}
// own website: find a Swiss address block whose ZIP+town equals the account's known city.
function addressBlock(html: string, city: string): { street: string; zip: string; town: string } | null {
  const text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:CH-?\s*)?(\d{4})\s+([A-Za-zÄÖÜäöü][\wÄÖÜäöü .'\-]+)$/);
    if (!m || normTownE(m[2]) !== normTownE(city)) continue;
    for (let j = i - 1; j >= Math.max(i - 3, 0); j--) {
      const cand = lines[j].replace(/^[ ,]+|[ ,]+$/g, "");
      if (STREET_TOKENS_RE.test(cand) && /\d/.test(cand) && cand.length <= 48 && validStreetE(cand, m[2])) {
        return { street: cand, zip: m[1], town: m[2].trim() };
      }
    }
  }
  return null;
}
async function websiteAddress(website: string, city: string): Promise<FoundAddr | { err: string }> {
  let base = String(website || "").trim();
  if (!/^https?:/.test(base)) base = "https://" + base;
  base = base.replace(/\/+$/, "");
  const home = await fetchTextE(base);
  const pages: string[] = [];
  if (home) {
    const hit = addressBlock(home, city);
    if (hit) return { ...hit, src: "website", ref: base };
    for (const hm of home.matchAll(/href=["']([^"']+)["']/gi)) {
      if (/impressum|kontakt|contact|ueber-uns|about|anfahrt|standort/i.test(hm[1])) {
        const full = hm[1].startsWith("http") ? hm[1] : base + "/" + hm[1].replace(/^\//, "");
        if (!pages.includes(full)) pages.push(full);
      }
    }
  }
  for (const pg of pages.slice(0, 3)) {
    const h = await fetchTextE(pg);
    if (!h) continue;
    const hit = addressBlock(h, city);
    if (hit) return { ...hit, src: "website", ref: pg };
  }
  return { err: "website-no-address" };
}
// The one deterministic entry point: verified street (+ZIP) for an account, or a reason it couldn't.
async function verifiedAddress(name: string, city: string, website?: string): Promise<FoundAddr | { err: string }> {
  const s = await searchChAddress(name, city);
  if (!("err" in s)) return s;
  if (website && String(website).trim()) {
    const w = await websiteAddress(website, city);
    if (!("err" in w)) return w;
    return { err: `${s.err}; ${w.err}` };
  }
  return { err: s.err };
}

// ── DERIVE a missing city (+ often the whole address) deterministically ──────────────────────
// For accounts the finder left city-less: the gated address-fill can't run without a known town, so
// we DERIVE the town from a trustworthy source, never guess it. Two sources, own-site first:
//   1. the venue's OWN website — its stated Impressum/Kontakt address is authoritative for itself,
//      accepted ONLY when the site names a single, unambiguous Swiss town.
//   2. Zefix by name — accepted ONLY on a single active register match (no town to disambiguate).
// All Swiss ZIP+town lines on a page, WITHOUT needing to know the town in advance.
function addressBlocksAny(html: string): Array<{ street: string; zip: string; town: string }> {
  const text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: Array<{ street: string; zip: string; town: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:CH-?\s*)?(\d{4})\s+([A-Za-zÄÖÜäöü][\wÄÖÜäöü .'\-]{1,40})$/);
    if (!m) continue;
    const zip = m[1], town = m[2].trim();
    let street = "";
    for (let j = i - 1; j >= Math.max(i - 3, 0); j--) {
      const cand = lines[j].replace(/^[ ,]+|[ ,]+$/g, "");
      if (STREET_TOKENS_RE.test(cand) && /\d/.test(cand) && cand.length <= 48 && validStreetE(cand, town)) { street = cand; break; }
    }
    out.push({ street, zip, town });
  }
  return out;
}
async function ownSiteAddress(website: string): Promise<FoundAddr | { err: string }> {
  let base = String(website || "").trim();
  if (!base) return { err: "no-website" };
  if (!/^https?:/.test(base)) base = "https://" + base;
  base = base.replace(/\/+$/, "");
  const pages = [base];
  const home = await fetchTextE(base);
  const blocks: Array<{ street: string; zip: string; town: string }> = [];
  if (home) {
    blocks.push(...addressBlocksAny(home));
    for (const hm of home.matchAll(/href=["']([^"']+)["']/gi)) {
      if (/impressum|kontakt|contact|ueber-uns|about|anfahrt|standort/i.test(hm[1])) {
        const full = hm[1].startsWith("http") ? hm[1] : base + "/" + hm[1].replace(/^\//, "");
        if (!pages.includes(full)) pages.push(full);
      }
    }
  }
  for (const pg of pages.slice(1, 4)) {
    const h = await fetchTextE(pg);
    if (h) blocks.push(...addressBlocksAny(h));
  }
  if (!blocks.length) return { err: "ownsite-no-address" };
  // accept only if the site names ONE unambiguous town (a single venue's own address)
  const towns = new Set(blocks.map((b) => normTownE(b.town)));
  if (towns.size !== 1) return { err: "ownsite-ambiguous-town" };
  const withStreet = blocks.find((b) => b.street) || blocks[0];
  return { street: withStreet.street, zip: withStreet.zip, town: withStreet.town, src: "own-site", ref: base };
}
async function zefixByName(name: string): Promise<FoundAddr | { err: string }> {
  const search = async (q: string) => {
    try {
      const r = await fetch("https://www.zefix.ch/ZefixREST/api/v1/firm/search.json", {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (ck-office prospecting)" },
        body: JSON.stringify({ name: q, languageKey: "de", maxEntries: 10, offset: 0, activeOnly: true }), signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return null;
      return (((await r.json()) as { list?: Array<Record<string, unknown>> }).list) || [];
    } catch { return null; }
  };
  let cands = await search(name);
  if (cands && cands.length !== 1) {
    const stripped = name.replace(/\b(GmbH|AG|KLG|SNC|Sagl|S[aà]rl|SA|KG)\b.*$/i, "").trim();
    if (stripped && stripped.toLowerCase() !== name.toLowerCase()) { const c2 = await search(stripped); if (c2 && c2.length === 1) cands = c2; }
  }
  if (!cands || cands.length !== 1) return { err: cands && cands.length ? "zefix-ambiguous" : "zefix-no-hit" };
  const ehraid = Number(cands[0].ehraid);
  const town = String(cands[0].legalSeat || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!ehraid) return town ? { street: "", zip: "", town, src: "zefix", ref: String(cands[0].uidFormatted || "") } : { err: "zefix-no-ehraid" };
  try {
    const d = await fetch(`https://www.zefix.ch/ZefixREST/api/v1/firm/${ehraid}.json`, { headers: { "User-Agent": "Mozilla/5.0 (ck-office prospecting)" }, signal: AbortSignal.timeout(15000) });
    const addr = d.ok ? ((await d.json()) as { address?: { street?: string; houseNumber?: string; swissZipCode?: string; town?: string } }).address : undefined;
    if (addr) {
      const street = `${String(addr.street || "").trim()} ${String(addr.houseNumber || "").trim()}`.trim();
      const t = String(addr.town || town).trim();
      return { street: validStreetE(street, t) ? street : "", zip: String(addr.swissZipCode || "").trim(), town: t, src: "zefix", ref: String(cands[0].uidFormatted || "") };
    }
  } catch { /* fall through to seat-only */ }
  return { street: "", zip: "", town, src: "zefix", ref: String(cands[0].uidFormatted || "") };
}
// Derive a missing town (with any address the source gives) — own-site first, then Zefix.
async function deriveCity(name: string, website?: string): Promise<FoundAddr | { err: string }> {
  if (website && String(website).trim()) {
    const w = await ownSiteAddress(website);
    if (!("err" in w) && w.town) return w;
  }
  const z = await zefixByName(name);
  if (!("err" in z) && z.town) return z;
  return { err: "no-city-derivable" };
}

// ── Outbound approval queue (the "Outbox") ───────────────────────────────────────────────────
// Outreach drafts wait in ck_eval.pending_send for Alan to EDIT + Approve&Send in the Approvals panel.
// The send moves OFF the agent and onto the panel — that's what makes inline edit + learn-from-edits work.
// These helpers are module-level so BOTH the agent tool (queue) and the worker action (send) share them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EspoLike = any;
export interface VerifiedVenueRecipient {
  ok: true;
  name: string;
  to: string;
  contactNames: string[];
}
const CK_SEND_DNC: Array<{ m: RegExp; why: string }> = [
  { m: /suvretta/i, why: "Suvretta House is a direct Tres Hermanos client" },
  { m: /davidoff/i, why: "Davidoff is a producer/brand" },
  { m: /patoro/i, why: "Patoro is a producer" },
  { m: /zigarren\s*d(ü|ue?)rr/i, why: "Zigarren Dürr is Davidoff-brand retail" },
];
async function verifyVenueRecipient(espo: EspoLike, accountId: string, to: string): Promise<VerifiedVenueRecipient | { ok: false; error: string }> {
  const acct = await espo.get("Account", accountId);
  if (!acct || !acct.name) return { ok: false, error: "account_id not found" };
  const bad = CK_SEND_DNC.find((b) => b.m.test(`${acct.name} ${acct.website || ""}`));
  if (bad) return { ok: false, error: `DO_NOT_CONTACT: ${acct.name} — ${bad.why}` };
  const recipient = String(to).trim().toLowerCase();
  const known = new Set<string>();
  const contactNames: string[] = [];
  if (acct.emailAddress) known.add(String(acct.emailAddress).toLowerCase());
  try {
    const cs = await espo.related("Account", accountId, "contacts", 50);
    for (const c of cs.list || []) {
      if (!c.emailAddress) continue;
      const email = String(c.emailAddress).trim().toLowerCase();
      known.add(email);
      if (email === recipient) {
        const contactName = String(c.name || `${c.firstName || ""} ${c.lastName || ""}`).trim();
        if (contactName) contactNames.push(contactName);
      }
    }
  } catch { /* no contacts relation */ }
  // Some Espo versions omit virtual emailAddress fields from the Account relationship response even
  // though the Contact and account_contact link are valid. Query Contacts by accountId as the
  // authoritative fallback so a real inbound sender is not rejected after being registered.
  try {
    const cs = await espo.list("Contact", {
      where: [{ type: "equals", attribute: "accountId", value: accountId }],
      select: ["id", "name", "firstName", "lastName", "emailAddress"],
      maxSize: 50,
    });
    for (const c of cs.list || []) {
      if (!c.emailAddress) continue;
      const email = String(c.emailAddress).trim().toLowerCase();
      known.add(email);
      if (email === recipient) {
        const contactName = String(c.name || `${c.firstName || ""} ${c.lastName || ""}`).trim();
        if (contactName) contactNames.push(contactName);
      }
    }
  } catch { /* Contacts list unavailable */ }
  if (!known.has(recipient)) return { ok: false, error: `recipient '${to}' is not a CRM-verified email on this Account (known: ${[...known].join(", ") || "none"})` };
  return { ok: true, name: String(acct.name), to: recipient, contactNames: [...new Set(contactNames)] };
}

function normalizedNameTokens(value: string): string[] {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .match(/[\p{L}]+/gu) || [];
}

export function namedSalutation(text: string): string | null {
  const firstLine = String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  const formal = firstLine.match(/^Sehr\s+geehrt(?:e|er)\s+(?:Frau|Herr)\s+(.+?)[,!]?$/iu);
  if (formal?.[1]) return formal[1].trim();
  const informal = firstLine.match(/^(?:Grüezi|Hallo|Guten\s+Tag)\s+(?:(?:Frau|Herr)\s+)?(.+?)[,!]?$/iu);
  const candidate = informal?.[1]?.trim();
  if (!candidate || /^(?:zusammen|allerseits|miteinander|liebes?\s+team)$/iu.test(candidate)) return null;
  return candidate;
}

export function verifySalutationIdentity(
  body: string,
  recipient: VerifiedVenueRecipient,
): { ok: true } | { ok: false; error: string } {
  const addressedName = namedSalutation(body);
  if (!addressedName) return { ok: true };
  if (!recipient.contactNames.length) {
    return {
      ok: false,
      error:
        `Named salutation '${addressedName}' is not evidence-backed for ${recipient.to}. ` +
        "No CRM Contact owns this exact address; use a neutral greeting such as 'Sehr geehrte Damen und Herren' or 'Guten Tag'.",
    };
  }
  const addressed = new Set(normalizedNameTokens(addressedName));
  const matches = recipient.contactNames.some((name) =>
    normalizedNameTokens(name).some((token) => addressed.has(token)));
  if (!matches) {
    return {
      ok: false,
      error:
        `Named salutation '${addressedName}' does not match the CRM Contact(s) who own ${recipient.to}: ` +
        `${recipient.contactNames.join(", ")}.`,
    };
  }
  return { ok: true };
}
const OPP_STAGE_MAP_M: Record<string, { stage: string; probability: number }> = { contacted: { stage: "Qualification", probability: 25 } };
async function advanceOppM(espo: EspoLike, accountId: string, canonStage: string, name?: string): Promise<void> {
  const m = OPP_STAGE_MAP_M[canonStage];
  if (!m || !accountId) return;
  try {
    const ex = await espo.list("Opportunity", { where: [{ type: "equals", attribute: "accountId", value: accountId }], select: ["id", "stage", "probability", "amount"], orderBy: "createdAt", order: "desc", maxSize: 5 });
    const opp = (ex.list || [])[0];
    if (opp) {
      if (opp.stage === "Closed Won" || opp.stage === "Closed Lost") return;
      const attrs: Record<string, unknown> = {};
      if (m.probability > Number(opp.probability ?? 0)) { attrs.stage = m.stage; attrs.probability = m.probability; }
      if (Object.keys(attrs).length) await espo.update("Opportunity", String(opp.id), attrs);
      return;
    }
    await espo.create("Opportunity", { name: name || "Deal", accountId, stage: m.stage, probability: m.probability });
  } catch { /* best-effort — a pipeline hiccup must never fail the send */ }
}
// The actual send (used by the panel action). Verifies the recipient again at send time, applies the
// send-guard (test-lock by default; live only when CK_ESPO_SEND_LIVE=1), creates + sends the Espo
// Email as alan@treshermanos.ch, advances the pipeline.
async function sendVenueEmailM(espo: EspoLike, o: { to: string; subject: string; body: string; account_id: string; in_reply_to?: string }): Promise<{ ok: true; email_id: unknown; delivered_to: string; test_lock: boolean; live_send?: boolean; requested_to?: string } | { ok: false; error: string }> {
  const route = resolveEspoSendRoute({ to: o.to, subject: o.subject, body: o.body });
  if (!route.ok) return route;
  const v = await verifyVenueRecipient(espo, o.account_id, o.to);
  if (!v.ok) return v;
  const salutation = verifySalutationIdentity(o.body, v);
  if (!salutation.ok) return salutation;
  try {
    const em = await espo.create("Email", {
      from: "alan@treshermanos.ch",
      to: route.deliverTo,
      subject: route.subject.slice(0, 250),
      body: htmlBody(o.body),
      isHtml: true,
      status: "Sending",
      parentType: "Account",
      parentId: o.account_id,
      assignedUserId: "6a3b607a33b6f5c55",
      ...(o.in_reply_to ? { repliedId: o.in_reply_to } : {}),
    });
    if (route.liveSend) await advanceOppM(espo, o.account_id, "contacted", `${v.name} — Tres Hermanos`);
    return {
      ok: true,
      email_id: (em as { id?: string }).id,
      delivered_to: route.deliverTo,
      requested_to: route.requestedTo,
      test_lock: route.testLock,
      live_send: route.liveSend,
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensurePendingSendTable(sql: any): Promise<void> {
  await sql`create table if not exists ck_eval.pending_send (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    issue_id uuid,
    account_id text,
    venue_name text,
    interaction_id uuid,
    to_email text not null,
    subject text not null,
    draft_body text not null,
    body text not null,
    from_name text,
    in_reply_to text,
    agent_id uuid,
    status text not null default 'pending',
    edited boolean not null default false,
    email_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    resolved_at timestamptz)`;
  await sql`alter table ck_eval.pending_send add column if not exists updated_at timestamptz not null default now()`;
  await sql`alter table ck_eval.pending_send add column if not exists in_reply_to text`;
  await sql`create unique index if not exists pending_send_one_live_per_issue_idx
    on ck_eval.pending_send (company_id, issue_id)
    where status = 'pending' and issue_id is not null`;
  await sql`create unique index if not exists pending_send_one_live_per_account_idx
    on ck_eval.pending_send (company_id, account_id)
    where status in ('pending', 'sending') and account_id is not null`;
  // A Hold reason is seller coaching, not merely lifecycle metadata. Capture it
  // once before cancelling the outbox row so the next issue and future drafts
  // can recall the transferable preference.
  const rejected = (await sql`
    select p.interaction_id, p.agent_id, p.venue_name, i.result->>'reason' as reason
    from ck_eval.pending_send p
    join issue_thread_interactions i on i.id = p.interaction_id
    where p.interaction_id is not null
      and p.agent_id is not null
      and i.status = 'rejected'
      and not exists (
        select 1 from ck_eval.memory_record m
        where m.store = ${"agent:"} || p.agent_id::text
          and m.key = ${"outreach-hold:"} || p.interaction_id::text
      )
  `) as Array<{ interaction_id: string; agent_id: string; venue_name?: string; reason?: string }>;
  for (const row of rejected) {
    const lesson = rejectionFeedbackLesson(row.reason);
    if (!lesson) continue;
    await sql`
      insert into ck_eval.memory_record
        (store, key, value, source, evidence, status, confidence)
      values (
        ${`agent:${row.agent_id}`},
        ${`outreach-hold:${row.interaction_id}`},
        ${sql.json(lesson)},
        ${"alan-hold"},
        ${JSON.stringify({ interaction_id: row.interaction_id, venue: row.venue_name || null })},
        ${"verified"},
        ${0.98}
      )
    `;
  }
  // Native task Hold/expiry and the outbox are two views of one decision. Reconcile
  // whenever the ledger is touched so correctness never depends on opening the
  // outbox page first.
  await sql`
    update ck_eval.pending_send p
    set status = 'cancelled', resolved_at = now(), updated_at = now()
    from issue_thread_interactions i
    where p.interaction_id = i.id
      and p.status = 'pending'
      and i.status in ('rejected', 'expired')
  `;
}
export { verifyVenueRecipient, sendVenueEmailM, ensurePendingSendTable };

export function selectCurrentIssueId(input: {
  snapshotIssueId?: unknown;
  runContextIssueId?: unknown;
  providedHint?: unknown;
}): string {
  return String(
    input.snapshotIssueId || input.runContextIssueId || input.providedHint || "",
  ).trim();
}

export function registerCkTools(
  ctx: PluginContext,
  deps: { getEspo: () => Promise<Espo | null>; getSql?: () => Promise<Sql> },
): void {
  const resolveCurrentIssueId = async (
    runCtx: { runId: string; companyId: string; issueId?: string },
    providedHint?: unknown,
  ): Promise<string> => {
    let snapshotIssueId = "";
    if (deps.getSql) {
      try {
        const sql = await deps.getSql();
        const rows = (await sql`
          select context_snapshot->>'issueId' as issue_id
          from heartbeat_runs
          where id = ${runCtx.runId}
            and company_id = ${runCtx.companyId}
          limit 1
        `) as Array<{ issue_id?: string | null }>;
        snapshotIssueId = String(rows[0]?.issue_id || "").trim();
      } catch {
        // Direct run context and explicit manual fallback remain available.
      }
    }
    return selectCurrentIssueId({
      snapshotIssueId,
      runContextIssueId: runCtx.issueId,
      providedHint,
    });
  };

  // ── Durable memory (the "corpus learns") — recall/remember over ck_eval.memory_record ──
  // Trust gate (structure-yes-trust-no): a new agent fact is stored `unverified`; a second agent
  // asserting the SAME fact promotes it to `verified`; a CONFLICTING value marks it `contested`.
  // recall returns verified+unverified only (never contested/quarantined/expired). All ops audited.
  ctx.tools.register(
    "recall",
    {
      displayName: "Recall memory",
      description:
        "Recall durable facts this company (shared) or you (self) have learned from past tasks — verified + unverified only. Read-only. Call at the START of a task so you don't re-derive known facts (a venue's confirmed contact/preference, a decided price/rule, a confirmed constraint).",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "optional keyword filter" },
          scope: { type: "string", enum: ["all", "company", "self"] },
          limit: { type: "integer" },
        },
      },
    },
    async (params, runCtx) => {
      const getSql = deps.getSql;
      if (!getSql) return { content: JSON.stringify({ memories: [] }) };
      const p = params as { query?: string; scope?: string; limit?: number };
      const lim = Math.min(Number(p.limit) || 12, 30);
      const scope = p.scope || "all";
      const stores: string[] =
        scope === "company" ? ["company"] : scope === "self" ? [`agent:${runCtx.agentId}`] : ["company", `agent:${runCtx.agentId}`];
      const q = String(p.query || "").trim();
      const sql = await getSql();
      const rows = q
        ? await sql`select store,key,coalesce(value #>> '{}', value::text) as value,confidence,status from ck_eval.memory_record
            where store = any(${stores}) and status in ('verified','unverified')
              and (ttl_at is null or ttl_at > now())
              and (coalesce(value #>> '{}', value::text) ilike ${"%" + q + "%"} or key ilike ${"%" + q + "%"})
            order by (status='verified') desc, confidence desc nulls last, updated_at desc limit ${lim}`
        : await sql`select store,key,coalesce(value #>> '{}', value::text) as value,confidence,status from ck_eval.memory_record
            where store = any(${stores}) and status in ('verified','unverified') and (ttl_at is null or ttl_at > now())
            order by (status='verified') desc, confidence desc nulls last, updated_at desc limit ${lim}`;
      const memories = (rows as Array<Record<string, unknown>>).map((r) => ({
        key: r.key,
        value: r.value,
        confidence: r.confidence != null ? Number(r.confidence) : null,
        status: r.status,
        scope: String(r.store).startsWith("agent:") ? "self" : "company",
      }));
      return { content: JSON.stringify({ count: memories.length, memories }), data: { memories } };
    },
  );

  ctx.tools.register(
    "remember",
    {
      displayName: "Remember a fact or checkpoint",
      description:
        "Save ONE durable fact OR a checkpoint. mode:'fact' (default) = a verifiable reusable fact (a venue's confirmed contact/preference, a decided price/rule); a matching fact verifies it, a conflicting value is flagged 'contested'. mode:'checkpoint' = MONOTONIC STATE you overwrite each run (a watermark/coverage marker, a 'do-not-redo' note) — it ALWAYS overwrites the same key and stays recallable, never contested. Use 'checkpoint' for anything you update-and-re-read across runs; use 'fact' for things a second sighting should corroborate.",
      parametersSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "short stable id, e.g. 'venue:hotel-storchen:contact' or 'eval-watermark'" },
          value: { type: "string" },
          confidence: { type: "number", description: "0..1" },
          scope: { type: "string", enum: ["company", "self"], description: "company = shared with all agents; self = your own note" },
          mode: { type: "string", enum: ["fact", "checkpoint"], description: "'checkpoint' overwrites the key every time (watermarks/coverage); 'fact' (default) corroborates/contests" },
          ttl_days: { type: "integer", description: "optional expiry in days" },
        },
        required: ["key", "value"],
      },
    },
    async (params, runCtx) => {
      const getSql = deps.getSql;
      if (!getSql) return { content: JSON.stringify({ ok: false, reason: "memory store unavailable" }) };
      const p = params as { key?: string; value?: string; confidence?: number; scope?: string; mode?: string; ttl_days?: number };
      const policy = normalizeMemoryWrite(p as Record<string, unknown>);
      if (!policy.ok) {
        return {
          content: JSON.stringify({ ok: false, reason: policy.reason }),
          data: { ok: false, reason: policy.reason },
        };
      }
      const { key, value, mode } = policy.input;
      const scope = p.scope === "self" ? "self" : "company";
      const store = scope === "self" ? `agent:${runCtx.agentId}` : "company";
      const conf = Math.max(0, Math.min(1, Number(p.confidence) || 0.6));
      const source = `agent:${runCtx.agentId} run:${runCtx.runId || ""}`;
      const sql = await getSql();
      const evidence = sql.json({ issueId: (runCtx as { issueId?: string }).issueId ?? null, agentId: runCtx.agentId });
      const existing = (await sql`select id,value,status from ck_eval.memory_record where store=${store} and key=${key} limit 1`) as Array<{ id: string; value: string; status: string }>;
      let action: string, status: string, recId: string;
      // Watermarks and explicit checkpoints are monotonic state, not facts to
      // corroborate. Treat them as checkpoints even if an LLM omits `mode`;
      // otherwise a normal timestamp advance incorrectly quarantines the key.
      if (existing.length) {
        const ex = existing[0];
        if (mode === "checkpoint") {
          // Monotonic state (watermark/coverage): always overwrite + keep it recallable.
          // Never contest — this key is OWNED by the writer, a new value is an update, not a conflict.
          status = "verified";
          await sql`update ck_eval.memory_record set value=${value}, status='verified', confidence=greatest(coalesce(confidence,0), ${conf}), quarantine_reason=null, updated_at=now() where id=${ex.id}`;
          action = "checkpoint";
        } else if (String(ex.value).trim() === value) {
          status = "verified"; // corroborated by a second sighting
          await sql`update ck_eval.memory_record set status='verified', confidence=greatest(coalesce(confidence,0), ${conf}), updated_at=now() where id=${ex.id}`;
          action = "corroborate";
        } else {
          status = "contested";
          await sql`update ck_eval.memory_record set status='contested', quarantine_reason=${"conflicting value from " + source}, updated_at=now() where id=${ex.id}`;
          action = "contest";
        }
        recId = ex.id;
      } else {
        status = initialMemoryStatus(mode);
        const ins = (await sql`insert into ck_eval.memory_record (store,key,value,source,evidence,status,confidence,ttl_at)
          values (${store},${key},${value},${source},${evidence},${status},${conf},${p.ttl_days && Number(p.ttl_days) > 0 ? sql`now() + (${Number(p.ttl_days)} || ' days')::interval` : null}) returning id`) as Array<{ id: string }>;
        action = "create";
        recId = ins[0].id;
      }
      await sql`insert into ck_eval.memory_audit (record_id,action,reason,actor,automatic,snapshot)
        values (${recId},${action},${"agent remember"},${source},true,${sql.json({ key, value, scope, mode, confidence: conf })})`;
      return { content: JSON.stringify({ ok: true, action, status, key }), data: { action, status, key } };
    },
  );

  ctx.tools.register(
    "review_draft",
    {
      displayName: "Review draft (CK quality gate)",
      description: "Deterministically check an outward draft against CK's hard disclosure/quality rules (no 'CK IT Solutions', no 'ß', no relay/invoicing disclosure, no bank details or prices in first contact, no invented prices, no foreign-language leakage, no cross-venue information mixing, and no named salutation unless the exact recipient address belongs to that CRM Contact). Pass account_id and to for recipient-aware checks. Returns pass/fail + specific violations. Run on every draft before it is surfaced to a human.",
      parametersSchema: { type: "object", properties: { text: { type: "string" }, context: { type: "string", description: "e.g. 'first_contact'" }, account_id: { type: "string", description: "the venue this draft is FOR — enables CRM checks" }, to: { type: "string", description: "exact recipient address — required to validate a named salutation" } }, required: ["text"] },
    },
    async (params) => {
      const p = params as { text?: string; context?: string; account_id?: string; to?: string };
      let venueName: string | undefined;
      let venueWebsite: string | undefined;
      let otherVenueNames: string[] | undefined;
      let recipientViolation: string | undefined;
      if (p.account_id) {
        try {
          const espo = await deps.getEspo();
          if (espo) {
            const acct = await espo.get<{ name?: string; website?: string }>("Account", String(p.account_id));
            venueName = String(acct.name || "");
            venueWebsite = String(acct.website || "");
            const all = await espo.list<CrossVenueAccount>("Account", { select: ["id", "name", "type"], maxSize: 500 });
            otherVenueNames = crossVenueNames(all.list, String(p.account_id));
            if (p.to) {
              const recipient = await verifyVenueRecipient(espo, String(p.account_id), String(p.to));
              if (!recipient.ok) recipientViolation = recipient.error;
              else {
                const salutation = verifySalutationIdentity(String(p.text || ""), recipient);
                if (!salutation.ok) recipientViolation = salutation.error;
              }
            }
          }
        } catch { /* mixing check skipped if CRM unreachable — the other checks still run */ }
      }
      // DO-NOT-CONTACT (owner rule, 2026-07-02): drafts TARGETING these venues
      // hard-fail regardless of content quality. Suvretta House is already a
      // direct Tres Hermanos client; producer/brand venues sell their own cigars.
      // Matching is on the TARGET account (name/website), never on mere mentions
      // of these names inside a draft to someone else.
      const DO_NOT_CONTACT: Array<{ match: RegExp; reason: string }> = [
        { match: /suvretta/i, reason: "Suvretta House is a direct Tres Hermanos client — not our prospect" },
        { match: /davidoff/i, reason: "Davidoff producer/brand venue — producers are excluded" },
        { match: /patoro/i, reason: "Patoro is a cigar producer — producers are excluded" },
        { match: /zigarren\s*d(\u00fc|ue?)rr/i, reason: "Zigarren D\u00fcrr is Davidoff-brand retail — excluded" },
      ];
      const target = `${venueName || ""} ${venueWebsite || ""}`;
      const blocked = venueName ? DO_NOT_CONTACT.find((b) => b.match.test(target)) : undefined;
      if (blocked) {
        const r = {
          pass: false,
          violations: [`DO_NOT_CONTACT: target '${venueName}' is on the do-not-contact list — ${blocked.reason}. Abort this outreach entirely; do not rewrite the draft.`],
          checked: "do_not_contact",
        };
        return { content: JSON.stringify(r), data: r };
      }
      const r = reviewDraft(String(p.text || ""), String(p.context || ""), { venueName, otherVenueNames });
      if (recipientViolation) {
        r.pass = false;
        r.violations.push(recipientViolation);
      }
      return { content: JSON.stringify(r), data: r };
    },
  );

  ctx.tools.register(
    "list_recent_work",
    {
      displayName: "List recent agent work products",
      description: "List the most recent work products (last comment) that worker agents posted, so an evaluator can grade them. Pass `since` (ISO timestamp from your last pass, via recall) to get ONLY work newer than that — this is how you AVOID re-grading work you already judged. Each item includes its `ts`; the response includes `latest_ts` (remember it as your next `since`). Returns [{issue_id,title,assignee,ts,last_work_excerpt}]. Read-only.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" }, since: { type: "string", description: "ISO timestamp — only return work products newer than this (your watermark from the last pass)" } } },
    },
    async (params, runCtx) => {
      const p = params as { limit?: number; since?: string };
      const lim = Math.min(Number(p.limit) || 8, 20);
      let effectiveSince = p.since;
      let watermarkSource: "explicit" | "eval-watermark" | null =
        effectiveSince ? "explicit" : null;

      // Evaluation tasks must remain idempotent even when the model forgets to
      // forward the watermark it just recalled. Detect the current issue from
      // the heartbeat context and apply the durable watermark at the tool
      // boundary. Other callers (leadership summaries, etc.) remain unbounded.
      if (!effectiveSince && deps.getSql) {
        try {
          const sql = await deps.getSql();
          const current = (await sql`
            select i.title
            from heartbeat_runs h
            join issues i on i.id = nullif(h.context_snapshot->>'issueId', '')::uuid
            where h.id = ${runCtx.runId}
              and h.company_id = ${runCtx.companyId}
            limit 1
          `) as Array<{ title?: string }>;
          if (/Evaluation Pass/i.test(String(current[0]?.title || ""))) {
            const stores = ["company", `agent:${runCtx.agentId}`];
            const rows = (await sql`
              select coalesce(value #>> '{}', value::text) as value
              from ck_eval.memory_record
              where store = any(${stores})
                and key = 'eval-watermark'
                and (ttl_at is null or ttl_at > now())
              order by (store = ${`agent:${runCtx.agentId}`}) desc, updated_at desc
              limit 1
            `) as Array<{ value?: string }>;
            const candidate = String(rows[0]?.value || "");
            if (Number.isFinite(new Date(candidate).getTime())) {
              effectiveSince = candidate;
              watermarkSource = "eval-watermark";
            }
          }
        } catch {
          // Preserve the read-only fallback if the optional SQL projection is
          // unavailable; an explicit `since` still works.
        }
      }

      const parsedSinceMs = effectiveSince ? new Date(effectiveSince).getTime() : 0;
      const sinceMs = Number.isFinite(parsedSinceMs) ? parsedSinceMs : 0;
      const issues = await ctx.issues.list({ companyId: runCtx.companyId, limit: 80 });
      // newest-active first, so freshly-posted reports/drafts surface (ctx.issues.list order is not guaranteed newest-first)
      const ts = (x: { updatedAt?: string | Date; createdAt?: string | Date }): number => {
        const v = x.updatedAt || x.createdAt;
        return v ? new Date(v).getTime() : 0;
      };
      const sorted = [...(issues as Array<{ id: string; title?: string; assigneeAgentId?: string | null; updatedAt?: string | Date; createdAt?: string | Date }>)]
        .sort((a, b) => ts(b) - ts(a));
      const out: Array<{ issue_id: string; title: string; assignee: string | null; ts: string; last_work_excerpt: string }> = [];
      let latestMs = sinceMs;
      for (const iss of sorted) {
        if (out.length >= lim) break;
        const title = String(iss.title || "");
        // Coordination/evaluation reports are control-plane output, not worker
        // work products to grade. Including the current Evaluation Pass here
        // creates a self-wake/re-grade loop immediately after every run.
        if (/Founder Brief|Daily Huddle|Weekly Tactical|Evaluation Pass|selftest/i.test(title)) continue;
        const issMs = ts(iss);
        if (sinceMs && issMs <= sinceMs) continue; // watermark: skip work already graded in a prior pass
        let comments: Array<{ authorAgentId?: string | null; body?: string }>;
        try { comments = await ctx.issues.listComments(iss.id, runCtx.companyId); } catch { continue; }
        const agentComments = (comments || []).filter((c) => c.authorAgentId);
        if (!agentComments.length) continue;
        if (issMs > latestMs) latestMs = issMs;
        out.push({ issue_id: iss.id, title, assignee: iss.assigneeAgentId ?? null, ts: new Date(issMs).toISOString(), last_work_excerpt: String(agentComments[agentComments.length - 1].body || "").slice(0, 1500) });
      }
      const latest_ts = latestMs ? new Date(latestMs).toISOString() : null;
      const result = {
        count: out.length,
        latest_ts,
        applied_since: effectiveSince ?? null,
        watermark_source: watermarkSource,
        work: out,
      };
      return { content: JSON.stringify(result), data: result };
    },
  );

  ctx.tools.register(
    "list_open_tasks",
    {
      displayName: "List recent delegated tasks (to-do review)",
      description: "List recent tasks (issues) assigned to worker agents with their STATUS (backlog/in_progress/done/cancelled) and age, so a meeting can review whether last cycle's committed to-dos were actually completed. The accountability loop. Read-only.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    async (params, runCtx) => {
      const lim = Math.min(Number((params as { limit?: number }).limit) || 15, 30);
      const issues = await ctx.issues.list({ companyId: runCtx.companyId, limit: 80 });
      const ts = (x: { updatedAt?: string | Date; createdAt?: string | Date }): number => {
        const v = x.updatedAt || x.createdAt; return v ? new Date(v).getTime() : 0;
      };
      const rows = (issues as Array<{ id: string; title?: string; assigneeAgentId?: string | null; status?: string; createdAt?: string | Date }>)
        .filter((i) => i.assigneeAgentId && !/Founder Brief|Daily Huddle|Weekly (Tactical|Leadership)|Finance report|Marketing report|Evaluation Pass|selftest/i.test(String(i.title || "")))
        .sort((a, b) => ts(b) - ts(a))
        .slice(0, lim)
        .map((i) => ({ issue_id: i.id, title: String(i.title || "").slice(0, 90), assignee: i.assigneeAgentId, status: i.status || "unknown", created: String(i.createdAt || "").slice(0, 10) }));
      return { content: JSON.stringify({ count: rows.length, tasks: rows }), data: { tasks: rows } };
    },
  );

  ctx.tools.register(
    "request_decision",
    {
      displayName: "Request a decision from the founder (tap-to-decide)",
      description:
        "Surface a yes/no decision to the human founder (Alan) as a native tap-to-decide on the CURRENT run's issue. " +
        "Use ONLY for things that must cross a human: outward sends, money, contracts. Returns the interaction id. " +
        "CRITICAL for Send cards: put the full To/Subject/Body in `details`. When Alan accepts, YOU (or the runner) must call " +
        "complete_approved_send with approval_id=that interaction id. NEVER create another request_decision for the same send " +
        "(that caused the CK-359 infinite Send-card loop). Prefer queue_email_for_approval for venue outreach (Approvals panel).",
      parametersSchema: { type: "object", properties: { issue_id: { type: "string", description: "Optional fallback outside a live run; live runs always use their current issue." }, prompt: { type: "string" }, details: { type: "string" }, accept_label: { type: "string" }, reject_label: { type: "string" } }, required: ["prompt"] },
    },
    async (params, runCtx) => {
      const p = params as { issue_id?: string; prompt?: string; details?: string; accept_label?: string; reject_label?: string };
      if (!p.prompt) return { content: JSON.stringify({ ok: false, error: "prompt required" }) };
      try {
        const issueId = await resolveCurrentIssueId(runCtx, p.issue_id);
        const targetSource: "run_context" | "provided_hint" =
          issueId && issueId !== String(p.issue_id || "").trim()
            ? "run_context"
            : "provided_hint";
        if (!issueId) {
          return { content: JSON.stringify({ ok: false, error: "No current issue or issue_id fallback is available" }) };
        }

        // ONE LIVE CARD PER ISSUE: supersede any still-pending decision on this issue before creating
        // the new one, so a re-draft (v2) doesn't leave stale cards Alan could tap by mistake. There is
        // no public cancel route; the plugin already holds sql for the send-check, so it expires them here.
        let superseded = 0;
        if (deps.getSql) {
          try {
            const sql = await deps.getSql();
            const ex = (await sql`update issue_thread_interactions set status = 'expired', updated_at = now()
              where company_id = ${runCtx.companyId} and issue_id = ${issueId}
                and kind = 'request_confirmation' and status = 'pending'
              returning id`) as Array<{ id: string }>;
            superseded = ex.length;
          } catch { /* best-effort supersede — never block a new decision on it */ }
        }
        const it = await ctx.issues.requestConfirmation(
          issueId,
          {
            title: String(p.prompt).slice(0, 80),
            summary: (p.details ? String(p.details) : String(p.prompt)).slice(0, 160),
            // wake_assignee_on_accept: the card STAYS pending until Alan acts (async), and on Accept
            // it re-wakes the assignee to complete the action (e.g. send). "none" expired the card.
            continuationPolicy: outreachApprovalContinuationPolicy(),
            // unique per attempt (timestamp) so a just-expired row's key can't shadow this fresh card.
            idempotencyKey: `ck-decision:${issueId}:${Date.now()}`,
            // supersedeOnUserComment:false so the agent's own closing comment doesn't expire the card.
            payload: { version: 1, prompt: String(p.prompt), detailsMarkdown: p.details ? String(p.details) : null, acceptLabel: p.accept_label || "Approve", rejectLabel: p.reject_label || "Hold", allowDeclineReason: true, supersedeOnUserComment: false },
          },
          runCtx.companyId,
          { authorAgentId: runCtx.agentId },
        );
        // Best-effort: ping Alan on Telegram (via the Divino bot) so an approval never sits unseen.
        try {
          await fetch("http://127.0.0.1:8899/notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: `🔔 Approval needed: ${String(p.prompt).slice(0, 220)}\n\nOpen the Paperclip Inbox to Approve or Hold.` }),
            signal: AbortSignal.timeout(6000),
          });
        } catch {
          // notify is best-effort — never block or fail the decision on a notify hiccup
        }
        const result = {
          ok: true,
          interaction_id: (it as { id?: string })?.id,
          issue_id: issueId,
          target_source: targetSource,
          superseded_cards: superseded,
        };
        return { content: JSON.stringify(result), data: result };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  // The NEW outreach hand-off: instead of request_decision + espo_send_email-on-accept, the drafter
  // QUEUES the email here. It lands in the Approvals panel where Alan can EDIT it, then Approve & Send
  // (the panel sends directly) or Cancel — and any edit becomes a learning signal. The agent does NOT
  // send; its job ends at queueing. Recipient + do-not-contact + the review_draft gate are checked HERE
  // (fail fast), so only clean, sendable drafts reach Alan.
  ctx.tools.register(
    "queue_email_for_approval",
    {
      displayName: "Queue an outreach email for Alan's approval (edit + send in the Approvals panel)",
      description:
        "Hand a finished B2B outreach email to Alan for approval. The inbox card's Accept sends the exact bound copy once; alternatively Alan can EDIT it in Outreach outbox and then Approve & Send. Use this INSTEAD of a generic request_decision. Checks the recipient is CRM-verified, validates any named salutation against the Contact who owns the exact address, applies do-not-contact, and runs review_draft. One stable approval per issue: while Alan is deciding, repeat calls return the existing card without replacing it.",
      parametersSchema: { type: "object", properties: { issue_id: { type: "string", description: "Optional fallback outside a live task; Paperclip resolves the current task automatically." }, account_id: { type: "string", description: "the venue Account (CRM verify + timeline)" }, to: { type: "string", description: "recipient — must be a CRM-verified email on the Account" }, subject: { type: "string" }, body: { type: "string", description: "plain-text draft (no dashes/hyphens — the gate enforces it)" }, from_name: { type: "string" }, in_reply_to: { type: "string", description: "Espo Email id of the inbound message being answered; required for reply drafts so Espo preserves the thread." } }, required: ["account_id", "to", "subject", "body"] },
    },
    async (params, runCtx) => {
      const p = params as { issue_id?: string; account_id?: string; to?: string; subject?: string; body?: string; from_name?: string; in_reply_to?: string };
      // The authenticated run context is authoritative. A model may see a
      // duplicate/reference identifier in comments and guess "CK-364"; never
      // let that bind an approval to the wrong task.
      const issueId = await resolveCurrentIssueId(runCtx, p.issue_id);
      if (!issueId || !p.account_id || !p.to || !p.subject || !p.body) return { content: JSON.stringify({ ok: false, error: "current issue, account_id, to, subject, body required" }) };
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      if (!deps.getSql) return { content: JSON.stringify({ ok: false, error: "queue unavailable (no sql)" }) };
      const sql = await deps.getSql();
      await ensurePendingSendTable(sql);
      const existing = (await sql`
        select id, issue_id, interaction_id
        from ck_eval.pending_send
        where company_id = ${runCtx.companyId}
          and (issue_id = ${issueId} or account_id = ${String(p.account_id)})
          and status in ('pending', 'sending')
        order by created_at desc
        limit 1
      `) as Array<{ id: string; issue_id?: string; interaction_id?: string }>;
      if (existing.length) {
        const collision = approvalQueueCollision(issueId, existing[0].issue_id);
        const sameIssue = collision.sameIssue;
        await ctx.issues.update(
          issueId,
          { status: collision.issueStatus },
          runCtx.companyId,
        ).catch(() => undefined);
        const out = {
          ok: true,
          queued: false,
          awaiting_human: true,
          duplicate_account_approval: !sameIssue,
          canonical_issue_id: existing[0].issue_id,
          pending_id: existing[0].id,
          interaction_id: existing[0].interaction_id,
          message: sameIssue
            ? "An approval is already pending for this issue. Do not redraft, requeue, or add another approval card until Alan acts."
            : "This CRM account already has a live approval on another issue. This duplicate issue was cancelled; use the canonical approval and do not create another card.",
        };
        return { content: JSON.stringify(out), data: out };
      }
      // 1) recipient + do-not-contact
      const v = await verifyVenueRecipient(espo, String(p.account_id), String(p.to));
      if (!v.ok) return { content: JSON.stringify({ ok: false, error: v.error }) };
      const salutation = verifySalutationIdentity(String(p.body), v);
      if (!salutation.ok) return { content: JSON.stringify({ ok: false, gate_failed: true, violations: [salutation.error] }) };
      // 2) the quality/disclosure gate — same gate that guards a send; refuse a failing draft
      const gate = reviewOutreachMessage(String(p.subject), String(p.body), { venueName: v.name });
      if (!gate.pass) return { content: JSON.stringify({ ok: false, gate_failed: true, violations: gate.violations }) };
      try {
        const ins = (await sql`insert into ck_eval.pending_send (company_id, issue_id, account_id, venue_name, to_email, subject, draft_body, body, from_name, in_reply_to, agent_id)
          values (${runCtx.companyId}, ${issueId}, ${String(p.account_id)}, ${v.name}, ${String(p.to).trim().toLowerCase()}, ${String(p.subject)}, ${String(p.body)}, ${String(p.body)}, ${p.from_name ? String(p.from_name) : null}, ${p.in_reply_to ? String(p.in_reply_to) : null}, ${runCtx.agentId})
          on conflict do nothing
          returning id`) as Array<{ id: string }>;
        const pendingId = ins[0]?.id;
        if (!pendingId) {
          const raced = (await sql`
            select id, issue_id, interaction_id
            from ck_eval.pending_send
            where company_id = ${runCtx.companyId}
              and (issue_id = ${issueId} or account_id = ${String(p.account_id)})
              and status in ('pending', 'sending')
            order by created_at desc
            limit 1
          `) as Array<{ id: string; issue_id?: string; interaction_id?: string }>;
          const collision = approvalQueueCollision(issueId, raced[0]?.issue_id);
          const sameIssue = collision.sameIssue;
          await ctx.issues.update(
            issueId,
            { status: collision.issueStatus },
            runCtx.companyId,
          ).catch(() => undefined);
          const out = {
            ok: true,
            queued: false,
            awaiting_human: true,
            duplicate_account_approval: !sameIssue,
            canonical_issue_id: raced[0]?.issue_id,
            pending_id: raced[0]?.id,
            interaction_id: raced[0]?.interaction_id,
            message: sameIssue
              ? "A concurrent run already created the approval. Stop; do not create another card."
              : "A concurrent task already created an approval for this CRM account. This duplicate issue was cancelled.",
          };
          return { content: JSON.stringify(out), data: out };
        }
        let interactionId: string | undefined;
        try {
          const it = await ctx.issues.requestConfirmation(issueId, {
            title: `Approve outreach: ${v.name}`.slice(0, 80),
            summary: `To ${String(p.to)} · ${String(p.subject)} — Accept sends this exact copy once; use Outreach outbox to edit first.`.slice(0, 160),
            continuationPolicy: outreachApprovalContinuationPolicy(),
            idempotencyKey: `ck-send:${issueId}:${Date.now()}`,
            payload: {
              version: 1,
              prompt: `Approve and send this exact outreach to ${v.name}? Accept sends it once. To edit the wording first, use Outreach outbox instead.`,
              detailsMarkdown: `**To:** ${p.to}\n**Betreff:** ${p.subject}\n\n${p.body}`,
              acceptLabel: "Approve & send",
              rejectLabel: "Hold",
              allowDeclineReason: true,
              supersedeOnUserComment: outreachApprovalSupersedesOnUserComment(),
            },
          }, runCtx.companyId, { authorAgentId: runCtx.agentId });
          interactionId = (it as { id?: string })?.id;
          if (interactionId) await sql`update ck_eval.pending_send set interaction_id = ${interactionId} where id = ${pendingId}`;
        } catch { /* the panel works off pending_send even if the card fails */ }
        await ctx.issues.update(issueId, { status: "in_review" }, runCtx.companyId).catch(() => undefined);
        try {
          await fetch("http://127.0.0.1:8899/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `🔔 Outreach ready for approval: ${v.name} → ${p.to}\n\nOpen CK → Approvals to edit + send.` }), signal: AbortSignal.timeout(6000) });
        } catch { /* notify is best-effort */ }
        const out = { ok: true, pending_id: pendingId, interaction_id: interactionId, queued: true };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 200) }) };
      }
    },
  );

  ctx.tools.register(
    "web_search",
    {
      displayName: "Web search",
      description: "Search the web (DuckDuckGo) and return real result links {title,url}. Use to find a website-less venue's official site / socials, then pass a URL to web_fetch. Never invents results.",
      parametersSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", description: "max results (default 6)" } }, required: ["query"] },
    },
    async (params) => {
      const p = params as { query?: string; limit?: number };
      const r = await webSearch(String(p.query || ""), Math.min(Number(p.limit) || 6, 12));
      return { content: JSON.stringify(r), data: r };
    },
  );

  ctx.tools.register(
    "send_email",
    {
      displayName: "Send email (TEST-LOCKED, approval-gated)",
      description: "Send an email via the CK mail relay (Infomaniak SMTP). TEST MODE (default): relay delivers to alan@treshermanos.ch regardless of 'to'. Test/experiment content is REFUSED to any other address. REQUIRES approval_id from an ACCEPTED request_decision. Flow: draft → review_draft → request_decision → human accepts → send_email.",
      parametersSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, from_name: { type: "string" }, approval_id: { type: "string", description: "id of the ACCEPTED request_decision for this exact send" } }, required: ["to", "subject", "body", "approval_id"] },
    },
    async (params, runCtx) => {
      // Approval gate (2026-07-03): a send happens ONLY against a human-ACCEPTED
      // decision. Enforced here (architectural), not just in charters.
      {
        const pa = params as { approval_id?: string };
        if (!deps.getSql) return { content: JSON.stringify({ ok: false, error: "approval check unavailable (no sql)" }) };
        const sql = await deps.getSql();
        // single-use: an approval covers exactly ONE send (no replay of old accepts)
        const rows = (await sql`update issue_thread_interactions
          set result = result || jsonb_build_object('send_used_at', now()::text)
          where id = ${String(pa.approval_id || "")} and company_id = ${runCtx.companyId}
            and status = 'accepted' and result->>'outcome' = 'accepted'
            and result->>'send_used_at' is null
          returning id`) as Array<{ id: string }>;
        if (!rows.length) {
          return { content: JSON.stringify({ ok: false, error: "approval_id is not an ACCEPTED, UNUSED decision — each send needs its own request_decision accepted by the human" }) };
        }
      }

      const p = params as { to?: string; subject?: string; body?: string; from_name?: string };
      const toAddr = String(p.to || "").trim().toLowerCase();
      if (looksLikeTestOrExperiment(String(p.subject || ""), String(p.body || "")) && !isAlanSafeRecipient(toAddr)) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `REFUSED: test/experiment mail cannot be sent to '${toAddr}'. Use alan@treshermanos.ch only.`,
          }),
        };
      }
      try {
        const r = await fetch(MAIL_RELAY_URL + "/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: p.to || "", subject: p.subject || "", body: p.body || "", from_name: p.from_name || "Divino Cigars" }),
          signal: AbortSignal.timeout(45000),
        });
        const j = (await r.json()) as Record<string, unknown>;
        return { content: JSON.stringify(j), data: j };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: `mail relay unreachable: ${String(e).slice(0, 160)}` }) };
      }
    },
  );

  // Deterministic send-on-accept for partner/internal/venue mail after request_decision.
  // Fixes the CK-359 loop: accept used to re-wake an agent that only re-posted the same card
  // because it had no send tool and the model treated "Send" as "ask again".
  // Parses To/Subject/Body from the accepted card when not supplied; sends via Espo as
  // alan@treshermanos.ch; respects resolveEspoSendRoute (Alan-safe @treshermanos.* deliver live;
  // venue recipients need CK_ESPO_SEND_LIVE=1 or are test-lock redirected).
  ctx.tools.register(
    "complete_approved_send",
    {
      displayName: "Complete an approved send (Espo, single-use approval)",
      description:
        "After Alan accepts a request_decision Send card, call THIS with approval_id (= interaction id). " +
        "Sends the email through EspoCRM as alan@treshermanos.ch and marks the approval used so it cannot re-fire. " +
        "to/subject/body are optional when the card's details already contain them. " +
        "Optional account_id parents the mail on a venue timeline. " +
        "NEVER create another request_decision for the same send. Flow: request_decision → Alan accepts → complete_approved_send.",
      parametersSchema: {
        type: "object",
        properties: {
          approval_id: { type: "string", description: "id of the ACCEPTED request_decision / interaction" },
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          account_id: { type: "string", description: "optional venue Account for CRM timeline" },
        },
        required: ["approval_id"],
      },
    },
    async (params, runCtx) => {
      const p = params as { approval_id?: string; to?: string; subject?: string; body?: string; account_id?: string };
      if (!deps.getSql) return { content: JSON.stringify({ ok: false, error: "approval check unavailable (no sql)" }) };
      const sql = await deps.getSql();
      const approvalId = String(p.approval_id || "").trim();
      if (!approvalId) return { content: JSON.stringify({ ok: false, error: "approval_id required" }) };

      // Load the accepted, unused interaction and claim it atomically.
      const claimed = (await sql`
        update issue_thread_interactions
        set result = coalesce(result, '{}'::jsonb) || jsonb_build_object('send_used_at', now()::text),
            updated_at = now()
        where id = ${approvalId}
          and company_id = ${runCtx.companyId}
          and status = 'accepted'
          and coalesce(result->>'outcome', 'accepted') = 'accepted'
          and result->>'send_used_at' is null
        returning id, issue_id, payload, result
      `) as Array<{ id: string; issue_id: string; payload: Record<string, unknown> | null; result: Record<string, unknown> | null }>;
      if (!claimed.length) {
        return {
          content: JSON.stringify({
            ok: false,
            error: "approval_id is not an ACCEPTED, UNUSED decision — already sent, still pending, or wrong id",
          }),
        };
      }
      const row = claimed[0];
      const payload = (row.payload || {}) as Record<string, unknown>;
      // Claim the linked outbox row too. Whichever surface wins this atomic
      // pending -> sending transition owns the send, preventing a double-send
      // when Alan taps the task card and Outreach outbox close together.
      const linkedRows = (await sql`
        update ck_eval.pending_send
        set status = 'sending', updated_at = now()
        where interaction_id = ${approvalId}
          and status = 'pending'
        returning account_id, to_email, subject, body, in_reply_to
      `) as Array<LinkedPendingSend>;
      const linkedPending = linkedRows[0] ?? null;
      if (!linkedPending) {
        const existing = (await sql`
          select status, email_id
          from ck_eval.pending_send
          where interaction_id = ${approvalId}
          limit 1
        `) as Array<{ status?: string; email_id?: string | null }>;
        if (existing.length) {
          if (existing[0].status === "sent") {
            await sql`
              update issue_thread_interactions
              set result = (result - 'send_error')
                    || jsonb_build_object(
                      'send_email_id',
                      ${String(existing[0].email_id || "")}::text
                    ),
                  updated_at = now()
              where id = ${approvalId}
            `;
          } else {
            await sql`
              update issue_thread_interactions
              set result = (result - 'send_used_at')
                    || jsonb_build_object(
                      'send_error',
                      ${`linked outbox item is ${String(existing[0].status || "unavailable")}`}::text
                    ),
                  updated_at = now()
              where id = ${approvalId}
            `;
          }
          return {
            content: JSON.stringify({
              ok: existing[0].status === "sent",
              already_resolved: true,
              status: existing[0].status,
              email_id: existing[0].email_id,
              error: existing[0].status === "sent"
                ? undefined
                : `linked outbox item is ${String(existing[0].status || "unavailable")}`,
            }),
          };
        }
      }

      const resolved = resolveApprovedSendContent(p, payload, linkedPending);
      const { to, subject, body } = resolved;
      const accountId = resolved.accountId || String(p.account_id || "").trim();
      if (!to || !subject || !body) {
        await sql`
          update issue_thread_interactions
          set result = coalesce(result, '{}'::jsonb) || jsonb_build_object('send_error', 'missing to/subject/body on card'),
              updated_at = now()
          where id = ${approvalId}
        `;
        // release claim so a corrected re-run can retry
        await sql`
          update issue_thread_interactions
          set result = (result - 'send_used_at'), updated_at = now()
          where id = ${approvalId}
        `;
        if (linkedPending) {
          await sql`
            update ck_eval.pending_send
            set status = 'pending', updated_at = now()
            where interaction_id = ${approvalId} and status = 'sending'
          `;
        }
        return {
          content: JSON.stringify({
            ok: false,
            error: "could not resolve to/subject/body from params or card details — pass them explicitly",
          }),
        };
      }

      if (linkedPending) {
        const gate = reviewOutreachMessage(subject, body);
        if (!gate.pass) {
          const error = `Draft no longer passes the outreach gate: ${gate.violations.join(" ")}`;
          await sql`
            update issue_thread_interactions
            set status = 'rejected',
                result = (coalesce(result, '{}'::jsonb) - 'send_used_at')
                  || jsonb_build_object(
                    'version', 1,
                    'outcome', 'rejected',
                    'reason', ${error.slice(0, 800)}::text,
                    'send_error', ${error.slice(0, 800)}::text
                  ),
                resolved_at = coalesce(resolved_at, now()),
                updated_at = now()
            where id = ${approvalId}
          `;
          await sql`
            update ck_eval.pending_send
            set status = 'cancelled', resolved_at = now(), updated_at = now()
            where interaction_id = ${approvalId} and status = 'sending'
          `;
          return {
            content: JSON.stringify({
              ok: false,
              gate_failed: true,
              needs_revision: true,
              error,
              violations: gate.violations,
            }),
          };
        }
      }

      const route = resolveEspoSendRoute({ to, subject, body });
      if (!route.ok) {
        await sql`
          update issue_thread_interactions
          set result = (coalesce(result, '{}'::jsonb) - 'send_used_at')
                || jsonb_build_object('send_error', ${route.error.slice(0, 400)}::text),
              updated_at = now()
          where id = ${approvalId}
        `;
        if (linkedPending) {
          await sql`
            update ck_eval.pending_send
            set status = 'pending', updated_at = now()
            where interaction_id = ${approvalId} and status = 'sending'
          `;
        }
        return { content: JSON.stringify({ ok: false, error: route.error }) };
      }

      const espo = await deps.getEspo();
      if (!espo) {
        await sql`
          update issue_thread_interactions
          set result = (result - 'send_used_at') || jsonb_build_object('send_error', 'no Espo config'),
              updated_at = now()
          where id = ${approvalId}
        `;
        if (linkedPending) {
          await sql`
            update ck_eval.pending_send
            set status = 'pending', updated_at = now()
            where interaction_id = ${approvalId} and status = 'sending'
          `;
        }
        return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      }

      try {
        const attrs: Record<string, unknown> = {
          from: "alan@treshermanos.ch",
          to: route.deliverTo,
          subject: route.subject.slice(0, 250),
          body: htmlBody(body),
          isHtml: true,
          status: "Sending",
          assignedUserId: "6a3b607a33b6f5c55",
        };
        if (accountId) {
          attrs.parentType = "Account";
          attrs.parentId = accountId;
        }
        if (linkedPending?.in_reply_to) attrs.repliedId = String(linkedPending.in_reply_to);
        const em = await espo.create<{ id?: string; status?: string }>("Email", attrs);
        await sql`
          update issue_thread_interactions
          set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                'send_email_id', ${String(em.id || "")}::text,
                'delivered_to', ${route.deliverTo}::text,
                'requested_to', ${route.requestedTo}::text
              ),
              updated_at = now()
          where id = ${approvalId}
        `;
        // A queue_email_for_approval card has a linked outbox row. Completing
        // the accepted inbox card must resolve that same row, otherwise the
        // outbox still offers a second send for mail that already left.
        await sql`
          update ck_eval.pending_send
          set status = 'sent',
              email_id = ${String(em.id || "")},
              resolved_at = now(),
              updated_at = now()
          where interaction_id = ${approvalId}
            and status in ('pending', 'sending')
        `;
        if (route.liveSend && accountId) {
          try {
            await advanceOpportunity(accountId, "contacted");
          } catch {
            /* best-effort */
          }
        }
        const out = {
          ok: true,
          email_id: em.id,
          status: em.status,
          sent_as: "alan@treshermanos.ch",
          requested_to: route.requestedTo,
          delivered_to: route.deliverTo,
          test_lock: route.testLock,
          live_send: route.liveSend,
          approval_id: approvalId,
          issue_id: row.issue_id,
        };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        const err = String(e).slice(0, 200);
        await sql`
          update issue_thread_interactions
          set result = (result - 'send_used_at') || jsonb_build_object('send_error', ${err}::text),
              updated_at = now()
          where id = ${approvalId}
        `;
        if (linkedPending) {
          await sql`
            update ck_eval.pending_send
            set status = 'pending', updated_at = now()
            where interaction_id = ${approvalId} and status = 'sending'
          `;
        }
        return { content: JSON.stringify({ ok: false, error: err }) };
      }
    },
  );

  // ── Pipeline auto-writer (deterministic): find-or-advance the ONE Opportunity for a venue to
  // `canonStage`, FORWARD-ONLY (never regresses; never touches a Closed Won/Lost deal). Called
  // best-effort by espo_send_email (→ contacted) and espo_create_meeting (→ booked) so the pipeline
  // + pipeline state cannot be left stale by a forgotten agent step. Amount and close date remain
  // NULL until a real quote/order or an agreed timetable supplies evidence; pipeline accounting must
  // never manufacture commercial values merely to make a forecast non-zero.
  const OPP_STAGE_MAP: Record<string, { stage: string; probability: number }> = {
    signal: { stage: "Prospecting", probability: 5 },
    qualified: { stage: "Qualification", probability: 15 },
    contacted: { stage: "Qualification", probability: 25 },
    replied: { stage: "Proposal", probability: 40 },
    booked: { stage: "Proposal", probability: 60 },
    proposal: { stage: "Negotiation", probability: 75 },
    won: { stage: "Closed Won", probability: 100 },
    lost: { stage: "Closed Lost", probability: 0 },
  };
  async function advanceOpportunity(accountId: string, canonStage: string, name?: string): Promise<Record<string, unknown>> {
    const m = OPP_STAGE_MAP[canonStage];
    if (!m || !accountId) return { ok: false, skipped: "bad_args" };
    const espo = await deps.getEspo();
    if (!espo) return { ok: false, skipped: "no_espo" };
    const ex = await espo.list<Record<string, unknown>>("Opportunity", {
      where: [{ type: "equals", attribute: "accountId", value: String(accountId) }],
      select: ["id", "stage", "probability", "amount"], orderBy: "createdAt", order: "desc", maxSize: 10,
    });
    const opp = (ex.list || [])[0];
    if (opp) {
      if (opp.stage === "Closed Won" || opp.stage === "Closed Lost") return { ok: true, opportunity_id: opp.id, action: "terminal_unchanged" };
      const attrs: Record<string, unknown> = {};
      if (m.probability > Number(opp.probability ?? 0)) { attrs.stage = m.stage; attrs.probability = m.probability; }
      if (Object.keys(attrs).length === 0) return { ok: true, opportunity_id: opp.id, action: "no_change" };
      await espo.update("Opportunity", String(opp.id), attrs);
      return { ok: true, opportunity_id: opp.id, action: attrs.stage ? "advanced" : "amount_set", to_stage: canonStage };
    }
    const created = await espo.create<{ id?: string }>("Opportunity", {
      name: name || "Deal", accountId: String(accountId),
      stage: m.stage, probability: m.probability,
    });
    return { ok: true, opportunity_id: created.id, action: "created", to_stage: canonStage };
  }

  ctx.tools.register(
    "espo_send_email",
    {
      displayName: "Espo: send B2B outreach email (approval-gated)",
      description:
        "Send a B2B venue outreach email THROUGH EspoCRM, as alan@treshermanos.ch — logged in Espo (Sent + venue timeline). CRM-verified recipients ONLY. REQUIRES approval_id from an ACCEPTED request_decision (single-use). TEST-LOCKED by default: delivery goes to alan@treshermanos.ch unless CK_ESPO_SEND_LIVE=1 on the host. Test/experiment content is REFUSED to any non-Alan address. Flow: draft → review_draft → request_decision → human accepts → espo_send_email.",
      parametersSchema: { type: "object", properties: { to: { type: "string", description: "recipient — MUST be an email already on the Account or its Contacts" }, subject: { type: "string" }, body: { type: "string", description: "plain text" }, account_id: { type: "string", description: "the venue Account this outreach belongs to (for CRM verify + timeline link)" }, approval_id: { type: "string", description: "id of the ACCEPTED request_decision for this exact send" } }, required: ["to", "subject", "body", "account_id", "approval_id"] },
    },
    async (params, runCtx) => {
      const p = params as { to?: string; subject?: string; body?: string; account_id?: string; approval_id?: string };
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      if (!deps.getSql) return { content: JSON.stringify({ ok: false, error: "approval check unavailable (no sql)" }) };
      const toAddr = String(p.to || "").trim().toLowerCase();
      // 1) single-use approval gate — identical safety to send_email
      const sql = await deps.getSql();
      const okApproval = (await sql`update issue_thread_interactions
        set result = result || jsonb_build_object('send_used_at', now()::text)
        where id = ${String(p.approval_id || "")} and company_id = ${runCtx.companyId}
          and status = 'accepted' and result->>'outcome' = 'accepted' and result->>'send_used_at' is null
        returning id`) as Array<{ id: string }>;
      if (!okApproval.length) return { content: JSON.stringify({ ok: false, error: "approval_id is not an ACCEPTED, UNUSED decision — each send needs its own request_decision accepted by the human" }) };
      try {
        // 2) load the venue + do-not-contact
        const acct = await espo.get<{ name?: string; website?: string; emailAddress?: string }>("Account", String(p.account_id || ""));
        if (!acct || !acct.name) return { content: JSON.stringify({ ok: false, error: "account_id not found" }) };
        const DNC: Array<{ m: RegExp; why: string }> = [
          { m: /suvretta/i, why: "Suvretta House is a direct Tres Hermanos client" },
          { m: /davidoff/i, why: "Davidoff is a producer/brand — excluded" },
          { m: /patoro/i, why: "Patoro is a producer — excluded" },
          { m: /zigarren\s*d(ü|ue?)rr/i, why: "Zigarren Dürr is Davidoff-brand retail — excluded" },
        ];
        const hay = `${acct.name} ${acct.website || ""}`;
        const bad = DNC.find((b) => b.m.test(hay));
        if (bad) return { content: JSON.stringify({ ok: false, error: `DO_NOT_CONTACT: ${acct.name} — ${bad.why}. Abort this outreach.` }) };
        // 3) CRM-verify the recipient: must be the Account's email or one of its Contacts' emails
        const known = new Set<string>();
        if (acct.emailAddress) known.add(String(acct.emailAddress).toLowerCase());
        try {
          const contacts = await espo.related<{ emailAddress?: string }>("Account", String(p.account_id), "contacts", 50);
          for (const c of contacts.list || []) if (c.emailAddress) known.add(String(c.emailAddress).toLowerCase());
        } catch { /* no contacts relation */ }
        if (!known.has(toAddr)) return { content: JSON.stringify({ ok: false, error: `recipient '${toAddr}' is not a CRM-verified email on this Account (known: ${[...known].join(", ") || "none"}). Refusing — never send to an unverified address.` }) };
        const route = resolveEspoSendRoute({ to: toAddr, subject: String(p.subject || ""), body: String(p.body || "") });
        if (!route.ok) return { content: JSON.stringify({ ok: false, error: route.error }) };
        const em = await espo.create<{ id?: string; status?: string }>("Email", {
          from: "alan@treshermanos.ch",
          to: route.deliverTo,
          subject: route.subject.slice(0, 250),
          body: htmlBody(String(p.body || "")),
          isHtml: true,
          status: "Sending",
          parentType: "Account",
          parentId: String(p.account_id),
          assignedUserId: "6a3b607a33b6f5c55",
        });
        let opportunity: Record<string, unknown> = { ok: false, skipped: "not_run" };
        if (route.liveSend) {
          try { opportunity = await advanceOpportunity(String(p.account_id), "contacted", `${acct.name} — Tres Hermanos`); }
          catch (e) { opportunity = { ok: false, error: String(e).slice(0, 120) }; }
        }
        const out = {
          ok: true, email_id: em.id, status: em.status, sent_as: "alan@treshermanos.ch",
          requested_to: route.requestedTo, delivered_to: route.deliverTo, test_lock: route.testLock,
          live_send: route.liveSend, logged_in_espo: true, opportunity,
        };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 200) }) };
      }
    },
  );

  ctx.tools.register(
    "espo_create_account",
    {
      displayName: "Espo: add a new Account (prospect or partner, deduped)",
      description:
        "Create (or return existing) CRM Account. Two kinds: (1) kind=prospect (default) — Swiss venue/lounge/hotel for B2B placement, status 'Noch offen', DNC producers refused. (2) kind=partner — supplier/trade partner (e.g. Tres Hermanos), type Partner, status Partner — so contacts and mail can be parented in Espo. Dedupes by UID / website / normalized name. Never invent facts; leave unknown fields blank. `source` REQUIRED.",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "company/venue name" },
          kind: { type: "string", description: "prospect (default) | partner" },
          website: { type: "string" },
          email: { type: "string", description: "only if actually known/verified" },
          phone: { type: "string" },
          street: { type: "string", description: "street + house number, ONLY if verified — never guessed" },
          postal_code: { type: "string", description: "4-digit Swiss PLZ, only if known" },
          city: { type: "string" },
          canton: { type: "string", description: "2-letter Swiss canton, e.g. ZH, BE, VD, TI" },
          description: { type: "string", description: "short factual description" },
          uid: { type: "string", description: "Zefix UID when from register" },
          source: { type: "string", description: "REQUIRED — where this record came from" },
        },
        required: ["name", "source"],
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const p = params as { name?: string; kind?: string; website?: string; email?: string; phone?: string; street?: string; postal_code?: string; city?: string; canton?: string; description?: string; source?: string; uid?: string };
      const name = String(p.name || "").trim();
      if (!name) return { content: JSON.stringify({ ok: false, error: "name required" }) };
      const kind = String(p.kind || "prospect").trim().toLowerCase() === "partner" ? "partner" : "prospect";
      // do-not-contact — never create a producer/direct-client as a *prospect*; partners are explicit
      const DNC = [/suvretta/i, /davidoff/i, /patoro/i, /zigarren\s*d(ü|ue?)rr/i, /cohiba/i, /cuaba/i];
      const hay = `${name} ${p.website || ""}`;
      if (kind === "prospect" && DNC.some((r) => r.test(hay))) {
        return { content: JSON.stringify({ ok: false, error: `do-not-contact: '${name}' is a producer/producer-brand or direct client — not a prospect.` }) };
      }
      const uid = extractUid(p.uid || p.source || "");
      try {
        let existing: { id?: string; name?: string } | undefined;
        let via = "";
        if (uid) {
          const r = await espo.list<{ id: string; name: string }>("Account", { where: [{ type: "contains", attribute: "description", value: uid }], select: ["id", "name"], maxSize: 5 });
          existing = (r.list || [])[0]; if (existing) via = "uid";
        }
        const domain = p.website ? regDomain(p.website) : "";
        if (!existing && domain) {
          const r = await espo.list<{ id: string; name: string; website?: string }>("Account", { where: [{ type: "contains", attribute: "website", value: domain }], select: ["id", "name", "website"], maxSize: 10 });
          existing = (r.list || []).find((a) => regDomain(a.website || "") === domain); if (existing) via = "domain";
        }
        if (!existing) {
          const key = normName(name);
          const seed = key.split(" ").sort((a, b) => b.length - a.length)[0] || key;
          if (seed.length >= 3) {
            const r = await espo.list<{ id: string; name: string }>("Account", { where: [{ type: "contains", attribute: "name", value: seed }], select: ["id", "name"], maxSize: 50 });
            existing = (r.list || []).find((a) => normName(a.name || "") === key); if (existing) via = "name";
          }
        }
        if (existing) return { content: JSON.stringify({ ok: true, created: false, already_in_crm: true, dedup_via: via, account_id: existing.id, name: existing.name, kind }), data: { account_id: existing.id, created: false, kind } };
        const streetIn = String(p.street || "").trim();
        const streetOk = streetIn && validStreetE(streetIn, String(p.city || ""));
        const desc = String(p.description || "").trim();
        const label = kind === "partner" ? "Partner" : "Prospect";
        const acct = await espo.create<{ id?: string }>("Account", {
          name: name.slice(0, 150),
          type: kind === "partner" ? "Partner" : "Reseller",
          ...(p.website ? { website: String(p.website).startsWith("http") ? p.website : `https://${p.website}` } : {}),
          ...(p.email ? { emailAddress: String(p.email).trim().toLowerCase() } : {}),
          ...(p.phone ? { phoneNumber: String(p.phone).trim().slice(0, 40) } : {}),
          ...(streetOk ? { billingAddressStreet: streetIn.slice(0, 250) } : {}),
          ...(p.postal_code && /^\d{4}$/.test(String(p.postal_code).trim()) ? { billingAddressPostalCode: String(p.postal_code).trim() } : {}),
          ...(p.city ? { billingAddressCity: p.city } : {}),
          ...(p.canton ? { billingAddressState: String(p.canton).toUpperCase().slice(0, 3) } : {}),
          cVertriebsstatus: kind === "partner" ? "Partner" : "Noch offen",
          description: `${desc ? desc.slice(0, 300) + "\n\n" : ""}${label} added.${uid ? ` UID: ${uid}.` : ""} Source: ${String(p.source || "").slice(0, 280)}`,
        });
        const out = { ok: true, created: true, account_id: acct.id, name, kind, street_accepted: !!streetOk, street_rejected: streetIn && !streetOk ? streetIn : undefined };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  // Person on an Account — required so queue_email_for_approval / espo_send can CRM-verify the
  // recipient (Account email OR Contact email). Used for partner people (Philippe @ Tres Hermanos)
  // and venue contacts when missing.
  ctx.tools.register(
    "espo_create_contact",
    {
      displayName: "Espo: add a Contact on an Account (deduped by email)",
      description:
        "Create (or return) a Contact linked to an Account so mail can be CRM-verified and sent/queued through Espo. " +
        "Dedupes by emailAddress company-wide. Requires account_id + email + name parts. " +
        "Use when someone we must write to is not yet a Contact (e.g. Philippe Dubois under Account Tres Hermanos).",
      parametersSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "parent Account id" },
          email: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          title: { type: "string" },
          phone: { type: "string" },
          source: { type: "string", description: "where this contact was learned (mail, Alan, website)" },
        },
        required: ["account_id", "email", "last_name"],
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const p = params as { account_id?: string; email?: string; first_name?: string; last_name?: string; title?: string; phone?: string; source?: string };
      const accountId = String(p.account_id || "").trim();
      const email = String(p.email || "").trim().toLowerCase();
      const lastName = String(p.last_name || "").trim();
      const firstName = String(p.first_name || "").trim();
      if (!accountId || !email || !lastName) {
        return { content: JSON.stringify({ ok: false, error: "account_id, email, last_name required" }) };
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { content: JSON.stringify({ ok: false, error: "email looks invalid" }) };
      }
      try {
        const acct = await espo.get<{ id?: string; name?: string }>("Account", accountId);
        if (!acct?.id) return { content: JSON.stringify({ ok: false, error: "account_id not found" }) };
        // dedup by email
        const existing = await espo.list<{ id: string; name?: string; emailAddress?: string; accountId?: string }>("Contact", {
          where: [{ type: "equals", attribute: "emailAddress", value: email }],
          select: ["id", "name", "emailAddress", "accountId"],
          maxSize: 5,
        });
        const hit = (existing.list || [])[0];
        if (hit?.id) {
          // ensure linked to this account when possible
          if (hit.accountId !== accountId) {
            try {
              await espo.update("Contact", hit.id, { accountId });
            } catch {
              /* best-effort re-parent */
            }
          }
          return {
            content: JSON.stringify({
              ok: true,
              created: false,
              already_in_crm: true,
              contact_id: hit.id,
              account_id: accountId,
              account_name: acct.name,
              email,
            }),
            data: { contact_id: hit.id, created: false, account_id: accountId },
          };
        }
        const created = await espo.create<{ id?: string }>("Contact", {
          firstName: firstName || undefined,
          lastName: lastName.slice(0, 80),
          name: `${firstName} ${lastName}`.trim().slice(0, 150),
          emailAddress: email,
          accountId,
          ...(p.title ? { title: String(p.title).slice(0, 100) } : {}),
          ...(p.phone ? { phoneNumber: String(p.phone).trim().slice(0, 40) } : {}),
          description: p.source ? `Source: ${String(p.source).slice(0, 200)}` : undefined,
        });
        const out = {
          ok: true,
          created: true,
          contact_id: created.id,
          account_id: accountId,
          account_name: acct.name,
          email,
          name: `${firstName} ${lastName}`.trim(),
        };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 200) }) };
      }
    },
  );

  // MANAGEMENT-LOOP tools — let a manager agent (e.g. GOV-25 Chief-of-Staff) SEE the numbers and
  // DELEGATE owned work down the org. This is what turns a pile of agents into a running company.
  ctx.tools.register(
    "espo_pipeline",
    {
      displayName: "Espo: pipeline scoreboard",
      description: "Read the CRM sales pipeline scoreboard: total venue Accounts, counts by status (cVertriebsstatus), how many have an email, how many have a website but no email. The manager's weekly numbers. Read-only.",
      parametersSchema: { type: "object", properties: {} },
    },
    async () => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const res = await paginateEspo<Record<string, unknown>>((offset, maxSize) =>
        espo.list("Account", {
          select: ["id", "name", "emailAddress", "website", "cVertriebsstatus", "billingAddressState"],
          maxSize,
          offset,
        }),
      );
      const list = res.list;
      const byStatus: Record<string, number> = {};
      let withEmail = 0, emaillessWithSite = 0;
      for (const a of list) {
        const st = String(a.cVertriebsstatus || "unset"); byStatus[st] = (byStatus[st] || 0) + 1;
        if (String(a.emailAddress || "").trim()) withEmail++;
        else if (String(a.website || "").trim()) emaillessWithSite++;
      }
      const out = {
        total: list.length,
        source_total: res.sourceTotal,
        pages_scanned: res.pagesScanned,
        coverage_complete: list.length === res.sourceTotal,
        by_status: byStatus,
        with_email: withEmail,
        emailless_with_website: emaillessWithSite,
      };
      return { content: JSON.stringify(out), data: out };
    },
  );

  ctx.tools.register(
    "espo_rank_prospects",
    {
      displayName: "Espo: rank next uncontacted prospects",
      description:
        "Scan the COMPLETE Espo Account universe and deterministically rank reachable, open prospects. Suppresses prior Sent email, pending approvals, open Opportunities, active Paperclip work, non-open CRM status, known do-not-contact targets, and accounts without a verified email. Returns auditable coverage and queue evidence. Read-only by default; create_task_pairs=true creates only internal research + blocked draft tasks and never sends.",
      parametersSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "ranked candidates to return (default 10, max 50)" },
          origin: {
            type: "string",
            description: "When provided, build a driving-distance queue from this Swiss origin (for CK use Oberbuchsiten).",
          },
          local_slots: {
            type: "integer",
            description: "Local distance-prioritized queue target (default 10, max 20). Existing active drafts reserve slots.",
          },
          exceptional_slots: {
            type: "integer",
            description: "Exceptional nationwide queue target outside the active distance band (default 2, max 5).",
          },
          create_task_pairs: {
            type: "boolean",
            description: "Create the selected internal REV-04 research + blocked REV-06 draft pairs. Never sends mail.",
          },
          include_suppressed_examples: {
            type: "boolean",
            description: "include up to 25 suppressed rows for diagnosis (default false)",
          },
        },
      },
    },
    async (params, runCtx) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const p = params as {
        limit?: number;
        origin?: string;
        local_slots?: number;
        exceptional_slots?: number;
        create_task_pairs?: boolean;
        include_suppressed_examples?: boolean;
      };
      const limit = Math.min(Math.max(Number(p.limit) || 10, 1), 50);
      const origin = String(p.origin || "").trim();
      const requestedLocalTarget = Number(p.local_slots);
      const requestedExceptionalTarget = Number(p.exceptional_slots);
      const localTarget = Math.min(Math.max(
        Number.isFinite(requestedLocalTarget) ? requestedLocalTarget : 10,
        0,
      ), 20);
      const exceptionalTarget = Math.min(Math.max(
        Number.isFinite(requestedExceptionalTarget) ? requestedExceptionalTarget : 2,
        0,
      ), 5);

      const accounts = await paginateEspo<ProspectAccount>((offset, maxSize) =>
        espo.list("Account", {
          select: [
            "id", "name", "emailAddress", "website", "description", "type",
            "cVertriebsstatus", "cPrioritaet", "cKategorie", "cChannel",
            "cAnsprechpartner", "billingAddressStreet", "billingAddressPostalCode",
            "billingAddressState", "billingAddressCity",
          ],
          orderBy: "createdAt",
          order: "asc",
          maxSize,
          offset,
        }),
      );

      const sent = await paginateEspo<Record<string, unknown>>((offset, maxSize) =>
        espo.list("Email", {
          where: [
            { type: "equals", attribute: "status", value: "Sent" },
            { type: "equals", attribute: "parentType", value: "Account" },
          ],
          select: ["id", "parentId", "parentType", "status", "dateSent"],
          maxSize,
          offset,
        }),
      );
      const sentAccountIds = new Set(
        sent.list.map((row) => String(row.parentId || "")).filter(Boolean),
      );

      const opportunities = await paginateEspo<Record<string, unknown>>((offset, maxSize) =>
        espo.list("Opportunity", {
          select: ["id", "accountId", "account", "stage"],
          maxSize,
          offset,
        }),
      );
      const inFlightAccountIds = new Set<string>();
      for (const row of opportunities.list) {
        if (String(row.stage || "") === "Closed Lost") continue;
        const account = row.account as { id?: unknown } | undefined;
        const accountId = String(row.accountId || account?.id || "").trim();
        if (accountId) inFlightAccountIds.add(accountId);
      }

      if (deps.getSql) {
        try {
          const sql = await deps.getSql();
          await ensurePendingSendTable(sql);
          const rows = await sql`
            select account_id
            from ck_eval.pending_send
            where company_id = ${runCtx.companyId}
              and status in ('pending', 'sending')
              and account_id is not null`;
          for (const row of rows as Array<{ account_id?: unknown }>) {
            const accountId = String(row.account_id || "").trim();
            if (accountId) inFlightAccountIds.add(accountId);
          }
        } catch {
          // Ranking remains useful from CRM evidence if the optional CK ledger
          // is temporarily unavailable; the output declares this below.
        }
      }

      let activeIssueAccountIds = new Set<string>();
      let activeDraftAccountIds = new Set<string>();
      let activeLocalDraftAccountIds = new Set<string>();
      let activeExceptionalDraftAccountIds = new Set<string>();
      let existingDraftAccountIds = new Set<string>();
      try {
        let issues: Array<{
          status?: unknown;
          title?: unknown;
          description?: unknown;
          draftOwner?: boolean;
        }>;
        if (deps.getSql) {
          const sql = await deps.getSql();
          issues = await sql`
            select
              i.status,
              i.title,
              i.description,
              (
                coalesce(a.metadata->>'ck_id', '') = 'REV-06'
                or a.name ilike 'REV-06%'
              ) as "draftOwner"
            from issues i
            left join agents a on a.id = i.assignee_agent_id
            where i.company_id = ${runCtx.companyId}
              and i.status <> 'cancelled'` as typeof issues;
        } else {
          const agents = await ctx.agents.list({ companyId: runCtx.companyId, limit: 300 }) as Array<{
            id: string;
            name?: string;
            metadata?: { ck_id?: string };
          }>;
          const rev06Ids = new Set(agents
            .filter((agent) =>
              String(agent.metadata?.ck_id || "").toUpperCase() === "REV-06"
              || String(agent.name || "").toUpperCase().startsWith("REV-06"))
            .map((agent) => agent.id));
          issues = (await ctx.issues.list({
            companyId: runCtx.companyId,
            limit: 500,
          }) as unknown as Array<{
            status?: unknown;
            title?: unknown;
            description?: unknown;
            assigneeAgentId?: string;
          }>).map((issue) => ({
            ...issue,
            draftOwner: rev06Ids.has(String(issue.assigneeAgentId || "")),
          }));
        }
        ({
          activeIssueAccountIds,
          activeDraftAccountIds,
          activeLocalDraftAccountIds,
          activeExceptionalDraftAccountIds,
          existingDraftAccountIds,
        } = matchProspectIssueWork(accounts.list, issues));
      } catch {
        // Best-effort second suppression lane. Pending approvals and CRM
        // activity still prevent the most dangerous duplicate outreach.
      }

      const result = rankProspectAccounts(accounts.list, {
        sentAccountIds,
        inFlightAccountIds,
        activeIssueAccountIds,
        existingDraftAccountIds,
      });
      let distanceQueue: Record<string, unknown> | undefined;
      let taskPairCandidates: OutreachQueueCandidate[] = [];
      let selectedActiveRadiusKm: number | null = null;
      if (origin) {
        const occupiedExceptional = activeExceptionalDraftAccountIds.size;
        const occupiedLocal = activeLocalDraftAccountIds.size
          + Math.max(0, activeDraftAccountIds.size
            - activeLocalDraftAccountIds.size
            - activeExceptionalDraftAccountIds.size);
        const refill = calculateQueueRefill({
          localTarget,
          exceptionalTarget,
          occupiedLocal,
          occupiedExceptional,
        });
        const localSlotsToFill = refill.local;
        const exceptionalSlotsToFill = refill.exceptional;
        if (refill.total === 0) {
          distanceQueue = {
            ok: true,
            policy: {
              local_target: localTarget,
              exceptional_target: exceptionalTarget,
              total_target: localTarget + exceptionalTarget,
              refill_not_daily_addition: true,
              minimum_crm_score: 60,
            },
            occupied: {
              local: occupiedLocal,
              exceptional: occupiedExceptional,
              total: occupiedLocal + occupiedExceptional,
            },
            slots_to_fill: refill,
            origin,
            local: [],
            exceptional: [],
            safety: "queue is already at capacity; no candidates were geocoded or selected",
          };
        } else {
          const home = await geocodeCH(`${origin}, Switzerland`);
          if (!home) {
          distanceQueue = {
            ok: false,
            error: `could not geocode origin '${origin}'`,
            safety: "no queue selections returned without a verified origin",
          };
          } else {
            const geocoded: Array<{
              account_id: string;
              coordinates: LatLon;
              precision: "street" | "locality";
            }> = [];
            const ungeocodable: Array<{ account_id: string; name: string; reason: string }> = [];
            let uncachedStreetAttempts = 0;
            const maxUncachedStreetAttempts = 8;
            for (const candidate of result.ranked) {
              if (!candidate.city || candidate.city === "Unspecified") {
                ungeocodable.push({
                  account_id: candidate.account_id,
                  name: candidate.name,
                  reason: "missing verified CRM city",
                });
                continue;
              }
              const address = [
                candidate.street,
                `${candidate.postal_code} ${candidate.city}`.trim(),
                "Switzerland",
              ].filter(Boolean).join(", ");
              const cachedStreet = candidate.street ? geocodeCacheHit(address) : undefined;
              let coordinates = cachedStreet || null;
              let precision: "street" | "locality" = "street";
              if (
                !coordinates
                && candidate.street
                && cachedStreet === undefined
                && uncachedStreetAttempts < maxUncachedStreetAttempts
              ) {
                uncachedStreetAttempts += 1;
                coordinates = await geocodeCH(address);
              }
              if (!coordinates) {
                precision = "locality";
                coordinates = await geocodeSwissLocality(candidate.postal_code, candidate.city);
              }
              if (coordinates) {
                geocoded.push({ account_id: candidate.account_id, coordinates, precision });
              }
              else {
                ungeocodable.push({
                  account_id: candidate.account_id,
                  name: candidate.name,
                  reason: "verified CRM address could not be geocoded",
                });
              }
            }
            try {
              const metrics = await fetchDrivingMetrics(home, geocoded);
              const precisionByAccount = new Map(
                geocoded.map((candidate) => [candidate.account_id, candidate.precision]),
              );
              const selected = selectDistanceQueue(result.ranked, metrics, {
                origin,
                localSlots: localSlotsToFill,
                exceptionalSlots: exceptionalSlotsToFill,
              });
              selectedActiveRadiusKm = selected.active_radius_km;
              const compactSelection = (
                candidate: (typeof selected.local)[number] | (typeof selected.exceptional)[number],
              ): OutreachQueueCandidate => ({
                account_id: candidate.account_id,
                name: candidate.name,
                email: candidate.email,
                website: candidate.website,
                canton: candidate.canton,
                city: candidate.city,
                score: candidate.score,
                score_reasons: candidate.score_reasons,
                distance_km: candidate.distance_km,
                duration_minutes: candidate.duration_minutes,
                outreach_lane: candidate.outreach_lane,
                distance_precision: precisionByAccount.get(candidate.account_id),
              });
              const localSelections = selected.local.map(compactSelection);
              const exceptionalSelections = selected.exceptional.map(compactSelection);
              taskPairCandidates = [...localSelections, ...exceptionalSelections];
              distanceQueue = {
                ok: true,
                policy: {
                  local_target: localTarget,
                  exceptional_target: exceptionalTarget,
                  total_target: localTarget + exceptionalTarget,
                  refill_not_daily_addition: true,
                  minimum_crm_score: 60,
                },
                occupied: {
                  local: occupiedLocal,
                  exceptional: occupiedExceptional,
                  total: occupiedLocal + occupiedExceptional,
                },
                slots_to_fill: {
                  local: localSlotsToFill,
                  exceptional: exceptionalSlotsToFill,
                  total: refill.total,
                },
                origin: selected.origin,
                active_radius_km: selected.active_radius_km,
                distance_source: "OSRM driving distance/time from OpenStreetMap road data",
                geocoded_eligible: geocoded.length,
                street_precision_eligible: geocoded.filter((candidate) => candidate.precision === "street").length,
                locality_precision_eligible: geocoded.filter((candidate) => candidate.precision === "locality").length,
                ungeocodable_eligible: ungeocodable.length,
                local: localSelections,
                exceptional: exceptionalSelections,
                ungeocodable_examples: ungeocodable.slice(0, 10),
              };
            } catch (error) {
              distanceQueue = {
                ok: false,
                error: String(error).slice(0, 240),
                origin,
                geocoded_eligible: geocoded.length,
                safety: "no straight-line substitute was used; retry when OSRM driving data is available",
              };
            }
          }
        }
      }
      let taskPairs: Array<Record<string, unknown>> | undefined;
      if (p.create_task_pairs) {
        taskPairs = [];
        const currentIssueId = String(
          (runCtx as typeof runCtx & { issueId?: string }).issueId || "",
        ).trim();
        if (!origin || !currentIssueId) {
          taskPairs.push({
            ok: false,
            error: !origin
              ? "origin is required when create_task_pairs is true"
              : "a live routine issue is required when create_task_pairs is true",
          });
        } else {
          const agents = await ctx.agents.list({ companyId: runCtx.companyId, limit: 300 }) as Array<{
            id: string;
            name?: string;
            metadata?: { ck_id?: string };
          }>;
          const byCkId = (ckId: string) => agents.find((agent) =>
            String(agent.metadata?.ck_id || "").toUpperCase() === ckId
            || String(agent.name || "").toUpperCase().startsWith(ckId));
          const researcher = byCkId("REV-04");
          const drafter = byCkId("REV-06");
          if (!researcher || !drafter) {
            taskPairs.push({
              ok: false,
              error: "REV-04 and REV-06 must both exist before creating outreach task pairs",
            });
          } else {
            for (const candidate of taskPairCandidates) {
              const brief = buildOutreachTaskPairBrief(candidate, {
                origin,
                activeRadiusKm: selectedActiveRadiusKm,
              });
              try {
                const research = await ctx.issues.create({
                  companyId: runCtx.companyId,
                  projectId: runCtx.projectId,
                  parentId: currentIssueId,
                  title: brief.researchTitle,
                  description: brief.researchDescription,
                  status: "todo",
                  assigneeAgentId: researcher.id,
                  priority: "high",
                }) as { id?: string; identifier?: string };
                const draft = await ctx.issues.create({
                  companyId: runCtx.companyId,
                  projectId: runCtx.projectId,
                  parentId: currentIssueId,
                  title: brief.draftTitle,
                  description: brief.draftDescription,
                  status: "todo",
                  assigneeAgentId: drafter.id,
                  blockedByIssueIds: research.id ? [research.id] : undefined,
                  priority: "high",
                }) as { id?: string; identifier?: string };
                taskPairs.push({
                  ok: true,
                  account_id: candidate.account_id,
                  name: candidate.name,
                  outreach_lane: candidate.outreach_lane,
                  research_issue_id: research.id,
                  research_identifier: research.identifier,
                  draft_issue_id: draft.id,
                  draft_identifier: draft.identifier,
                });
              } catch (error) {
                taskPairs.push({
                  ok: false,
                  account_id: candidate.account_id,
                  name: candidate.name,
                  error: String(error).slice(0, 200),
                });
              }
            }
          }
        }
        if (distanceQueue) distanceQueue.task_pairs = taskPairs;
      }
      const out = {
        source: "EspoCRM Account universe",
        motion_goal: "net_new",
        ranking_basis:
          "CRM priority, placement/channel fit, and contactability after deterministic suppression",
        coverage: {
          source_total: accounts.sourceTotal,
          accounts_scanned: accounts.list.length,
          pages_scanned: accounts.pagesScanned,
          coverage_complete: accounts.list.length === accounts.sourceTotal,
          sent_email_rows_scanned: sent.list.length,
          opportunity_rows_scanned: opportunities.list.length,
        },
        counts: {
          eligible_ranked: result.ranked.length,
          suppressed: result.suppressed.length,
          suppressed_by_reason: result.suppressedByReason,
        },
        ...(distanceQueue ? { distance_queue: distanceQueue } : {}),
        ranked: result.ranked.slice(0, origin ? Math.min(limit, 3) : limit),
        ...(p.include_suppressed_examples
          ? { suppressed_examples: result.suppressed.slice(0, 25) }
          : {}),
        safety: p.create_task_pairs
          ? "internal research/draft tasks only; no CRM records, approvals, or emails were created"
          : "read-only; no CRM records, tasks, drafts, approvals, or emails were created",
      };
      return { content: JSON.stringify(out), data: out };
    },
  );

  ctx.tools.register(
    "create_task",
    {
      displayName: "Create & assign task",
      description: "Create a Paperclip issue (task) assigned to another agent, tracing to a goal — how a manager delegates/routes work down the org. The assignee is woken automatically. Returns the new issue id. Accepts either a raw agent UUID OR a CK short code (e.g. 'REV-06') for assigneeAgentId — resolved automatically. Draft/plan work only; never instructs an outward send.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string", description: "the task brief the assignee will act on" },
          assigneeAgentId: { type: "string", description: "agent UUID or CK short code, e.g. 'REV-06'" },
          goalId: { type: "string", description: "goal id to trace to (optional)" },
          parentIssueId: { type: "string", description: "parent workflow issue; defaults to the current run's issue" },
          blockedByIssueIds: {
            type: "array",
            items: { type: "string" },
            description: "real prerequisite issue ids; use this when the new task must wait for research or another deliverable",
          },
          priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
          dedupeKey: { type: "string", description: "idempotency key — usually the venue name or account_id. If an OPEN task with the same assignee already matches this key (or the same title), that existing task is reused instead of creating a duplicate." },
        },
        required: ["title", "assigneeAgentId"],
      },
    },
    async (params, runCtx) => {
      const p = params as {
        title?: string;
        description?: string;
        assigneeAgentId?: string;
        goalId?: string;
        parentIssueId?: string;
        blockedByIssueIds?: string[];
        priority?: string;
        dedupeKey?: string;
      };
      if (!p.title || !p.assigneeAgentId) return { content: JSON.stringify({ ok: false, error: "title and assigneeAgentId required" }) };
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let assigneeId = String(p.assigneeAgentId).trim();
      if (!UUID_RE.test(assigneeId)) {
        // Agents naturally think in CK short codes ("REV-06"), not Paperclip UUIDs — resolve by
        // metadata.ck_id (exact) or a name-prefix match instead of failing with an opaque "not found".
        const agents = await ctx.agents.list({ companyId: runCtx.companyId, limit: 300 });
        const wanted = assigneeId.toUpperCase();
        const match =
          (agents as Array<{ id: string; name: string; metadata?: { ck_id?: string } }>).find(
            (a) => String(a.metadata?.ck_id || "").toUpperCase() === wanted,
          ) ?? (agents as Array<{ id: string; name: string }>).find((a) => a.name.toUpperCase().startsWith(wanted));
        if (!match) return { content: JSON.stringify({ ok: false, error: `no agent matches '${p.assigneeAgentId}' (tried UUID, ck_id, name-prefix)` }) };
        assigneeId = match.id;
      }
      // Dedup-at-spawn: if an OPEN task with the same assignee already covers this venue/title, reuse it
      // instead of spawning a duplicate (the Widder-x3 / Grauer-x3 problem). Best-effort; never blocks create.
      try {
        const OPEN = new Set(["backlog", "todo", "in_progress", "in_review"]);
        const norm = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z0-9äöü]+/g, " ").trim();
        const titleKey = norm(p.title);
        const dk = p.dedupeKey ? norm(p.dedupeKey) : "";
        const existing = (await ctx.issues.list({ companyId: runCtx.companyId, limit: 200 })) as unknown as Array<{ id: string; title?: string; status?: string; assigneeAgentId?: string }>;
        const hit = (existing || []).find((i) => {
          if (i.assigneeAgentId !== assigneeId || !OPEN.has(String(i.status))) return false;
          const t = norm(i.title);
          return t === titleKey || (dk.length > 4 && t.includes(dk));
        });
        if (hit) return { content: JSON.stringify({ ok: true, issue_id: hit.id, deduped: true, note: `reused existing open task '${String(hit.title).slice(0, 60)}'` }), data: { issue_id: hit.id, deduped: true } };
      } catch { /* dedup is best-effort; fall through to create */ }
      try {
        const currentIssueId = String(
          (runCtx as typeof runCtx & { issueId?: string }).issueId || "",
        ).trim();
        const issue = await ctx.issues.create({
          companyId: runCtx.companyId,
          projectId: runCtx.projectId,
          goalId: p.goalId,
          parentId: String(p.parentIssueId || currentIssueId).trim() || undefined,
          title: String(p.title),
          description: p.description ? String(p.description) : undefined,
          status: "todo",
          assigneeAgentId: assigneeId,
          blockedByIssueIds: Array.isArray(p.blockedByIssueIds)
            ? p.blockedByIssueIds.map(String).filter(Boolean)
            : undefined,
          priority: (p.priority as "low" | "medium" | "high" | "critical") || "medium",
        });
        const id = (issue as { id?: string })?.id;
        return { content: JSON.stringify({ ok: true, issue_id: id, assigned_to: p.assigneeAgentId }), data: { issue_id: id } };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  ctx.tools.register(
    "web_fetch",
    {
      displayName: "Web fetch (stealth)",
      description: "Fetch a venue's website (homepage + Kontakt/Impressum) and return REAL emails found. Falls back to a stealth browser on a Swiss residential IP (renders JS, decodes Cloudflare). Never invents.",
      parametersSchema: { type: "object", properties: { url: { type: "string", description: "venue website (domain or URL)" } }, required: ["url"] },
    },
    async (params) => {
      const r = await webFetch(String((params as { url?: string }).url || ""));
      return { content: JSON.stringify(r), data: r };
    },
  );

  ctx.tools.register(
    "browser_act",
    {
      displayName: "Browser (drive a real page — stealth)",
      description:
        "Do anything a person can do in a web browser, on a real stealth Firefox at a Swiss residential IP. " +
        "One 'action' per call; tabs persist by tabId so a task is a sequence: open -> snapshot -> click/type -> snapshot -> ... -> close. " +
        "Actions: open{url} (returns tabId); snapshot{tabId,screenshot?} (SEE the page as an accessibility tree with [eN] refs — do this before acting); " +
        "click{tabId,ref|selector}; type{tabId,ref|selector,text,pressEnter?}; press{tabId,key}; scroll{tabId,direction}; " +
        "evaluate{tabId,expression} (run JS, returns result — the escape hatch); links{tabId}; screenshot{tabId}; " +
        "allow_dialogs{tabId} (auto-accept native confirm()/alert() BEFORE submitting a form that pops one — a common silent block); close{tabId}. " +
        "GOVERNANCE: this can submit forms and send messages to the outside world. Respect do-not-contact and the human-approval rules exactly as for send_email — when in doubt, request_decision first. Never invent what a page said; snapshot and report what is actually there.",
      parametersSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...BROWSER_ACTIONS], description: "the browser action to perform" },
          tabId: { type: "string", description: "tab from a prior open (required for every action except open)" },
          url: { type: "string", description: "for open/navigate" },
          ref: { type: "string", description: "element ref [eN] from a snapshot (preferred for click/type)" },
          selector: { type: "string", description: "CSS selector alternative to ref for click/type" },
          text: { type: "string", description: "text to type" },
          pressEnter: { type: "boolean", description: "press Enter after typing" },
          key: { type: "string", description: "key name for press (e.g. Enter, Escape, Tab)" },
          direction: { type: "string", description: "up|down|left|right for scroll" },
          expression: { type: "string", description: "JS to run for evaluate" },
          screenshot: { type: "boolean", description: "include a screenshot with snapshot" },
          offset: { type: "integer", description: "paginate a large snapshot" },
          sessionKey: { type: "string", description: "optional cookie-session name for open (login persists within a session)" },
          waitMs: { type: "integer", description: "extra settle time after the action (ms, max 15000)" },
        },
        required: ["action"],
      },
    },
    async (params) => browserAct(params as Record<string, unknown>),
  );

  ctx.tools.register(
    "espo_list_emailless",
    {
      displayName: "Espo: list emailless venues",
      description: "List EspoCRM venue accounts missing an email but having a website (the enrichment work-list).",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const lim = Math.min(Number((params as { limit?: number }).limit) || 12, 40);
      const res = await espo.list("Account", { select: ["id", "name", "emailAddress", "website", "billingAddressState"], maxSize: 200 });
      const list = (res.list as Array<Record<string, unknown>>)
        .filter((a) => !String(a.emailAddress || "").trim() && String(a.website || "").trim())
        .slice(0, lim)
        .map((a) => ({ account_id: a.id, name: a.name, website: a.website, canton: a.billingAddressState }));
      return { content: JSON.stringify({ count: list.length, accounts: list }), data: { accounts: list } };
    },
  );

  ctx.tools.register(
    "espo_list_incomplete_location",
    {
      displayName: "Espo: list venues with an incomplete address",
      description: "The address-enrichment WORK-LIST: EspoCRM venue accounts missing any of street / postal code / city / canton. Website-having ones first (their address is easiest to find). Each row lists exactly what's `missing` and the values already known, so you only look up the gaps. This is a LIVE query — a filled account drops off automatically, so call it again for the next batch until it returns 0. Fill each with espo_update_account {account_id, street, postal_code, city, canton, evidence}. Default `limit` 12 (a batch); the total count of incomplete accounts is returned so you know how much remains.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" }, need: { type: "string", description: "optional focus: 'street' | 'postal_code' | 'city' | 'canton' — only return accounts missing THAT field" } } },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const p = params as { limit?: number; need?: string };
      const lim = Math.min(Number(p.limit) || 12, 40);
      // Espo caps a single list at maxSize 200 → page through so ALL accounts are scanned, not just the first 200.
      const sel = ["id", "name", "website", "billingAddressStreet", "billingAddressPostalCode", "billingAddressCity", "billingAddressState"];
      const rows: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < 5000; offset += 200) {
        const page = await espo.list("Account", { select: sel, maxSize: 200, offset });
        const batch = (page.list as Array<Record<string, unknown>>) || [];
        rows.push(...batch);
        if (batch.length < 200) break;
      }
      const res = { list: rows };
      const blank = (v: unknown) => !String(v ?? "").trim();
      const rowMissing = (a: Record<string, unknown>) => {
        const m: string[] = [];
        if (blank(a.billingAddressStreet)) m.push("street");
        if (blank(a.billingAddressPostalCode)) m.push("postal_code");
        if (blank(a.billingAddressCity)) m.push("city");
        if (blank(a.billingAddressState)) m.push("canton");
        return m;
      };
      const all = (res.list as Array<Record<string, unknown>>)
        .map((a) => ({ a, missing: rowMissing(a) }))
        .filter(({ missing }) => missing.length > 0)
        .filter(({ missing }) => (p.need ? missing.includes(String(p.need)) : true));
      const list = all
        .sort((x, y) => (String(y.a.website || "").trim() ? 1 : 0) - (String(x.a.website || "").trim() ? 1 : 0))
        .slice(0, lim)
        .map(({ a, missing }) => ({
          account_id: a.id, name: a.name, website: a.website || null, missing,
          street: a.billingAddressStreet || null, postal_code: a.billingAddressPostalCode || null,
          city: a.billingAddressCity || null, canton: a.billingAddressState || null,
        }));
      return { content: JSON.stringify({ returned: list.length, remaining_total: all.length, accounts: list }), data: { accounts: list, remaining_total: all.length } };
    },
  );

  ctx.tools.register(
    "crm_backfill_city",
    {
      displayName: "CRM: backfill empty City from Street (deterministic)",
      description: "DETERMINISTIC bulk fixer: fill every EspoCRM Account whose City is empty because an import put the town in the Street field. One call fixes ALL of them — no LLM, no per-row guessing, never overwrites a non-empty City. Use this instead of hand-filling city rows or delegating raw data-entry to a bulk agent. dry_run:true previews. Returns {emptyCity, filled, changes}.",
      parametersSchema: { type: "object", properties: { dry_run: { type: "boolean" } } },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const dry = Boolean((params as { dry_run?: boolean }).dry_run);
      const r = await selfHealCityFromStreet(espo, !dry);
      return {
        content: JSON.stringify({
          mode: dry ? "dry_run" : "applied",
          scanned: r.scanned, emptyCity: r.emptyCity, filled: r.filled, skipped: r.skipped,
          changes: r.changes.slice(0, 50),
        }),
        data: { filled: r.filled, emptyCity: r.emptyCity },
      };
    },
  );

  ctx.tools.register(
    "espo_set_email",
    {
      displayName: "Espo: write venue email",
      description:
        "Add an email to an EspoCRM Account without replacing its existing primary address. " +
        "verification_source=website requires the address to have been found on that Account's own site this run. " +
        "verification_source=crm_inbound requires evidence_email_id for a real inbound Espo email from that exact address, parented to that Account. " +
        "Both paths block cross-account or invented writes and are idempotent.",
      parametersSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          email: { type: "string" },
          verification_source: { type: "string", enum: ["website", "crm_inbound"], default: "website" },
          evidence_email_id: { type: "string", description: "required for crm_inbound" },
        },
        required: ["account_id", "email"],
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const { account_id, email, verification_source, evidence_email_id } = params as {
        account_id?: string;
        email?: string;
        verification_source?: "website" | "crm_inbound";
        evidence_email_id?: string;
      };
      const e = String(email || "").toLowerCase().trim();
      if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e)) return { content: JSON.stringify({ ok: false, error: "invalid email format" }) };
      let acct: Record<string, unknown>;
      try { acct = await espo.get("Account", String(account_id || "")); } catch { return { content: JSON.stringify({ ok: false, error: "account not found" }) }; }
      const source = verification_source || "website";
      if (source === "crm_inbound") {
        if (!evidence_email_id) {
          return { content: JSON.stringify({ ok: false, error: "evidence_email_id required for crm_inbound" }) };
        }
        let evidence: Record<string, unknown>;
        try { evidence = await espo.get("Email", String(evidence_email_id)); }
        catch { return { content: JSON.stringify({ ok: false, error: "evidence email not found" }) }; }
        const verified = verifyInboundEmailEvidence(evidence, String(account_id), e);
        if (!verified.ok) return { content: JSON.stringify({ ok: false, error: `REFUSED: ${verified.error}` }) };
      } else {
        const seen = fetchedByDomain.get(regDomain(String(acct.website || "")));
        if (!seen || !seen.has(e)) return { content: JSON.stringify({ ok: false, error: `REFUSED: ${e} was not found on this account's own site (${acct.website || "no website"}) this run` }) };
      }
      const merged = mergeEmailAddressData(acct.emailAddress, acct.emailAddressData, e);
      if (!merged.alreadyPresent) {
        await espo.update("Account", String(account_id), {
          emailAddress: merged.emailAddress,
          emailAddressData: merged.emailAddressData,
        });
      }
      const out = {
        ok: true,
        account_id,
        email: e,
        primary_email: merged.emailAddress,
        added_as: merged.emailAddress === e ? "primary" : "additional",
        already_present: merged.alreadyPresent,
        verification_source: source,
        evidence_email_id: source === "crm_inbound" ? evidence_email_id : undefined,
      };
      return { content: JSON.stringify(out), data: out };
    },
  );

  // ── Full Account read — the fields already captured in the CRM (cAnsprechpartner, cKategorie,
  // cChannel, cPrioritaet, cQuelle, industry, type, description, phone) that the narrow tools above
  // never surfaced. This is what a research/dossier step needs to ground personalization in reality
  // instead of just a venue name + category guess.
  ctx.tools.register(
    "espo_get_account",
    {
      displayName: "Espo: get venue account (full detail)",
      description:
        "Read the full EspoCRM record for one venue Account. Look it up by `account_id` (UUID) OR by `name` — pass the venue name when you don't have the id and it resolves the id for you (no REV-04 round-trip). Returns name, website, emailAddress, phoneNumber, address/canton, cAnsprechpartner (named contact), cKategorie, cChannel, cPrioritaet, cQuelle (source), industry, type, description, cVertriebsstatus, plus `candidates` if the name is ambiguous. Look this up before drafting/researching a venue — do not guess. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Account UUID (exact). If this isn't a UUID it's treated as a name search." },
          name: { type: "string", description: "OR the venue name to resolve to an id (fuzzy contains-match)." },
        },
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const { account_id, name } = params as { account_id?: string; name?: string };
      const shape = (a: Record<string, unknown>) => ({
        account_id: a.id, name: a.name, website: a.website, emailAddress: a.emailAddress, phoneNumber: a.phoneNumber,
        canton: a.billingAddressState, city: a.billingAddressCity, contact_person: a.cAnsprechpartner,
        category: a.cKategorie, channel: a.cChannel, priority: a.cPrioritaet, source: a.cQuelle,
        industry: a.industry, type: a.type, description: a.description, status: a.cVertriebsstatus,
      });
      try {
        // Exact id path
        if (account_id && isEspoRecordId(account_id)) {
          const a = await espo.get<Record<string, unknown>>("Account", String(account_id).trim());
          const out = shape(a);
          return { content: JSON.stringify(out), data: out };
        }
        // Name path — account_id may actually be a name, or `name` was passed
        const query = String(name || account_id || "").trim();
        if (!query) return { content: JSON.stringify({ error: "provide account_id (UUID) or name" }) };
        const res = await espo.list<Record<string, unknown>>("Account", {
          where: [{ type: "contains", attribute: "name", value: query }],
          select: ["id", "name", "website", "emailAddress", "phoneNumber", "billingAddressState", "billingAddressCity", "cAnsprechpartner", "cKategorie", "cChannel", "cPrioritaet", "cQuelle", "industry", "type", "description", "cVertriebsstatus"],
          maxSize: 10,
        });
        const rows = res.list || [];
        if (!rows.length) return { content: JSON.stringify({ error: `no account matches name '${query}'` }) };
        const exact = rows.find((a) => String(a.name || "").toLowerCase() === query.toLowerCase()) || rows[0];
        const out = shape(exact);
        const candidates = rows.length > 1 ? rows.map((a) => ({ account_id: a.id, name: a.name })) : undefined;
        return { content: JSON.stringify({ ...out, candidates }), data: { ...out, candidates } };
      } catch (e) {
        return { content: JSON.stringify({ error: `lookup failed: ${String(e).slice(0, 140)}` }) };
      }
    },
  );

  // ── Plan an optimized in-person visiting route to prospect venues (free: OpenStreetMap + OSRM). ──
  ctx.tools.register(
    "plan_visit_route",
    {
      displayName: "Plan in-person visit route",
      description:
        "Plan an optimized in-person driving route to visit prospect venues, starting & ending at an origin town (default Oberbuchsiten, where Alan lives). Geocodes CRM Account addresses via OpenStreetMap and optimizes the visiting order via OSRM. Use when Alan asks to 'plan a route to visit venues' or a day-trip. Returns ordered stops, total km + driving hours, and a Google Maps navigation link he opens on his phone. For a realistic day, filter with cantons (e.g. ['SO','BE']), maxStops (e.g. 8), and/or radiusKm.",
      parametersSchema: {
        type: "object",
        properties: {
          origin: { type: "string", description: "start & end town (default 'Oberbuchsiten')" },
          cantons: { type: "string", description: "comma-separated cantons to limit to, e.g. 'SO,BE'" },
          maxStops: { type: "number", description: "cap number of stops for a realistic day-trip (e.g. 8)" },
          radiusKm: { type: "number", description: "only include venues within this straight-line distance (km) of origin" },
          roundTrip: { type: "boolean", description: "return to origin at the end (default true)" },
        },
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const p = params as { origin?: string; cantons?: string; maxStops?: number; radiusKm?: number; roundTrip?: boolean };
      const originName = String(p.origin || "Oberbuchsiten").trim();
      const home = await geocodeCH(originName + ", Switzerland");
      if (!home) return { content: JSON.stringify({ error: `could not locate origin '${originName}'` }) };
      const wantCantons = String(p.cantons || "").split(/[,\s]+/).filter(Boolean).map(normCanton);
      const res = await espo.list<Record<string, unknown>>("Account", {
        select: ["name", "billingAddressStreet", "billingAddressPostalCode", "billingAddressCity", "billingAddressState", "website", "cVertriebsstatus"],
        maxSize: 200,
      });
      let rows = (res.list || []).filter((a) => a.billingAddressCity); // need at least a city to geocode
      if (wantCantons.length) rows = rows.filter((a) => wantCantons.includes(normCanton(String(a.billingAddressState || ""))));
      rows = rows.slice(0, 60); // safety cap on geocoding volume per call (cache makes repeats instant)
      const stops: Array<{ name: string; addr: string; web: string; status: string; lat: number; lon: number; km: number }> = [];
      for (const a of rows) {
        const addr = [a.billingAddressStreet, `${a.billingAddressPostalCode || ""} ${a.billingAddressCity || ""}`.trim(), "Switzerland"].filter((x) => x && String(x).trim()).join(", ");
        const ll = await geocodeCH(addr);
        if (!ll) continue;
        const km = haversineKm(home, ll);
        if (p.radiusKm && km > p.radiusKm) continue;
        stops.push({ name: String(a.name), addr, web: String(a.website || ""), status: String(a.cVertriebsstatus || ""), lat: ll[0], lon: ll[1], km: Math.round(km) });
      }
      stops.sort((x, y) => x.km - y.km);
      const chosen = p.maxStops ? stops.slice(0, p.maxStops) : stops;
      if (!chosen.length) return { content: JSON.stringify({ error: "no geocodable prospects matched the filters" }) };
      const coords = [home, ...chosen.map((s) => [s.lat, s.lon] as LatLon)].map((c) => `${c[1]},${c[0]}`).join(";");
      let ordered = chosen; let distKm: number | null = null; let durH: number | null = null;
      try {
        const rt = p.roundTrip === false ? "false" : "true";
        const o = (await (await fetch(`http://router.project-osrm.org/trip/v1/driving/${coords}?source=first&roundtrip=${rt}&overview=false`, { signal: AbortSignal.timeout(15000) })).json()) as { trips?: Array<{ distance: number; duration: number }>; waypoints?: Array<{ waypoint_index: number }> };
        if (o.trips?.length && o.waypoints) {
          distKm = Math.round(o.trips[0].distance / 100) / 10; durH = Math.round(o.trips[0].duration / 360) / 10;
          const seq = o.waypoints.map((w, i) => ({ i, pos: w.waypoint_index })).sort((a, b) => a.pos - b.pos);
          ordered = seq.filter((s) => s.i > 0).map((s) => chosen[s.i - 1]);
        }
      } catch { /* OSRM unavailable — keep nearest-first order, no route metrics */ }
      const gm = "https://www.google.com/maps/dir/" + encodeURIComponent(originName) + "/" +
        ordered.map((s) => encodeURIComponent(`${s.lat},${s.lon}`)).join("/") + (p.roundTrip === false ? "" : "/" + encodeURIComponent(originName));
      const out = {
        origin: originName,
        stops: ordered.map((s, i) => ({ n: i + 1, name: s.name, address: s.addr, km_from_home: s.km, status: s.status, website: s.web })),
        total_km: distKm, driving_hours: durH, google_maps_url: gm,
        note: `${ordered.length} stop(s)${p.maxStops ? ` (capped at ${p.maxStops})` : ""}. Give Alan the google_maps_url — he opens it on his phone for turn-by-turn.`,
      };
      return { content: JSON.stringify(out), data: out };
    },
  );

  // ── Durable, CRM-visible activity log — write research findings / draft summaries as a stream Note
  // on the Account so they persist in EspoCRM's own timeline (Alan sees them there natively), not only
  // as a Paperclip issue comment. Additive-only (Espo Notes have no delete path exposed here).
  ctx.tools.register(
    "espo_add_note",
    {
      displayName: "Espo: log a note on a venue",
      description:
        "Write a short activity note onto a venue Account's timeline in EspoCRM (e.g. research findings, or a summary of a drafted email). Visible natively in the CRM UI. Additive/audit-trail only — never used for outward sends.",
      parametersSchema: {
        type: "object",
        properties: { account_id: { type: "string" }, note: { type: "string", description: "plain text, keep under ~1000 chars" } },
        required: ["account_id", "note"],
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const { account_id, note } = params as { account_id?: string; note?: string };
      const text = String(note || "").trim().slice(0, 1000);
      if (!account_id || !text) return { content: JSON.stringify({ ok: false, error: "account_id and note required" }) };
      try {
        const created = await espo.create<{ id?: string }>("Note", {
          type: "Post", parentType: "Account", parentId: String(account_id), post: text,
        });
        return { content: JSON.stringify({ ok: true, note_id: created.id }), data: { ok: true, note_id: created.id } };
      } catch (e) {
        // The scoped API user currently lacks stream access on Account (parented posts 403) — an
        // EspoCRM role change only Alan can make. Fall back to a GLOBAL stream post prefixed with the
        // venue name so the note is still persisted in the CRM (just not on the Account's own
        // timeline) instead of the text being silently lost.
        if (/403|No create access/i.test(String(e))) {
          try {
            let label = String(account_id);
            try { label = String((await espo.get<{ name?: string }>("Account", String(account_id))).name || account_id); } catch { /* keep id */ }
            const created = await espo.create<{ id?: string }>("Note", { type: "Post", post: `[${label}] ${text}`.slice(0, 1000) });
            return {
              content: JSON.stringify({ ok: true, note_id: created.id, mode: "global-stream-fallback", warning: "no stream access on Account (403) — posted to the global stream instead; ask Alan to grant the CRM API user stream access for on-record notes" }),
              data: { ok: true, note_id: created.id, mode: "global-stream-fallback" },
            };
          } catch (e2) {
            return { content: JSON.stringify({ ok: false, error: `parented note 403 AND global fallback failed: ${String(e2).slice(0, 140)}` }) };
          }
        }
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  // ── Opportunity pipeline (the real EspoCRM object model — stage/amount/probability/closeDate —
  // currently 0 records; pipeline status has been approximated via the Account.cVertriebsstatus enum
  // instead). Additive: write real Opportunities without breaking anything that reads the enum today.
  ctx.tools.register(
    "espo_list_opportunities",
    {
      displayName: "Espo: list opportunities",
      description: "List EspoCRM Opportunity records (stage, amount, probability, closeDate, linked account). Read-only.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const lim = Math.min(Number((params as { limit?: number }).limit) || 50, 200);
      const res = await espo.list("Opportunity", { select: ["id", "name", "account", "stage", "amount", "probability", "closeDate"], maxSize: lim });
      return { content: JSON.stringify(res), data: res };
    },
  );

  ctx.tools.register(
    "espo_upsert_opportunity",
    {
      displayName: "Espo: create/update an opportunity",
      description:
        "Create or update the Opportunity for a venue deal (stage/amount/probability/closeDate). Pass opportunity_id to update an existing one, or account_id (+ name) to create a new one for that venue. Stage must be one of: signal,qualified,contacted,replied,booked,proposal,won,lost mapped to Espo's stage enum by the tool.",
      parametersSchema: {
        type: "object",
        properties: {
          opportunity_id: { type: "string" },
          account_id: { type: "string" },
          name: { type: "string" },
          stage: { type: "string", enum: ["signal", "qualified", "contacted", "replied", "booked", "proposal", "won", "lost"] },
          amount_chf: { type: "number" },
          close_date: { type: "string", description: "YYYY-MM-DD" },
          commercial_evidence: { type: "string", description: "Required when setting amount_chf or close_date: identify the quote, order, or confirmed timetable that supports the value." },
        },
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const p = params as { opportunity_id?: string; account_id?: string; name?: string; stage?: string; amount_chf?: number; close_date?: string; commercial_evidence?: string };
      if ((p.amount_chf != null || p.close_date) && String(p.commercial_evidence || "").trim().length < 12) {
        return {
          content: JSON.stringify({
            ok: false,
            error: "commercial_evidence is required before setting amount_chf or close_date; nominal amounts and guessed dates are forbidden",
          }),
        };
      }
      if (p.amount_chf != null && (!Number.isFinite(p.amount_chf) || p.amount_chf <= 0)) {
        return { content: JSON.stringify({ ok: false, error: "amount_chf must be a positive evidenced value" }) };
      }
      // Espo's real stage enum has only 6 values (Prospecting/Qualification/Proposal/Negotiation/Closed
      // Won/Closed Lost) — coarser than our 8-stage REV funnel, so several canon stages share an Espo
      // stage. We still set `probability` per OUR canon stage (the ADR-020 canonical weights * 100), so
      // the forecast formula (amount * probability/100) stays granular even though the stage label alone
      // would not be.
      const STAGE_MAP: Record<string, { stage: string; probability: number }> = {
        signal: { stage: "Prospecting", probability: 5 },
        qualified: { stage: "Qualification", probability: 15 },
        contacted: { stage: "Qualification", probability: 25 },
        replied: { stage: "Proposal", probability: 40 },
        booked: { stage: "Proposal", probability: 60 },
        proposal: { stage: "Negotiation", probability: 75 },
        won: { stage: "Closed Won", probability: 100 },
        lost: { stage: "Closed Lost", probability: 0 },
      };
      const attrs: Record<string, unknown> = {};
      if (p.stage) {
        const m = STAGE_MAP[p.stage];
        if (m) { attrs.stage = m.stage; attrs.probability = m.probability; } else { attrs.stage = p.stage; }
      }
      if (p.amount_chf != null) { attrs.amount = p.amount_chf; attrs.amountCurrency = "CHF"; }
      if (p.close_date) attrs.closeDate = p.close_date;
      try {
        if (p.opportunity_id) {
          await espo.update("Opportunity", String(p.opportunity_id), attrs);
          return { content: JSON.stringify({ ok: true, opportunity_id: p.opportunity_id }), data: { ok: true, opportunity_id: p.opportunity_id } };
        }
        if (!p.account_id) return { content: JSON.stringify({ ok: false, error: "opportunity_id or account_id required" }) };
        // DEDUP: an account should have ONE opportunity — find the existing one and UPDATE it, instead
        // of creating a duplicate that double-counts in espo_forecast. (Same rule as advanceOpportunity.)
        const existing = await espo.list<Record<string, unknown>>("Opportunity", {
          where: [{ type: "equals", attribute: "accountId", value: String(p.account_id) }],
          select: ["id", "stage"], orderBy: "createdAt", order: "desc", maxSize: 5,
        });
        const opp = (existing.list || [])[0];
        if (opp) {
          // Don't reopen a terminal deal on a bare upsert.
          if ((opp.stage === "Closed Won" || opp.stage === "Closed Lost") && !p.stage) {
            return { content: JSON.stringify({ ok: true, opportunity_id: opp.id, action: "terminal_unchanged" }), data: { ok: true, opportunity_id: opp.id } };
          }
          if (Object.keys(attrs).length) await espo.update("Opportunity", String(opp.id), attrs);
          return { content: JSON.stringify({ ok: true, opportunity_id: opp.id, action: "updated_existing" }), data: { ok: true, opportunity_id: opp.id } };
        }
        // No existing opportunity → create. Espo accepts nullable commercial fields. Never invent
        // an amount or close date: only set them when the caller supplies evidence-backed values.
        if (attrs.stage == null) { attrs.stage = "Qualification"; attrs.probability = 25; }
        const created = await espo.create<{ id?: string }>("Opportunity", { ...attrs, name: p.name || "Deal", accountId: p.account_id });
        return { content: JSON.stringify({ ok: true, opportunity_id: created.id, action: "created" }), data: { ok: true, opportunity_id: created.id } };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  // ── Read CRM emails — lets a drafting/booking agent pull the ACTUAL inbound mail it must answer
  // (previously agents could not see Email records at all; Alan had to paste mail text into tasks).
  // Read-only; body capped so one long thread can't blow the agent's context.
  ctx.tools.register(
    "espo_read_emails",
    {
      displayName: "Espo: read emails",
      description:
        "Search/list emails synced into EspoCRM (the company mailboxes). Filter with `search` (matches sender name/address or subject, case-insensitive) and `limit`. Returns from/to/date/subject/body excerpt + linked account. Use this to READ the actual mail you must answer — never reconstruct a mail from memory. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "sender name, address or subject fragment, e.g. 'Halter'" },
          limit: { type: "integer", description: "max results (default 5)" },
        },
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      const p = params as { search?: string; limit?: number };
      const lim = Math.min(Number(p.limit) || 5, 15);
      const q = String(p.search || "").trim().toLowerCase();
      // Espo's text-search where-clauses vary by version; filter client-side over the recent window
      // instead (deterministic, version-proof). 200 = Espo's page cap.
      const res = await espo.list<Record<string, unknown>>("Email", {
        select: ["id", "name", "fromString", "fromName", "to", "dateSent", "bodyPlain", "parentType", "parentId", "parentName"],
        orderBy: "dateSent", order: "desc", maxSize: 200,
      });
      const rows = res.list
        .filter((e) => {
          if (!q) return true;
          const hay = `${e.fromString || ""} ${e.fromName || ""} ${e.name || ""}`.toLowerCase();
          return hay.includes(q);
        })
        .slice(0, lim)
        .map((e) => ({
          email_id: e.id,
          from: e.fromString, from_name: e.fromName, to: e.to, date_sent: e.dateSent,
          subject: e.name,
          body: String(e.bodyPlain || "").replace(/\s+/g, " ").trim().slice(0, 2500),
          account: e.parentType === "Account" ? { id: e.parentId, name: e.parentName } : null,
        }));
      return { content: JSON.stringify({ count: rows.length, emails: rows }), data: { emails: rows } };
    },
  );

  // ── Create a meeting on Alan's calendar — REV-08 Meeting-Booker's effector. Creates an EspoCRM
  // Meeting (status Planned) assigned to Alan's user, so it appears in the CRM Calendar/Meetings.
  // INTERNAL ONLY: the record never emails anyone (the connector hard-refuses sendInvitations);
  // the human-facing "would this date work?" line goes in the DRAFT email that Alan approves+sends.
  const ALAN_ESPO_USER_ID = "6a3b607a33b6f5c55"; // Espo user 'admin' — Alan's human account (verified 2026-07-02)
  ctx.tools.register(
    "espo_create_meeting",
    {
      displayName: "Espo: create meeting (Alan's calendar)",
      description:
        "Create a PLANNED meeting on Alan's EspoCRM calendar only after the venue confirms the exact date in a real CRM email. Pass an exact confirmation_quote from that email. A request to propose dates is not confirmation. Test, placeholder, probe, or diagnostic meetings are refused. The record is internal and sends no invitation.",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. 'Tres Hermanos Vorstellung — Bürgenstock Resort'" },
          date_start: { type: "string", description: "YYYY-MM-DD HH:MM (Europe/Zurich)" },
          date_end: { type: "string", description: "YYYY-MM-DD HH:MM (Europe/Zurich); default = start + 1h" },
          account_id: { type: "string" },
          evidence_email_id: { type: "string", description: "Espo Email id that proves the real venue communication behind this meeting." },
          confirmation_quote: { type: "string", description: "Exact excerpt from the evidence email in which the venue confirms this specific date." },
          description: { type: "string" },
        },
        required: ["name", "date_start", "account_id", "evidence_email_id", "confirmation_quote"],
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const p = params as { name?: string; date_start?: string; date_end?: string; account_id?: string; evidence_email_id?: string; confirmation_quote?: string; description?: string };
      const writeGuard = validateMeetingWrite({
        name: p.name,
        accountId: p.account_id,
        evidenceEmailId: p.evidence_email_id,
        confirmationQuote: p.confirmation_quote,
      });
      if (!writeGuard.ok) return { content: JSON.stringify({ ok: false, error: writeGuard.error }) };
      try {
        const evidence = await espo.get<Record<string, unknown>>("Email", String(p.evidence_email_id).trim());
        const evidenceAccountId =
          evidence.parentType === "Account" ? String(evidence.parentId || "") : String(evidence.accountId || "");
        if (evidenceAccountId !== String(p.account_id).trim()) {
          return {
            content: JSON.stringify({
              ok: false,
              error: "REFUSED: evidence_email_id is not linked to the requested account_id",
            }),
          };
        }
        const evidenceBody = String(evidence.bodyPlain || evidence.body || "").replace(/\s+/g, " ").trim();
        const quote = String(p.confirmation_quote || "").replace(/\s+/g, " ").trim();
        if (!evidenceBody.toLocaleLowerCase().includes(quote.toLocaleLowerCase())) {
          return { content: JSON.stringify({ ok: false, error: "REFUSED: confirmation_quote was not found in the evidence email" }) };
        }
        if (!quoteMentionsMeetingDate(quote, String(p.date_start || ""))) {
          return { content: JSON.stringify({ ok: false, error: "REFUSED: confirmation_quote does not name the requested meeting date" }) };
        }
      } catch {
        return { content: JSON.stringify({ ok: false, error: "REFUSED: evidence_email_id was not found in EspoCRM" }) };
      }
      const parseLocal = (s: string): Date | null => {
        const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
        if (!m) return null;
        // Europe/Zurich offset: +2 in summer (CEST), +1 in winter (CET). Deterministic approximation
        // by month (Apr-Oct = +2) — good enough for meeting slots; verify in the calendar UI.
        const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
        const off = mo >= 4 && mo <= 10 ? 2 : 1;
        return new Date(Date.UTC(y, mo - 1, d, h - off, mi));
      };
      const start = parseLocal(String(p.date_start || ""));
      if (!start) return { content: JSON.stringify({ ok: false, error: "date_start must be 'YYYY-MM-DD HH:MM'" }) };
      const end = p.date_end ? parseLocal(String(p.date_end)) : new Date(start.getTime() + 3600_000);
      if (!end) return { content: JSON.stringify({ ok: false, error: "date_end must be 'YYYY-MM-DD HH:MM'" }) };
      const fmt = (dt: Date) => dt.toISOString().slice(0, 16).replace("T", " ") + ":00";
      try {
        const attrs: Record<string, unknown> = {
          name: String(p.name), status: "Planned",
          dateStart: fmt(start), dateEnd: fmt(end),
          assignedUserId: ALAN_ESPO_USER_ID,
          description: p.description ? String(p.description).slice(0, 1000) : undefined,
        };
        if (p.account_id) { attrs.parentType = "Account"; attrs.parentId = String(p.account_id); }
        // Idempotency: if a meeting already exists on this account at the same start time, REUSE it —
        // re-runs of the same task must never create a 2nd/3rd calendar record (owner rule 2026-07-06).
        if (p.account_id) {
          const ex = await espo.list<{ id: string; name?: string; dateStart?: string }>("Meeting", {
            where: [{ type: "equals", attribute: "accountId", value: String(p.account_id) }],
            select: ["id", "name", "dateStart"], maxSize: 30,
          });
          const dup = (ex.list || []).find((m) => String(m.dateStart || "").slice(0, 16) === fmt(start).slice(0, 16));
          if (dup) {
            let dupOpp: Record<string, unknown> | null = null;
            try { dupOpp = await advanceOpportunity(String(p.account_id), "booked", `${String(p.name)}`); } catch { /* best-effort */ }
            return { content: JSON.stringify({ ok: true, created: false, already_exists: true, meeting_id: dup.id, name: dup.name, opportunity: dupOpp, note: "a meeting already exists on this account at this time — reused, not duplicated" }), data: { meeting_id: dup.id, created: false, opportunity: dupOpp } };
          }
        }
        const created = await espo.create<{ id?: string }>("Meeting", attrs);
        // Pipeline: a booked meeting is a strong signal — advance the venue's deal to "booked"
        // (best-effort; never fails the meeting creation).
        let opportunity: Record<string, unknown> | null = null;
        if (p.account_id) {
          try { opportunity = await advanceOpportunity(String(p.account_id), "booked", `${String(p.name)}`); }
          catch (e) { opportunity = { ok: false, error: String(e).slice(0, 120) }; }
        }
        return {
          content: JSON.stringify({ ok: true, meeting_id: created.id, planned: `${p.date_start} Europe/Zurich`, opportunity, note: "internal calendar record only — no invitation was sent; the date proposal belongs in the human-approved draft" }),
          data: { ok: true, meeting_id: created.id, opportunity },
        };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  // ── Deterministic forecast — PURE FORMULA, never an LLM (ADR: the LLM interprets, never computes).
  // Prefers real Opportunity records; falls back to inferring a stage from Account.cVertriebsstatus so
  // it produces a real number from day one (before any Opportunity has been created).
  ctx.tools.register(
    "espo_forecast",
    {
      displayName: "Espo: stage-weighted CHF forecast (deterministic)",
      description:
        "Compute the stage-weighted pipeline forecast in CHF — a pure formula (never LLM-estimated), auditable and reproducible. Uses real Opportunity amount/stage when available; otherwise infers a rough stage from each Account's cVertriebsstatus. Read-only.",
      parametersSchema: { type: "object", properties: {} },
    },
    async () => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ error: "no Espo config" }) };
      // formula: forecast = Σ(amountᵢ × probabilityᵢ / 100) — 02b-interaction-model.md's stage-weighted
      // forecast, using Espo's own `probability` field directly (set per-canon-stage by
      // espo_upsert_opportunity) rather than reverse-mapping Espo's coarser 6-value stage enum.
      const opps = await espo.list<Record<string, unknown>>("Opportunity", { select: ["id", "account", "stage", "amount", "probability"], maxSize: 200 });
      let total = 0;
      const perDeal: Array<{ id: unknown; account: unknown; stage: unknown; weighted_chf: number }> = [];
      const coveredAccounts = new Set<string>();
      for (const o of opps.list) {
        const prob = Number(o.probability ?? 0) / 100;
        const weighted = Math.round(Number(o.amount || 0) * prob);
        total += weighted;
        perDeal.push({ id: o.id, account: o.account, stage: o.stage, weighted_chf: weighted });
        if (o.account) coveredAccounts.add(String((o.account as { id?: string })?.id || o.account));
      }
      // Fallback: rough estimate for accounts with no Opportunity yet, from cVertriebsstatus, amount unknown -> 0.
      // Surfaced separately so it's never confused with a real, amount-backed number.
      const accts = await espo.list<Record<string, unknown>>("Account", { select: ["id", "cVertriebsstatus"], maxSize: 500 });
      const uncovered_by_status: Record<string, number> = {};
      for (const a of accts.list) {
        if (coveredAccounts.has(String(a.id))) continue;
        const st = String(a.cVertriebsstatus || "unset");
        uncovered_by_status[st] = (uncovered_by_status[st] || 0) + 1;
      }
      const out = { total_weighted_chf: total, opportunity_count: opps.list.length, per_deal: perDeal, accounts_without_opportunity_by_status: uncovered_by_status, note: opps.list.length === 0 ? "no Opportunity records yet — total is 0; see accounts_without_opportunity_by_status for pipeline shape without CHF amounts" : undefined };
      return { content: JSON.stringify(out), data: out };
    },
  );

  // Native self-reminder: sets the issue's monitor timer; when it fires, the
  // heartbeat scheduler WAKES the issue's assignee (server-side, survives
  // restarts). Replaces ad-hoc "retry in 7 days" promises that nothing enforced.
  ctx.tools.register(
    "schedule_followup",
    {
      displayName: "Schedule follow-up (self-reminder)",
      description:
        "Set a follow-up timer on a task (defaults to YOUR current task). At the given time Paperclip wakes the task's assignee to act on it. Use whenever your plan says 'check/retry/verify later' — e.g. 'retry unreachable site in 7 days', 'check delivery in 5 days', 'venue said call back next week'. The note is the instruction future-you will read.",
      parametersSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "days from now (0.05\u201360), e.g. 5 or 0.25 for ~6h" },
          note: { type: "string", description: "what to do when woken (be specific: venue, action, context)" },
          issue_id: { type: "string", description: "optional other task id; defaults to the task you are working on" },
        },
        required: ["days", "note"],
      },
    },
    async (p, runCtx) => {
      const days = Number((p as { days?: unknown }).days);
      if (!Number.isFinite(days) || days < 0.05 || days > 60) {
        return { content: JSON.stringify({ ok: false, error: "days must be between 0.05 and 60" }) };
      }
      const issueId = String((p as { issue_id?: unknown }).issue_id || (runCtx as { issueId?: string }).issueId || "");
      if (!issueId) return { content: JSON.stringify({ ok: false, error: "no task in scope \u2014 pass issue_id" }) };
      const note = String((p as { note?: unknown }).note || "").slice(0, 500);
      const at = new Date(Date.now() + days * 86_400_000);
      try {
        // Dates don't survive the worker→host JSON-RPC boundary (serialized to
        // string, host then calls .toISOString on it), so write the monitor
        // columns directly — same trusted sql path the eval tools use. Scoped
        // by company_id so a bad issue_id can never touch another company.
        if (!deps.getSql) return { content: JSON.stringify({ ok: false, error: "sql unavailable (databaseUrl not configured)" }) };
        const sql = await deps.getSql();
        const rows = (await sql`
          update issues set monitor_next_check_at = ${at.toISOString()}::timestamptz,
            monitor_notes = ${note}, monitor_scheduled_by = 'agent'
          where id = ${issueId} and company_id = ${runCtx.companyId}
          returning id`) as Array<{ id: string }>;
        if (!rows.length) return { content: JSON.stringify({ ok: false, error: "task not found in this company" }) };
        const out = { ok: true, issue_id: issueId, wake_at: at.toISOString(), note };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  // Zefix (Swiss commercial register) prospect search — migrated from the legacy
  // Hermes agent's browser workflow. The official PublicREST API 401s without a
  // registered account, but the zefix.ch web JSON endpoint is open; this tool
  // uses it directly (no browser, deterministic, UID-deduped across terms).
  ctx.tools.register(
    "zefix_search",
    {
      displayName: "Zefix: Swiss commercial register search",
      description:
        "Search the Swiss commercial register (zefix.ch) for companies by name terms. Pass several overlapping terms (e.g. ['Zigarren','Tabak','Cigar','Humidor']) — results are deduplicated by UID. Returns name, seat, legal form, UID, status. Use for prospecting and company verification. Read-only public data; apply the do-not-contact rules to the OUTPUT before proposing outreach.",
      parametersSchema: {
        type: "object",
        properties: {
          terms: { type: "array", items: { type: "string" }, description: "search terms (broad, not exact) — max 8" },
          max_per_term: { type: "integer", description: "max results per term (default 40, cap 100)" },
        },
        required: ["terms"],
      },
    },
    async (params) => {
      const p = params as { terms?: unknown; max_per_term?: unknown };
      const terms = (Array.isArray(p.terms) ? p.terms : [p.terms]).map((t) => String(t || "").trim()).filter(Boolean).slice(0, 8);
      if (!terms.length) return { content: JSON.stringify({ ok: false, error: "pass at least one search term" }) };
      const maxN = Math.min(Math.max(Number(p.max_per_term) || 40, 1), 100);
      // Official mapping from GET zefix.ch/ZefixREST/api/v1/legalForm.json (2026-07-02)
      const LEGAL: Record<number, string> = { 1: "Einzelunternehmen", 2: "Kollektivgesellschaft", 3: "AG", 4: "GmbH", 5: "Genossenschaft", 6: "Verein", 7: "Stiftung", 8: "Institut öff. Rechts", 9: "Zweigniederlassung", 10: "Kommanditgesellschaft", 11: "Zweigniederlassung ausl.", 12: "Kommanditaktiengesellschaft" };
      const seen = new Map<string, Record<string, unknown>>();
      const perTerm: Record<string, number> = {};
      for (const term of terms) {
        try {
          const res = await fetch("https://www.zefix.ch/ZefixREST/api/v1/firm/search.json", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (ck-office prospecting)" },
            body: JSON.stringify({ name: term, languageKey: "de", maxEntries: maxN, offset: 0, activeOnly: true }),
          });
          if (!res.ok) { perTerm[term] = -res.status; continue; }
          const rows = ((await res.json()) as { list?: Array<Record<string, unknown>> }).list || [];
          perTerm[term] = rows.length;
          for (const c of rows) {
            const uid = String(c.uidFormatted || c.name || "");
            if (!seen.has(uid)) {
              seen.set(uid, {
                name: c.name,
                seat: c.legalSeat,
                legal_form: LEGAL[Number(c.legalFormId)] || c.legalFormId,
                uid,
                status: c.status,
              });
            }
          }
        } catch (e) {
          perTerm[term] = -1;
        }
      }
      const out = { ok: true, hits_per_term: perTerm, unique_companies: seen.size, companies: [...seen.values()] };
      return { content: JSON.stringify(out), data: out };
    },
  );

  // ── The deterministic find→enrich engine (the money-loop input, done as CODE not judgment). ──
  // `mode:"enrich"` fills missing street/PLZ on venue Accounts from search.ch + own website, GATED so
  // it never writes an unverified address, and returns the RESIDUAL it couldn't verify — that residual
  // (+ the missing contact person) is the only thing left for the judgment agent (REV-04) to work.
  // `mode:"find"` sweeps Zefix for new tobacco/cigar retailers and dedup-creates them.
  ctx.tools.register(
    "find_and_enrich_prospects",
    {
      displayName: "Find + enrich prospect Accounts (deterministic)",
      description:
        "The deterministic engine for the prospect list. mode:\"enrich\" (default) — for venue Accounts missing a street, fill street+PLZ from the search.ch business directory (structured vCard) and, failing that, the account's OWN website (Impressum/Kontakt). NEVER guesses: the found town must equal the account's known city AND the directory name must pass an identity gate, so a wrong address is impossible; each fill leaves an evidence Note. Returns {enriched, residual} — `residual` is the work-list the scripts couldn't verify (needs a human/agent to read the site or find the contact person). mode:\"find\" — sweep Zefix for tobacco/cigar retailers by the given `terms` and dedup-create the new ones (do-not-contact enforced). Idempotent; complete accounts are skipped. Free (no API key). search.ch has a daily quota — enrich in batches (`limit`).",
      parametersSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["enrich", "find"], description: "enrich (default): fill addresses. find: sweep Zefix for new prospects." },
          limit: { type: "integer", description: "enrich: max accounts this batch (default 20, cap 60). Call again for the next batch until residual-with-more=0." },
          terms: { type: "array", items: { type: "string" }, description: "find: Zefix search terms, e.g. ['Zigarren','Tabak','Cigar'] (max 8)" },
        },
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const p = params as { mode?: string; limit?: number; terms?: unknown };
      const mode = p.mode === "find" ? "find" : "enrich";

      if (mode === "enrich") {
        const limit = Math.min(Math.max(Number(p.limit) || 20, 1), 60);
        type Acct = { id: string; name?: string; website?: string; billingAddressStreet?: string; billingAddressPostalCode?: string; billingAddressCity?: string };
        // pull incomplete accounts (missing street) that HAVE a city; website-having first
        const all: Acct[] = [];
        for (let off = 0; ; off += 200) {
          const page = await espo.list<Acct>("Account", { select: ["id", "name", "website", "billingAddressStreet", "billingAddressPostalCode", "billingAddressCity"], maxSize: 200, offset: off });
          const rows = page.list || [];
          all.push(...rows);
          if (rows.length < 200) break;
        }
        const blankv = (v: unknown) => !String(v ?? "").trim();
        const DNC = [/suvretta/i, /davidoff/i, /patoro/i, /zigarren\s*d(ü|ue?)rr/i, /cohiba/i, /cuaba/i];
        // Learn the set of real Swiss towns from the towns already in the CRM (free, no external DB) —
        // used to derive a missing city when the town is literally in the venue's own name.
        const townMap = new Map<string, string>();
        for (const a of all) { const c = String(a.billingAddressCity || "").trim(); const n = normTownE(c); if (n.length >= 4 && !townMap.has(n)) townMap.set(n, c); }
        const knownTowns = [...townMap.entries()].map(([norm, canonical]) => ({ norm, canonical }));
        // incomplete = missing a street OR missing a city (the city-less ones the finder left behind)
        const todo = all.filter((a) => (blankv(a.billingAddressStreet) || blankv(a.billingAddressCity)) && !DNC.some((r) => r.test(a.name || "")));
        const batch = todo.slice(0, limit);
        const enriched: Array<Record<string, string>> = [];
        const residual: Array<Record<string, string>> = [];
        for (const a of batch) {
          let city = a.billingAddressCity || "";
          const patch: Record<string, string> = {};
          let found: FoundAddr | { err: string } | null = null;
          // 1) if the city is missing, DERIVE it first — never guess it. Cheapest source: a known CRM
          //    town appearing verbatim in the venue's OWN name (e.g. "…Schaffhausen"); then own-site/Zefix.
          if (blankv(city)) {
            const nn = normTownE(a.name || "");
            const hit = knownTowns.find((t) => nn.includes(t.norm));
            if (hit) {
              city = hit.canonical;
              patch.billingAddressCity = city.slice(0, 100);
            } else {
              const d = await deriveCity(a.name || "", a.website);
              if ("err" in d) { residual.push({ account_id: a.id, name: a.name || "", city: "", reason: d.err }); continue; }
              city = d.town;
              patch.billingAddressCity = city.slice(0, 100);
              if (d.street) found = d; // the deriving source often gives the full address too
            }
          }
          // 2) fill the street via the gated path if still missing
          if (blankv(a.billingAddressStreet)) {
            if (!found || !("street" in found) || !found.street) found = await verifiedAddress(a.name || "", city, a.website);
            if (!("err" in found)) {
              if (found.street) patch.billingAddressStreet = found.street.slice(0, 250);
              if (blankv(a.billingAddressPostalCode) && found.zip) patch.billingAddressPostalCode = found.zip;
            }
          }
          if (!Object.keys(patch).length) {
            residual.push({ account_id: a.id, name: a.name || "", city, reason: found && "err" in found ? found.err : "nothing-new" });
            continue;
          }
          const src = found && !("err" in found) ? found.src : "derive";
          const ref = found && !("err" in found) ? found.ref : "";
          try {
            await espo.update("Account", a.id, patch);
            await espo.create("Note", { type: "Post", parentType: "Account", parentId: a.id, post: `📍 Adresse ergänzt (${Object.keys(patch).map((k) => k.replace("billingAddress", "")).join(", ")}) — Quelle: ${src}${ref ? ` (${ref.slice(0, 200)})` : ""}` }).catch(() => undefined);
            enriched.push({ account_id: a.id, name: a.name || "", city: patch.billingAddressCity || city, street: patch.billingAddressStreet || "", plz: patch.billingAddressPostalCode || "", src });
          } catch (e) {
            residual.push({ account_id: a.id, name: a.name || "", city, reason: "write-error:" + String(e).slice(0, 60) });
          }
        }
        const out = { ok: true, mode, missing_total: todo.length, batch: batch.length, enriched, residual, more: Math.max(0, todo.length - batch.length) };
        return { content: JSON.stringify(out), data: out };
      }

      // mode === "find": Zefix sweep + purpose-gated dedup-create
      const terms = (Array.isArray(p.terms) ? p.terms : [p.terms]).map((t) => String(t || "").trim()).filter(Boolean).slice(0, 8);
      if (!terms.length) return { content: JSON.stringify({ ok: false, error: "find mode needs `terms`, e.g. ['Zigarren','Tabak','Cigar']" }) };
      const DNC = [/suvretta/i, /davidoff/i, /patoro/i, /zigarren\s*d(ü|ue?)rr/i, /cohiba/i, /cuaba/i, /villiger/i, /oettinger/i];
      const PURPOSE = /tabak|zigarr|cigar|cigarr|zigarett|raucher|humidor|tobacco/i;
      const seen = new Map<string, { name: string; uid: string; ehraid?: number; seat?: string }>();
      for (const term of terms) {
        try {
          const res = await fetch("https://www.zefix.ch/ZefixREST/api/v1/firm/search.json", {
            method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (ck-office prospecting)" },
            body: JSON.stringify({ name: term, languageKey: "de", maxEntries: 40, offset: 0, activeOnly: true }),
          });
          if (!res.ok) continue;
          for (const c of (((await res.json()) as { list?: Array<Record<string, unknown>> }).list || [])) {
            const uid = String(c.uidFormatted || "");
            if (uid && !seen.has(uid)) seen.set(uid, { name: String(c.name || ""), uid, ehraid: Number(c.ehraid) || undefined, seat: String(c.legalSeat || "") });
          }
        } catch { /* skip term */ }
      }
      const created: Array<Record<string, string>> = [];
      let skipped = 0;
      for (const f of seen.values()) {
        if (!f.name || DNC.some((r) => r.test(f.name))) { skipped++; continue; }
        // precision gate: the register PURPOSE (Zweck) must mention tobacco/cigars (drops surname hits)
        let purposeOk = false;
        if (f.ehraid) {
          try {
            const d = await fetch(`https://www.zefix.ch/ZefixREST/api/v1/firm/${f.ehraid}.json`, { headers: { "User-Agent": "Mozilla/5.0 (ck-office prospecting)" }, signal: AbortSignal.timeout(12000) });
            if (d.ok) { const dj = await d.json() as { purpose?: string }; purposeOk = PURPOSE.test(String(dj.purpose || "")); }
          } catch { /* leave false */ }
        }
        if (!purposeOk) { skipped++; continue; }
        // dedup by UID, then create (mirrors espo_create_account)
        try {
          const ex = await espo.list<{ id: string; name: string }>("Account", { where: [{ type: "contains", attribute: "description", value: f.uid }], select: ["id", "name"], maxSize: 3 });
          if ((ex.list || []).length) { skipped++; continue; }
          const acct = await espo.create<{ id?: string }>("Account", {
            name: f.name.slice(0, 150), ...(f.seat ? { billingAddressCity: f.seat } : {}),
            cVertriebsstatus: "Noch offen", description: `Prospect from Zefix sweep. UID: ${f.uid}. Source: Zefix ${f.uid}`,
          });
          created.push({ account_id: acct.id || "", name: f.name, uid: f.uid });
        } catch { skipped++; }
      }
      const out = { ok: true, mode, zefix_unique: seen.size, created, skipped };
      return { content: JSON.stringify(out), data: out };
    },
  );

  // ── Gap-fill batch (owner-approved 2026-07-03): call logging, CRM tasks,
  //    guarded account updates, finance events, and the send approval gate. ──

  ctx.tools.register(
    "espo_log_call",
    {
      displayName: "Espo: log/plan a phone call",
      description:
        "Record a phone call on Alan's CRM calendar — either a call that HAPPENED (status Held, with the outcome in notes) or one to PLAN (status Planned). Times in Swiss local time. Links the venue when account_id is given. Use after Alan reports a call, or when scheduling a call block.",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. '\ud83d\udcde Gostony — Erstkontakt'" },
          when: { type: "string", description: "YYYY-MM-DD HH:MM Europe/Zurich (default: now)" },
          minutes: { type: "integer", description: "duration, default 15" },
          status: { type: "string", enum: ["Held", "Planned"], description: "Held = already happened (default), Planned = future" },
          account_id: { type: "string" },
          notes: { type: "string", description: "outcome / agenda" },
        },
        required: ["name"],
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const p = params as { name?: string; when?: string; minutes?: number; status?: string; account_id?: string; notes?: string };
      const parseLocal = (s: string): Date | null => {
        const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
        if (!m) return null;
        const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
        const off = mo >= 4 && mo <= 10 ? 2 : 1;
        return new Date(Date.UTC(y, mo - 1, d, h - off, mi));
      };
      const start = p.when ? parseLocal(p.when) : new Date();
      if (!start) return { content: JSON.stringify({ ok: false, error: "when must be YYYY-MM-DD HH:MM (Swiss time)" }) };
      const mins = Math.min(Math.max(Number(p.minutes) || 15, 5), 240);
      const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
      try {
        if (p.account_id) {
          const ex = await espo.list<{ id: string; name?: string; dateStart?: string }>("Call", { where: [{ type: "equals", attribute: "accountId", value: String(p.account_id) }], select: ["id", "name", "dateStart"], maxSize: 30 });
          const dup = (ex.list || []).find((c) => String(c.dateStart || "").slice(0, 16) === fmt(start).slice(0, 16) && String(c.name || "").trim() === String(p.name || "").trim());
          if (dup) return { content: JSON.stringify({ ok: true, created: false, already_exists: true, call_id: dup.id, note: "identical call already logged — reused, not duplicated" }), data: { call_id: dup.id, created: false } };
        }
        const call = await espo.create<{ id?: string }>("Call", {
          name: String(p.name).slice(0, 150),
          status: p.status === "Planned" ? "Planned" : "Held",
          dateStart: fmt(start),
          dateEnd: fmt(new Date(start.getTime() + mins * 60_000)),
          assignedUserId: ALAN_ESPO_USER_ID,
          ...(p.account_id ? { parentType: "Account", parentId: String(p.account_id) } : {}),
          ...(p.notes ? { description: String(p.notes).slice(0, 3000) } : {}),
        });
        const out = { ok: true, call_id: call.id, status: p.status === "Planned" ? "Planned" : "Held" };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  ctx.tools.register(
    "espo_create_crm_task",
    {
      displayName: "Espo: create a CRM task for Alan",
      description:
        "Create a CRM Task on Alan's list (shows in the CRM calendar/activities): a concrete to-do with a due date, e.g. 'Send catalog to X after call'. Swiss local time. Link the venue via account_id when known. NOT for agent-to-agent work (use create_task for that).",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          due: { type: "string", description: "YYYY-MM-DD or YYYY-MM-DD HH:MM (Europe/Zurich)" },
          account_id: { type: "string" },
          notes: { type: "string" },
        },
        required: ["name", "due"],
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const p = params as { name?: string; due?: string; account_id?: string; notes?: string };
      const raw = String(p.due || "").trim();
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
      if (!m) return { content: JSON.stringify({ ok: false, error: "due must be YYYY-MM-DD [HH:MM] (Swiss time)" }) };
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const off = mo >= 4 && mo <= 10 ? 2 : 1;
      const due = m[4]
        ? new Date(Date.UTC(y, mo - 1, d, Number(m[4]) - off, Number(m[5])))
        : new Date(Date.UTC(y, mo - 1, d, 17 - off, 0)); // date-only → 17:00 Swiss
      try {
        if (p.account_id) {
          const dueStr = due.toISOString().slice(0, 10);
          const ex = await espo.list<{ id: string; name?: string; dateEnd?: string; status?: string }>("Task", { where: [{ type: "equals", attribute: "accountId", value: String(p.account_id) }], select: ["id", "name", "dateEnd", "status"], maxSize: 30 });
          const dup = (ex.list || []).find((t) => String(t.name || "").trim().toLowerCase() === String(p.name || "").trim().toLowerCase() && String(t.dateEnd || "").slice(0, 10) === dueStr && t.status !== "Completed");
          if (dup) return { content: JSON.stringify({ ok: true, created: false, already_exists: true, task_id: dup.id, note: "identical open CRM task already exists — reused, not duplicated" }), data: { task_id: dup.id, created: false } };
        }
        const task = await espo.create<{ id?: string }>("Task", {
          name: String(p.name).slice(0, 150),
          status: "Not Started",
          dateEnd: due.toISOString().slice(0, 19).replace("T", " "),
          assignedUserId: ALAN_ESPO_USER_ID,
          ...(p.account_id ? { parentType: "Account", parentId: String(p.account_id) } : {}),
          ...(p.notes ? { description: String(p.notes).slice(0, 3000) } : {}),
        });
        const out = { ok: true, task_id: task.id };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  ctx.tools.register(
    "espo_update_account",
    {
      displayName: "Espo: update account contact data (guarded)",
      description:
        "Fix/fill a venue Account's contact + location data when research proves it. Fields: website, phone, street, city, canton (Kanton, e.g. ZH/BE/VD), postal_code. Email is NOT here (espo_set_email owns it). Use this to BACKFILL a missing city or canton too. Always say WHAT changed and the EVIDENCE.",
      parametersSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          website: { type: "string" },
          phone: { type: "string" },
          street: { type: "string" },
          city: { type: "string" },
          canton: { type: "string", description: "Swiss canton / Kanton — 2-letter (ZH, BE, VD, TI…) or full name (it's normalized)" },
          postal_code: { type: "string" },
          evidence: { type: "string", description: "where the new value was verified (URL/source) — required" },
        },
        required: ["account_id", "evidence"],
      },
    },
    async (params) => {
      const espo = await deps.getEspo();
      if (!espo) return { content: JSON.stringify({ ok: false, error: "no Espo config" }) };
      const p = params as Record<string, string | undefined>;
      const MAP: Record<string, string> = { website: "website", phone: "phoneNumber", street: "billingAddressStreet", city: "billingAddressCity", postal_code: "billingAddressPostalCode" };
      const patch: Record<string, string> = {};
      for (const [ours, theirs] of Object.entries(MAP)) {
        const v = p[ours];
        if (typeof v === "string" && v.trim()) patch[theirs] = v.trim().slice(0, 250);
      }
      if (typeof p.canton === "string" && p.canton.trim()) patch["billingAddressState"] = normCanton(p.canton);
      if (!Object.keys(patch).length) return { content: JSON.stringify({ ok: false, error: "nothing to update — pass website/phone/street/city/canton/postal_code" }) };
      if (!String(p.evidence || "").trim()) return { content: JSON.stringify({ ok: false, error: "evidence required" }) };
      // Street guard (same rule the deterministic enricher uses) — a free-typed street must look like a
      // real street, and must NOT silently relocate an account to a different town. Blocks invented addresses.
      if (patch.billingAddressStreet) {
        let knownCity = String(p.city || "").trim();
        if (!knownCity) {
          try { knownCity = String((await espo.get<{ billingAddressCity?: string }>("Account", String(p.account_id))).billingAddressCity || ""); } catch { /* ignore */ }
        }
        if (!validStreetE(patch.billingAddressStreet, knownCity)) {
          return { content: JSON.stringify({ ok: false, error: `street rejected: '${patch.billingAddressStreet}' needs a house number or a street-type (…strasse/gasse/platz/…) and must not just repeat the town. Use find_and_enrich_prospects for a verified address instead of typing one.` }) };
        }
      }
      try {
        await espo.update("Account", String(p.account_id), patch);
        await espo.create("Note", {
          type: "Post",
          parentType: "Account",
          parentId: String(p.account_id),
          post: `\ud83d\udd27 Kontaktdaten aktualisiert (${Object.keys(patch).join(", ")}) — Beleg: ${String(p.evidence).slice(0, 300)}`,
        }).catch(() => undefined);
        const out = { ok: true, updated: Object.keys(patch) };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );

  ctx.tools.register(
    "record_finance_event",
    {
      displayName: "Record a finance event (CHF, the money scoreboard)",
      description:
        "Log real money on the company scoreboard: revenue that arrived (direction credit) or an external cost paid (debit). Amount in CHF. ONLY for real, evidenced money movements (an order paid, a commission received, a subscription paid) — never forecasts. Shows against agent spend in the Costs page.",
      parametersSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["credit", "debit"], description: "credit = money IN, debit = money OUT" },
          amount_chf: { type: "number" },
          biller: { type: "string", description: "source/counterparty, e.g. 'divino-shop', 'th-commission'" },
          description: { type: "string", description: "what this money is — reference the order/deal" },
        },
        required: ["direction", "amount_chf", "biller", "description"],
      },
    },
    async (params, runCtx) => {
      const p = params as { direction?: string; amount_chf?: number; biller?: string; description?: string };
      const cents = Math.round(Number(p.amount_chf) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > 10_000_000) {
        return { content: JSON.stringify({ ok: false, error: "amount_chf must be 0.01–100000" }) };
      }
      if (p.direction !== "credit" && p.direction !== "debit") {
        return { content: JSON.stringify({ ok: false, error: "direction must be credit (in) or debit (out)" }) };
      }
      const biller = String(p.biller).slice(0, 100);
      const description = String(p.description).slice(0, 480);
      const base = `http://127.0.0.1:3100/api/companies/${runCtx.companyId}/finance-events`;
      try {
        // IDEMPOTENCY: a re-run / retry / concurrency-race must not double-post real CHF.
        // Skip if an identical event (same direction+amount+biller+description) already exists
        // in the last 3 days — mirrors the exact-match dedup in espo_log_call / espo_create_crm_task.
        try {
          const listRes = await fetch(`${base}?limit=100`, { headers: { "Content-Type": "application/json" } });
          if (listRes.ok) {
            const rows = JSON.parse(await listRes.text());
            const list = (Array.isArray(rows) ? rows : rows.events || rows.data || rows.list || []) as Array<Record<string, unknown>>;
            const cutoff = Date.now() - 3 * 86_400_000;
            const dup = list.find((e) =>
              String(e.direction) === p.direction &&
              Number(e.amountCents) === cents &&
              String(e.biller || "") === biller &&
              String(e.description || "") === description &&
              new Date(String(e.occurredAt || e.createdAt || 0)).getTime() >= cutoff);
            if (dup) {
              const out = { ok: true, deduped: true, finance_event_id: dup.id, chf: cents / 100, direction: p.direction };
              return { content: JSON.stringify(out), data: out };
            }
          }
        } catch { /* dedup pre-check is best-effort; fall through to create */ }
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventKind: "manual_adjustment",
            direction: p.direction,
            amountCents: cents,
            currency: "CHF",
            biller,
            description,
            agentId: runCtx.agentId,
            occurredAt: new Date().toISOString(),
          }),
        });
        const body = await res.text();
        if (!res.ok) return { content: JSON.stringify({ ok: false, error: `finance API ${res.status}: ${body.slice(0, 140)}` }) };
        const ev = JSON.parse(body);
        const out = { ok: true, finance_event_id: ev.id, chf: cents / 100, direction: p.direction };
        return { content: JSON.stringify(out), data: out };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: String(e).slice(0, 180) }) };
      }
    },
  );
}
