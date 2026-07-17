// NEO-438 (W1) — Branding scrub guard spec.
// Single source of truth shared by:
//   - branding-inventory.mjs   (this repo — proof-complete inventory)
//   - scripts/check-branding-no-paperclip.mjs  (W3, Neoreef/paperclip app repo)
// Keep the two in lockstep: W3 imports/mirrors these exact globs + allowlist.
//
// Taxonomy source: NEO-436 plan doc rev 6 (9d41d94c), §3 / §4 / §6.

// -------------------------------------------------------------------------
// GUARDED GLOB SET — union of Buckets A + B + G + H-text.
// The merge-guard (W3) lints ONLY these paths and rewrites ONLY these paths.
// Everything else in the repo is out of scope for the guard (frozen).
// -------------------------------------------------------------------------
export const GUARD_GLOBS = [
  'ui/index.html',                                   // A: shell <title>+meta
  'ui/src/**',                                       // A: rendered UI brand text + toasts
  'cli/src/**',                                      // A: CLI banner + help text
  'skills/**/SKILL.md',                              // B/G: skill names (frontmatter) + bodies
  'packages/skills-catalog/**/SKILL.md',             // B/G: bundled catalog skill md
  'server/src/onboarding-assets/**/AGENTS.md',       // G: agent onboarding templates
  'packages/teams-catalog/**/AGENTS.md',             // G: teams-catalog agent templates
  'evals/promptfoo/prompts/**',                      // G: prompt templates
  'ui/public/site.webmanifest',                      // H-text: PWA name/short_name/description
];

// -------------------------------------------------------------------------
// PRIMARY DETECTOR — boundary-aware whole-word brand token.
// `paperclip` is a rename target ONLY when it stands alone as a brand word.
// The negative look-around freezes every contract shape automatically:
//   PAPERCLIP_ENV (`_` after) · @paperclipai (`@`/`a` around) · PaperclipConfig
//   (`C` after) · usePaperclip (`e` before) · paperclip-board (`-` after) ·
//   /paperclip (`/` before, path) · paperclip.ing (`.` after, domain) ·
//   .paperclip-css (`.` before, `-` after) · paperclipai binary (`a` after).
// So the guard fires on rendered/echoable brand prose and nothing else.
export const BRAND_WORD_RE = /(?<![A-Za-z0-9_\-/.@~])paperclip(?![A-Za-z0-9_\-/.])/i;

export function hasBrandWord(line) { return BRAND_WORD_RE.test(line); }

