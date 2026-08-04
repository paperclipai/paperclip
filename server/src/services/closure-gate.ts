import { unprocessable } from "../errors.js";

/**
 * Closure-gate: prevent issue transitions to `done` (or `cancelled`) when the
 * closure comment references a `Fix-SHA` that is not present in the upstream
 * `paperclip` monorepo, and is not exempted by a documented escape-hatch marker.
 *
 * Why this exists: board-only data operations (Secrets Vault placeholders,
 * config changes, UI affordances) have no issue-specific commit. The original
 * routine fires `Signal A (Fabricated SHA)` indefinitely because the only SHA
 * available is the upstream default-branch anchor. The escape hatch lets
 * `[UI]` / `[DATA]` / kind-declared issues close cleanly with a marker such
 * as `Kind: no-code` or `No-Fix-SHA: data-only` on the closure comment.
 *
 * The gate is intentionally conservative: it only inspects the closure
 * comment text, never the title. Allowlist membership is decided by the
 * issue's title prefix (`[UI]`, `[DATA]`, `[GAP]`) or a `Kind:` line in the
 * issue description. A future revision may source the allowlist from a
 * per-company configuration table; for now it is derived from issue metadata
 * to keep the surface area small.
 */

export const CLOSURE_GATE_KIND_TOKENS = ["no-code", "data-only", "ui-only"] as const;
export type ClosureGateKindToken = (typeof CLOSURE_GATE_KIND_TOKENS)[number];

export const CLOSURE_GATE_TITLE_PREFIX_ALLOWLIST = ["[UI]", "[DATA]", "[GAP]", "[NO-CODE]"] as const;

/**
 * Minimum Fix-SHA prefix length the detector will treat as a falsifiable
 * upstream commit hash. Anything shorter is too collision-prone to verify
 * against an upstream SHA set and is treated as ambiguous rather than
 * fabricated. Below this floor the detector must never emit Signal A.
 */
export const CLOSURE_GATE_MIN_FIX_SHA_PREFIX_LENGTH = 10;

export const CLOSURE_GATE_SIGNAL = {
  FabricatedSha: "Signal A (Fabricated SHA)",
  MissingMarker: "Signal B (Missing No-Code marker on exempt kind)",
  AmbiguousShortPrefix: "Signal D (Ambiguous Short Prefix)",
} as const;

export type ClosureGateSignal = (typeof CLOSURE_GATE_SIGNAL)[keyof typeof CLOSURE_GATE_SIGNAL];

export type ClosureGateVerdict =
  | { ok: true; reason: "valid_fix_sha" }
  | { ok: true; reason: "no_code_escape_hatch"; kind: ClosureGateKindToken }
  | { ok: false; signal: ClosureGateSignal; details: Record<string, unknown> };

export type ClosureGateInput = {
  /** Free-form body the agent or board member posted when transitioning the issue. */
  closureComment: string | null | undefined;
  /** Issue title; checked for the `[UI]` / `[DATA]` / `[GAP]` / `[NO-CODE]` prefix allowlist. */
  issueTitle: string;
  /** Issue description; scanned for a `Kind: <token>` declaration line. */
  issueDescription: string | null | undefined;
  /**
   * Optional set of SHAs the agent claims are present in the upstream repo.
   * When the closure comment includes `Fix-SHA: <sha>` and the SHA appears here,
   * the gate passes without invoking the escape hatch. Empty array means the
   * caller could not verify any SHAs against the upstream monorepo.
   */
  knownUpstreamShas: readonly string[];
};

const FIX_SHA_PATTERN = /\bFix-SHA\s*:\s*`?([0-9a-f]{7,64})`?/gi;
const KIND_DECL_PATTERN = /^\s*Kind\s*:\s*(no-code|data-only|ui-only)\s*$/im;
const TITLE_PREFIX_PATTERN = /^\s*(?:\[[^\[\]]+\]\s*)+/;
const TITLE_PREFIX_TOKEN_PATTERN = /\[[^\[\]]+\]/g;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractFixShas(closureComment: string): string[] {
  const out: string[] = [];
  for (const match of closureComment.matchAll(FIX_SHA_PATTERN)) {
    if (match[1]) out.push(match[1].toLowerCase());
  }
  return out;
}

/**
 * Split a list of Fix-SHA fragments by length. Fragments shorter than
 * `minLength` cannot be reliably verified against the upstream SHA set
 * (collisions in 7-/8-char prefixes are routine) and must never be treated
 * as fabricated; they surface as ambiguous short prefixes instead.
 */
