import type { AccountRow, CcrotateTarget } from "./types.js";

// ─── ccrotate when parser ────────────────────────────────────────────────────
//
// `ccrotate when` text format (one row per saved account):
//
//   Cache: 1min old
//
//   ★ ✓ 🟢 ramadan@blockcast.net          base       5h:64% 7d:22%   usable now
//     ✓ 🤌 omar.ramadan@berkeley.edu      extra      5h:100% 7d:63%  api cooldown … · 429 unknown  api: …
//     ✓ 🔴 omar@blockcast.net             exhausted  5h:0% 7d:100%   stale (needs /login + snap)
//
// Columns: active-marker (★ or space) · health (✓ or ✗) · availability glyph ·
// email · tier · 5h:N% 7d:N% [s7d:N% o7d:N%] · availability text · [api: …].
//
// Pure (no side effects) so it can be unit-tested without booting the worker
// — worker.ts imports parseWhenOutput from here.

const CACHE_AGE_RE = /^Cache:\s*(.+)$/;
const UTIL_RE = /5h:(\d+)% 7d:(\d+)%/;
const SONNET_7D_RE = /\bs7d:(\d+)%/;
const OPUS_7D_RE = /\bo7d:(\d+)%/;

// ccrotate ≥ the glyph-column patch emits one of these between health (✓/✗)
// and the email column. Older ccrotate omits it; both forms parse here.
//
// MUST stay in sync with the full availMark set in ccrotate's
// lib/account-table.js (renderAccountRow): 🔴 stale · 🤌 apiLimited (429/
// usage-API cooldown) · 🟢 usable · 🟡 near-limit/reset-pending · 🔵 usage-API
// cooldown · ⏳ exhausted · ❔ unknown. A missing glyph here is silent data
// loss: the glyph becomes tokens[0], fails the `@` check in parseWhenRow, and
// the whole row is dropped. That dropped every 🤌 (api-limited) account from
// the paperclip pool view while ccrotate-serve still listed them — the pool
// looked collapsed to the 1-2 non-api-limited accounts (incident 2026-05-30).
export const AVAIL_GLYPH_RE = /^[🟢🟡🔴🔵🤌⏳❔]/u;

export function parseWhenRow(line: string): {
  marker: string;
  health: string;
  availMark: string | null;
  email: string;
  tier: string;
  util: { u5: number; u7: number; s7d: number | null; o7d: number | null } | null;
  availability: string;
  apiLimit: string | null;
} | null {
  const trimmed = line.trimStart();
  const marker = line.startsWith("★") ? "★" : " ";
  let rest = trimmed.startsWith("★") ? trimmed.slice(1).trimStart() : trimmed;
  if (!rest.startsWith("✓") && !rest.startsWith("✗")) return null;
  const health = rest[0]!;
  rest = rest.slice(1).trimStart();
  let availMark: string | null = null;
  const ag = AVAIL_GLYPH_RE.exec(rest);
  if (ag) {
    availMark = ag[0]!;
    rest = rest.slice(ag[0]!.length).trimStart();
  }
  const tokens = rest.split(/\s+/);
  if (tokens.length < 2) return null;
  const email = tokens[0]!;
  if (!email.includes("@")) return null;
  const tailStart = rest.indexOf(email) + email.length;
  const tail = rest.slice(tailStart).trim();
  const tailTokens = tail.split(/\s+/);
  if (tailTokens.length < 1) return null;
  const tier = tailTokens[0]!;
  const tierEnd = tail.indexOf(tier) + tier.length;
  let postTier = tail.slice(tierEnd).trim();
  let util: { u5: number; u7: number; s7d: number | null; o7d: number | null } | null = null;
  const um = UTIL_RE.exec(postTier);
  if (um) {
    const sm = SONNET_7D_RE.exec(postTier);
    const om = OPUS_7D_RE.exec(postTier);
    util = {
      u5: Number(um[1]),
      u7: Number(um[2]),
      s7d: sm ? Number(sm[1]) : null,
      o7d: om ? Number(om[1]) : null,
    };
    postTier = postTier
      .replace(UTIL_RE, "")
      .replace(SONNET_7D_RE, "")
      .replace(OPUS_7D_RE, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  let apiLimit: string | null = null;
  const apiIdx = postTier.indexOf(" api: ");
  if (apiIdx >= 0) {
    apiLimit = postTier.slice(apiIdx + " api: ".length).trim() || null;
    postTier = postTier.slice(0, apiIdx).trim();
  } else if (postTier.startsWith("api: ")) {
    apiLimit = postTier.slice("api: ".length).trim() || null;
    postTier = "";
  }
  return {
    marker,
    health,
    availMark,
    email,
    tier,
    util,
    availability: postTier,
    apiLimit,
  };
}

export function parseWhenOutput(target: CcrotateTarget, stdout: string): {
  cacheAge: string | null;
  accounts: AccountRow[];
} {
  let cacheAge: string | null = null;
  const accounts: AccountRow[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const cm = CACHE_AGE_RE.exec(line);
    if (cm) {
      cacheAge = cm[1] ?? null;
      continue;
    }
    const parsed = parseWhenRow(line);
    if (!parsed) continue;
    accounts.push({
      email: parsed.email,
      target,
      tier: parsed.tier,
      utilization5h: parsed.util?.u5 ?? null,
      utilization7d: parsed.util?.u7 ?? null,
      utilization7dSonnet: parsed.util?.s7d ?? null,
      utilization7dOpus: parsed.util?.o7d ?? null,
      availability: parsed.availability,
      apiLimit: parsed.apiLimit,
      isActive: parsed.marker === "★",
      isHealthy: parsed.health === "✓",
    });
  }
  return { cacheAge, accounts };
}