// -------------------------------------------------------------------------
// SECONDARY ALLOWLIST — explicit frozen-contract shapes (§3 C–F / §6).
// Belt-and-suspenders documentation of the contract token shapes the
// boundary detector already excludes; W3 may apply these as a redundant
// second filter, and they are the human-readable statement of "what is frozen".
// Match is against the raw source line.
// -------------------------------------------------------------------------
export const ALLOWLIST = [
  // env vars — e.g. PAPERCLIP_API_URL, PAPERCLIP_IN_WORKTREE
  { id: 'env',        re: /PAPERCLIP_[A-Z][A-Z0-9_]*/ },
  // package scope — e.g. @paperclipai/server, @paperclipai/skills-catalog
  { id: 'pkg',        re: /@paperclipai\// },
  // wire headers — e.g. X-Paperclip-Run-Id (case-insensitive)
  { id: 'header',     re: /\bx-paperclip-[a-z0-9-]+/i },
  // import / require specifiers that carry a paperclip token
  { id: 'import',     re: /(?:from|import|require)\s*\(?\s*['"][^'"]*paperclip/i },
  // filesystem / URL path segments — /paperclip, ~/.paperclip, .paperclip/
  { id: 'path',       re: /\/\.?paperclip(?:[\/'"\s)]|$)/i },
];

// Path-level freeze: test files stay frozen (canary — must remain green).
// Kept separate from ALLOWLIST because it is matched against the PATH.
export const TEST_PATH_RE = /(?:^|\/)__tests__\/|\.test\.|\.spec\.|(?:^|\/)tests?\//;

// -------------------------------------------------------------------------
// Bucket routing globs (path-based; first match wins in the order below,
// AFTER the H-asset and TEST checks and BEFORE the frozen fallthrough).
// -------------------------------------------------------------------------

// H — graphical assets (glyph swap, keep filenames unless in H3). Binary
// icons never appear in a text grep; only the text-bearing assets do.
export const H_ASSET_PATHS = new Set([
  'ui/public/favicon.svg',
  'ui/public/favicon.ico',
  'ui/public/favicon-16x16.png',
  'ui/public/favicon-32x32.png',
  'ui/public/apple-touch-icon.png',
  'ui/public/android-chrome-192x192.png',
  'ui/public/android-chrome-512x512.png',
  'ui/public/site.webmanifest',
  'ui/public/paperclip-thinking.svg',                // H3 rename → cortex-thinking.svg
  'ui/public/worktree-favicon.svg',
  'ui/public/worktree-favicon.ico',
  'ui/public/worktree-favicon-16x16.png',
  'ui/public/worktree-favicon-32x32.png',
  'server/src/ui-branding.ts',                       // inline favicon SVG path (H) + worktree badge
  'docs/favicon.svg',
  'docs/images/logo-light.svg',
  'docs/images/logo-dark.svg',
]);

// H3 filename renames (Neoreef-owned assets whose *name* contains paperclip).
export const H_RENAMES = [
  { from: 'ui/public/paperclip-thinking.svg', to: 'ui/public/cortex-thinking.svg',
    refs: ['ui/src/pages/BoardChat.tsx'] },
];

// B — the four top-level skill dirs whose display name renames (+ invocation alias).
export const B_SKILL_DIRS = [
  'skills/paperclip',
  'skills/paperclip-board',
  'skills/paperclip-create-agent',
  'skills/paperclip-converting-plans-to-tasks',
];

// A — rendered UI/CLI brand-text globs (regex form for the classifier).
export const A_PATH_RE = /^(ui\/index\.html$|ui\/src\/|cli\/src\/)/;

// G — model-echoable text globs (regex form).
export const G_PATH_RE = /^(skills\/.*\/SKILL\.md$|packages\/skills-catalog\/.*\/SKILL\.md$|server\/src\/onboarding-assets\/.*\/AGENTS\.md$|packages\/teams-catalog\/.*\/AGENTS\.md$|evals\/promptfoo\/prompts\/)/;

// G content triggers that can appear outside the G globs (commit trailer).
export const G_CONTENT_RE = /Co-Authored-By:\s*Paperclip|noreply@paperclip\.ing/i;

// B skill-dir detector (top-level skills/paperclip* only — the guarded root).
export const B_SKILL_DIR_RE = /^skills\/paperclip(?:-[a-z-]+)?\//;

// Skill-ish / AGENTS paths OUTSIDE the guarded root — surfaced as review flags
// so Grace/Board can confirm they are intentionally out of scope (frozen).
export const OUT_OF_GUARD_SKILL_RE = /(^\.agents\/skills\/[^/]*paperclip|^\.claude\/skills\/[^/]*paperclip|^packages\/plugins\/.*\/skills\/[^/]*paperclip)/;

// STRONG_CONTRACT — lowercase `paperclip` fused into a runtime key or a
// connection string. These read as a brand word to the boundary detector
// (colon/`@` are boundaries) but are frozen contracts shared with upstream:
//   paperclip:issue-draft (localStorage/event key) · postgres://paperclip:
//   paperclip@… (embedded-pg default creds/dbname). Prose "Paperclip:" (capital
//   + space) is intentionally NOT matched, so rendered copy still renames.
//
// NEO-509 (amends conf 3b8eba31): a bare lowercase `"paperclip"` STRING LITERAL
// reads as a brand word to BRAND_WORD_RE (quotes are boundaries), but many such
// occurrences are FROZEN data-plane values shared with upstream — renaming any
// breaks auth / DB / storage / enum / log-parsing interop. The line-based
// detector under-covers the FORMS they appear in, so we add whole-line freezes
// keyed on each contract-bearing context. Every rule below is case-SENSITIVE on
// the lowercase literal so rendered prose ("Paperclip", placeholder text) still
// fires and renames. Forms enumerated in NEO-483 `guard-activation-triage`.
export const STRONG_CONTRACT = [
  { id: 'nskey', re: /\bpaperclip:[a-z]/ },              // namespace/storage/event key
  { id: 'conn',  re: /:paperclip[:@]|paperclip:paperclip/i }, // conn-string user:pass

  // embedded-pg default creds + S3-bucket + workProduct provider — struct/record
  // field whose VALUE is the frozen id. Keyed on the field name so prose keys
  // (placeholder:, name:, short_name:) are NOT matched.
  { id: 'frozen-field', re: /\b(?:user|password|bucket|provider)\s*:\s*["']paperclip["']/ },
  // code value-default `?? "paperclip"` / `|| "paperclip"` resolving a frozen
  // resource id (S3 bucket / adapter sessionKey / secret-name prefix). Requires
  // the frozen resource token on the line so a renameable default like the
  // backup `filenamePrefix || "paperclip"` (Bucket A/W2 prose) still fires.
  { id: 'resource-default', re: /(?:s3[?.]*\.?bucket|\bbucket\b|sessionKey|secretNamePrefix|["']prefix["'])[^\n]*(?:\?\?|\|\|)\s*["']paperclip["']/ },
  // embedded-pg default dbname passed to ensurePostgresDatabase(conn, "paperclip")
  { id: 'pg-dbname', re: /ensurePostgresDatabase\([^)]*["']paperclip["']/ },
  // enum / discriminant comparison — workProduct provider, catalog source badge,
  // switch-case discriminator. Comparison/`case` forms are never rendered prose.
  { id: 'enum-cmp', re: /(?:={2,3}\s*["']paperclip["']|case\s+["']paperclip["']\s*:)/ },
  // auth JWT issuer claim (token `iss`); renaming breaks token validation.
  { id: 'jwt-issuer', re: /(?:JWT_ISSUER|\bISSUER|["']iss["'])\s*[:=]\s*["']paperclip["']/ },
  // frozen `[paperclip]` log-prefix — consumers parse the literal bracketed tag
  // emitted by the out-of-scope (frozen) instrumentation; renaming breaks parsing.
  { id: 'log-prefix', re: /\[paperclip\]/ },
  // internal config discriminant paired with the `no-paperclip-config` sentinel.
  { id: 'config-flag', re: /no-paperclip-config/ },
  // D6 anti-brand naming directive — the line literally quotes the OLD brand to
  // forbid it ("Never refer to it as \"Paperclip\""); rewriting is nonsensical.
  { id: 'd6-directive', re: /refer to it as\s+["“][Pp]aperclip["”]/ },
];

export function strongContract(line) {
  return STRONG_CONTRACT.find((a) => a.re.test(line))?.id ?? null;
}

// -------------------------------------------------------------------------
// NEO-509 — CONTEXT-AWARE FREEZE for a multi-line frozen default (§ scope 2).
// A line whose ENTIRE content is a bare lowercase `"paperclip"` literal is the
// tail of a multi-line ??/|| default expression, never rendered prose. The
// line-based detector cannot see the `s3.bucket ??` on the preceding line
// (e.g. cli/src/commands/env.ts storageS3Bucket default), so it must look back.
// Frozen ONLY when the ??/|| chain it terminates resolves a frozen resource id
// (S3 bucket / secret prefix / sessionKey). Bounded look-back; used by the W3
// check script in BOTH lint and --fix so the codemod also leaves it untouched.
// -------------------------------------------------------------------------
export const BARE_BRAND_LITERAL_RE = /^\s*["']paperclip["']\s*[;,)\]]*\s*$/;

const FROZEN_DEFAULT_RESOURCE_RE = /s3[?.]*\.?bucket|S3_BUCKET|sessionKey|secretNamePrefix|["']prefix["']/i;

export function frozenContinuation(lines, idx) {
  if (idx <= 0 || !BARE_BRAND_LITERAL_RE.test(lines[idx])) return null;
  let sawResource = false;
  for (let j = idx - 1, scanned = 0; j >= 0 && scanned < 5; j--) {
    const prev = lines[j];
    if (prev.trim() === '') continue;
    scanned++;
    if (FROZEN_DEFAULT_RESOURCE_RE.test(prev)) sawResource = true;
    // The preceding line must be part of a ??/|| chain; the first line that does
    // NOT end with a chain operator is the assignment head — stop there.
    if (!/(?:\?\?|\|\|)\s*$/.test(prev.replace(/\s+$/, ''))) break;
  }
  return sawResource ? 's3-bucket-multiline' : null;
}

export function isAllowlisted(line) {
  return ALLOWLIST.find((a) => a.re.test(line))?.id ?? null;
}