function partitionFixShasByLength(
  allFixShas: readonly string[],
  minLength: number,
): { longShas: string[]; shortPrefixes: string[] } {
  const longShas: string[] = [];
  const shortPrefixes: string[] = [];
  for (const sha of allFixShas) {
    if (sha.length >= minLength) longShas.push(sha);
    else shortPrefixes.push(sha);
  }
  return { longShas, shortPrefixes };
}

function extractKindMarker(closureComment: string): ClosureGateKindToken | null {
  const match = closureComment.match(KIND_DECL_PATTERN);
  if (!match) return null;
  const token = match[1].toLowerCase();
  if ((CLOSURE_GATE_KIND_TOKENS as readonly string[]).includes(token)) {
    return token as ClosureGateKindToken;
  }
  return null;
}

function extractKindDeclaration(issueDescription: string | null | undefined): ClosureGateKindToken | null {
  if (!issueDescription) return null;
  const match = issueDescription.match(KIND_DECL_PATTERN);
  if (!match) return null;
  const token = match[1].toLowerCase();
  if ((CLOSURE_GATE_KIND_TOKENS as readonly string[]).includes(token)) {
    return token as ClosureGateKindToken;
  }
  return null;
}

function extractTitlePrefix(issueTitle: string): string | null {
  const match = issueTitle.match(TITLE_PREFIX_PATTERN);
  return match ? match[0].trim() : null;
}

function titlePrefixAllowsNoCode(issueTitle: string): boolean {
  const prefix = extractTitlePrefix(issueTitle);
  if (!prefix) return false;
  for (const allowed of CLOSURE_GATE_TITLE_PREFIX_ALLOWLIST) {
    if (prefix === allowed) return true;
  }
  for (const match of prefix.matchAll(TITLE_PREFIX_TOKEN_PATTERN)) {
    if (CLOSURE_GATE_TITLE_PREFIX_ALLOWLIST.includes(match[0] as (typeof CLOSURE_GATE_TITLE_PREFIX_ALLOWLIST)[number])) {
      return true;
    }
  }
  return false;
}

function issueKindIsExempt(input: {
  issueTitle: string;
  issueDescription: string | null | undefined;
}): boolean {
  if (titlePrefixAllowsNoCode(input.issueTitle)) return true;
  if (extractKindDeclaration(input.issueDescription)) return true;
  return false;
}

/**
 * Pure verdict: returns whether the closure should be allowed, without
 * throwing. Use this when the caller wants to render the gate's signal as a
 * structured response (e.g. in an issue-thread interaction card).
 */
export function evaluateClosureGate(input: ClosureGateInput): ClosureGateVerdict {
  const closureComment = readNonEmptyString(input.closureComment) ?? "";
  const issueDescription = readNonEmptyString(input.issueDescription);
  const knownShas = new Set((input.knownUpstreamShas ?? []).map((sha) => sha.toLowerCase()));

  const fixShas = extractFixShas(closureComment);
  const { longShas, shortPrefixes } = partitionFixShasByLength(
    fixShas,
    CLOSURE_GATE_MIN_FIX_SHA_PREFIX_LENGTH,
  );

  if (longShas.length > 0) {
    const fabricated = longShas.filter((sha) => !knownShas.has(sha));
    if (fabricated.length === 0) {
      return { ok: true, reason: "valid_fix_sha" };
    }
    return {
      ok: false,
      signal: CLOSURE_GATE_SIGNAL.FabricatedSha,
      details: {
        fabricatedShas: fabricated,
        ...(shortPrefixes.length > 0 ? { shortPrefixes } : {}),
        hint: "Either ship the fix as a commit whose SHA is reachable on the upstream default branch, "
          + "or use the no-code escape hatch with `Kind: no-code` on the closure comment "
          + "for an issue whose title starts with `[UI]`, `[DATA]`, `[GAP]`, or `[NO-CODE]`, "
          + "or whose description declares the kind.",
      },
    };
  }

  if (issueKindIsExempt({ issueTitle: input.issueTitle, issueDescription })) {
    return { ok: true, reason: "no_code_escape_hatch", kind: "no-code" };
  }

  if (shortPrefixes.length > 0) {
    return {
      ok: false,
      signal: CLOSURE_GATE_SIGNAL.AmbiguousShortPrefix,
      details: {
        shortPrefixes,
        minPrefixLength: CLOSURE_GATE_MIN_FIX_SHA_PREFIX_LENGTH,
        hint: `Closure comment Fix-SHA fragment is shorter than the ${CLOSURE_GATE_MIN_FIX_SHA_PREFIX_LENGTH}-character minimum `
          + "and cannot be verified against the upstream monorepo. Provide the full 40-character SHA "
          + `or a longer unambiguous prefix (>=${CLOSURE_GATE_MIN_FIX_SHA_PREFIX_LENGTH} chars) so the gate can verify it.`,
      },
    };
  }

  return {
    ok: false,
    signal: CLOSURE_GATE_SIGNAL.FabricatedSha,
    details: {
      hint: "Closure comments must include `Fix-SHA: <upstream-reachable-sha>` "
        + "for code-bearing issues. Board-only data operations should add `Kind: no-code` "
        + "to the closure comment and the issue must declare a no-code kind via title prefix "
        + "(`[UI]`, `[DATA]`, `[GAP]`, `[NO-CODE]`) or via a `Kind:` line in the description.",
    },
  };
}

