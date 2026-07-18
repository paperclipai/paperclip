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
export const STRONG_CONTRACT = [
  { id: 'nskey', re: /\bpaperclip:[a-z]/ },              // namespace/storage/event key
  { id: 'conn',  re: /:paperclip[:@]|paperclip:paperclip/i }, // conn-string user:pass
];

// -------------------------------------------------------------------------
// DATA_PLANE_CONTRACT — frozen quoted string LITERALS (NEO-507).
//
// The boundary detector treats `"`, `:`, space, `(` as word boundaries, so a
// bare quoted value like `user: "paperclip"` reads as a standalone brand word
// and OVER-FIRES. But these values are wire/runtime contracts shared with
// upstream paperclipai/paperclip — a blanket `--fix` would silently rewrite
// them into BREAKING changes (`user: "paperclip"` → `user: "cortex"` breaks the
// embedded-pg login; a renamed S3 bucket / DB name / JWT issuer / provider enum
// / log-prefix matcher all break interop or persisted data).
//
// The freeze is KEY / CONTEXT-AWARE, never "any quoted paperclip": each rule
// keys off the property/callsite/syntax the literal sits in, and the value
// token is pinned to lowercase `"paperclip"` (data identifiers are always
// lowercase). So rendered DISPLAY copy that is also a quoted literal — e.g.
// `ui/public/site.webmanifest` `"name": "Paperclip"` (capital, key `name`) —
// is deliberately NOT frozen and still fires. Genuine model-echoable brand in
// SKILL.md tag lists (`- paperclip`) or backtick skill refs (`` `paperclip` ``)
// is likewise untouched (unquoted / backtick, not a `"paperclip"` literal).
//
// Taxonomy source unchanged (NEO-436 plan rev 6 §3/§4/§6); this is a
// detector-completeness fix, not a taxonomy change.
export const DATA_PLANE_CONTRACT = [
  // Split embedded-pg creds — `user: "paperclip"` / `password: "paperclip"`.
  { id: 'pg-cred',        re: /\b(?:user|password|username|passwd)\s*:\s*"paperclip"/ },
  // DB-name arg — `ensurePostgresDatabase(conn, "paperclip")`.
  { id: 'pg-dbname',      re: /ensure[A-Za-z]*Database\s*\([^)]*"paperclip"/ },
  // S3 bucket literal / default — `bucket: "paperclip"`, `bucket ?? "paperclip"`.
  { id: 's3-bucket',      re: /\bbucket\b[^"\n]*"paperclip"/ },
  // Provider / badge enum discriminants — `provider === "paperclip"`,
  // `provider: "paperclip"`, `sourceBadge === "paperclip"`.
  { id: 'enum-provider',  re: /\b(?:provider|sourceBadge)\s*(?:!==?|===?|:)\s*"paperclip"/ },
  // `switch` discriminant — `case "paperclip":`.
  { id: 'enum-case',      re: /\bcase\s+"paperclip"\s*:/ },
  // Config-presence discriminant vocabulary — the ternary label
  // `hasPaperclipConfig ? "paperclip" : "no-paperclip-config"`. The negative
  // partner is dash-frozen, so renaming only the positive branch would split
  // the pair; both stay frozen as the `.paperclip` config-dir vocabulary.
  { id: 'config-flag',    re: /"paperclip"\s*:\s*"no-paperclip-config"/ },
  // Identity/auth default — `DEFAULT_AGENT_JWT_ISSUER = "paperclip"`.
  { id: 'jwt-issuer',     re: /ISSUER\s*=\s*"paperclip"/ },
  // Session-key default — `sessionKey ?? "paperclip"`.
  { id: 'session-key',    re: /\bsessionKey\b[^"\n]*"paperclip"/ },
  // Secret / backup name-prefix defaults — `filenamePrefix … "paperclip"`,
  // `secretNamePrefix … "paperclip"`, `const prefix = … ?? "paperclip"`. Uses
  // `.*` (not `[^"]*`) so it still matches when an intervening quoted arg sits
  // between the key and the default, e.g. `detailString(…, "prefix") ?? "paperclip"`.
  { id: 'name-prefix',    re: /\b(?:filenamePrefix|secretNamePrefix|prefix)\b.*"paperclip"/ },
  // CLI option default for the backup filename prefix.
  { id: 'cli-prefix',     re: /--filename-prefix\b.*"paperclip"/ },
  // UI placeholder for a frozen-prefix/bucket/session field (object or JSX).
  { id: 'ui-placeholder', re: /\bplaceholder\s*[:=]\s*"paperclip"/ },
  // Runtime log-prefix matcher / emitter — `[paperclip] skipping saved …`.
  // Renaming the matcher without renaming the emitter silently breaks the match.
  { id: 'log-prefix',     re: /\[paperclip\]/ },
  // Bare fallback literal on its own line — the tail of a multi-line `??`/`||`
  // default chain (e.g. `\n    "paperclip";`). A standalone quoted-string
  // statement is never rendered display copy.
  { id: 'default-literal', re: /^\s*"paperclip"\s*[;,]?\s*$/ },
];

// -------------------------------------------------------------------------
// INSTRUCTION_ALLOW — lines that name the forbidden brand ON PURPOSE, e.g. the
// onboarding directive `…Never refer to it as "Paperclip" in user-facing
// output.` Must be allowlisted (not fired, not rewritten): a `--fix` here would
// turn the instruction into `…Never refer to it as "Cortex"…`, defeating it.
export const INSTRUCTION_ALLOW = [
  { id: 'never-refer', re: /Never refer to it as\s+\\?"Paperclip\\?"/i },
];

// A line is frozen if it matches ANY of the contract sets. Callers use this
// single predicate to (a) suppress a lint violation and (b) whole-line-freeze
// the codemod, so the two can never diverge.
export function strongContract(line) {
  for (const set of [STRONG_CONTRACT, DATA_PLANE_CONTRACT, INSTRUCTION_ALLOW]) {
    const hit = set.find((a) => a.re.test(line));
    if (hit) return hit.id;
  }
  return null;
}

export function isAllowlisted(line) {
  return ALLOWLIST.find((a) => a.re.test(line))?.id ?? null;
}