/**
 * Throw an `unprocessable` 422 if the closure would be rejected by the gate.
 * Returns the verdict on success so the caller can record which path allowed
 * the closure.
 */
export function assertClosureAllowed(input: ClosureGateInput): ClosureGateVerdict {
  const verdict = evaluateClosureGate(input);
  if (!verdict.ok) {
    throw unprocessable(
      `Closure-gate ${verdict.signal}: ${(verdict.details.hint as string | undefined) ?? "see details"}`,
      {
        code: "closure_gate_blocked",
        signal: verdict.signal,
        details: verdict.details,
      },
    );
  }
  return verdict;
}

/**
 * Convenience extractor for tests and routes that want the parsed fields
 * without running the full verdict. Fragments are split by length into
 * `fixShas` (≥10 chars, eligible for the fabrication check) and
 * `shortPrefixes` (<10 chars, only eligible for the ambiguous-short-prefix
 * verdict). The 10-char floor matches `CLOSURE_GATE_MIN_FIX_SHA_PREFIX_LENGTH`.
 */
export function parseClosureFields(closureComment: string | null | undefined): {
  fixShas: string[];
  shortPrefixes: string[];
  kindMarker: ClosureGateKindToken | null;
} {
  const text = readNonEmptyString(closureComment) ?? "";
  const allFixShas = extractFixShas(text);
  const { longShas, shortPrefixes } = partitionFixShasByLength(
    allFixShas,
    CLOSURE_GATE_MIN_FIX_SHA_PREFIX_LENGTH,
  );
  return {
    fixShas: longShas,
    shortPrefixes,
    kindMarker: extractKindMarker(text),
  };
}

export type ResolvedClosureGateInput = {
  /** Closure comment as posted on the PATCH body, or `null` when absent. */
  closureComment: string | null;
  /** Pending title (if non-empty after trim) wins over the persisted issue title. */
  issueTitle: string;
  /** Pending description (if provided as a string) wins over the persisted issue description. */
  issueDescription: string | null;
};

/**
 * Resolve the four inputs the closure gate needs from a PATCH body's pending
 * fields and the existing issue row. The route must call this helper before
 * invoking `assertClosureAllowed` so the gate sees:
 *   - the body-renamed title (e.g. `[UI] Tweak copy`) rather than the stale
 *     row title, so a same-PATCH rename-then-close takes the no-code hatch;
 *   - the body-added description (e.g. `Kind: no-code\n...`) so a same-PATCH
 *     exemption override applies;
 *   - the closure comment verbatim (including whitespace-only comments),
 *     so a commentless closure does not bypass the gate by short-circuiting
 *     on the truthy-comment guard.
 *
 * The helper is pure and unit-testable. The route is responsible for any
 * actor / authority validation; this helper only resolves text.
 */
export function resolveClosureGateInput(input: {
  body: { title?: unknown; description?: unknown; comment?: unknown };
  existing: { title: string; description: string | null };
}): ResolvedClosureGateInput {
  const pendingTitle = readNonEmptyString(input.body.title);
  const pendingDescription =
    typeof input.body.description === "string" ? input.body.description : null;
  return {
    closureComment:
      typeof input.body.comment === "string" ? input.body.comment : null,
    issueTitle: pendingTitle ?? input.existing.title,
    issueDescription: pendingDescription ?? input.existing.description,
  };
}
