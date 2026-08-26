// ---------------------------------------------------------------------------
// TSMC-21870: a guard card may not be closed while its guard is still RED.
//
// THE DEFECT THIS CLOSES
// ----------------------
// `guard-bus.py` raises one `[GUARD] <name> red for N consecutive run(s)` card
// per red guard and remembers its id. When a lane closed that card by hand while
// the guard was still red, the bus (correctly, since 2026-08-25) noticed the card
// had gone terminal and minted a REPLACEMENT — deliberately keyed
// `guard-bus:<name>:<day>:after-<abandoned>` so it cannot collapse back onto the
// card just abandoned. So every hand-close is guaranteed to produce a fresh card.
//
// Measured in TSMC over the 36h to 2026-08-26 11:00 — the streak counter is the
// proof, because a close that actually fixed the finding takes the guard green,
// resets the streak to 0, and produces no successor:
//
//   channel-asset-completeness  7 cards  streak 1→2→3→4→5→9→10   all `done`
//   quota-burn                  5 cards  streak 2→3→5→6→7        all `done`
//   circuit-breaker-expiry      4 cards  streak 1→2→5→6          all `done`
//   served-tree-commitable      8 cards  streak 1→2→3→4→12,1,1,2
//   stranded-recovery           6 cards  streak 1→3→4→7, 401→402
//
// `channel-asset-completeness` was closed `done` SEVEN TIMES IN TEN HOURS and was
// red on every run throughout. ~40 guard cards were closed in 36h; not one of
// those closes made a guard green.
//
// The rule already existed and was not a control. The card body says "close this
// only when the guard exits 0", and `guard-bus.py:card_is_terminal()`'s own
// docstring concedes: "the ... line in the card body is advice, not enforcement."
// That is TSKB0055's *instruction is not enforcement*, and the close-side twin of
// *a gate that counts artifacts is not a gate* (TSKB0485): A CLOSE THAT IS NOT
// RE-PROBED IS NOT A RESOLUTION.
//
// WHY THE GUARD-BUS STATE FILE AND NOT AN INLINE RE-PROBE
// ------------------------------------------------------
// Re-running the guard command inside a close request would put a subprocess with
// a 300s timeout on the HTTP path. `guard-bus.py` already writes the authoritative
// answer to its state file every run: `{"<guard>": {"streak": N, "issue": "<IDENT>"}}`.
// `streak > 0` IS the guard being red, recorded by the guard itself rather than by
// a lane's prose. Reading it is free and cannot wedge a request.
//
// STALENESS IS FAIL-OPEN, ON PURPOSE
// ----------------------------------
// If the bus has not run inside `stalenessWindowMs`, we cannot assert redness, and
// refusing every close would wedge the board the moment the bus died. We allow the
// close and report `stale` so the caller can log it. This is the one place fail-open
// is right: the failure mode of fail-closed here is "no card in the fleet can ever
// be closed", which is worse than the treadmill.
// ---------------------------------------------------------------------------

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/** `[GUARD] served-tree-commitable red for 8 consecutive run(s)` -> `served-tree-commitable` */
const GUARD_CARD_TITLE_RE = /^\[GUARD\]\s+(.+?)\s+red for\s+\d+\s+consecutive run\(s\)\s*$/;

/**
 * Waiver. Mirrors the `no-commit close: <reason>` shape the impl-close-evidence
 * guard already accepts, so there is one waiver idiom to learn rather than two.
 * A bare marker with no reason does NOT waive — an empty waiver is how a gate
 * becomes a formality.
 */
const GUARD_CLOSE_WAIVER_RE = /(?:^|\n)\s*(?:no-guard-close|guard still red)\s*:\s*(\S.*)/i;

export const DEFAULT_GUARD_BUS_STATE_PATH = path.join(
  process.env.GUARD_BUS_STATE_PATH?.trim()
    ? path.dirname(process.env.GUARD_BUS_STATE_PATH)
    : path.join(os.homedir(), "scripts", "state"),
  process.env.GUARD_BUS_STATE_PATH?.trim()
    ? path.basename(process.env.GUARD_BUS_STATE_PATH)
    : "guard-bus-state.json",
);

/** guard-bus runs hourly; three missed runs is a dead bus, not a slow one. */
export const DEFAULT_GUARD_STATE_STALENESS_MS = 3 * 60 * 60 * 1000;

export function parseGuardCardTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const match = GUARD_CARD_TITLE_RE.exec(title.trim());
  return match ? match[1].trim() : null;
}

export function findGuardCloseWaiver(texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    if (typeof text !== "string" || !text) continue;
    const match = GUARD_CLOSE_WAIVER_RE.exec(text);
    if (match) {
      const reason = match[1].trim();
      if (reason.length > 0) return reason;
    }
  }
  return null;
}

export type GuardBusState = Record<string, { streak?: number; issue?: string | null } | unknown>;

export type GuardStateReadResult =
  | { outcome: "ok"; state: GuardBusState; modifiedAt: Date }
  | { outcome: "unavailable"; reason: string };

export async function readGuardBusState(statePath: string): Promise<GuardStateReadResult> {
  try {
    const [raw, stats] = await Promise.all([readFile(statePath, "utf8"), stat(statePath)]);
    const parsed = JSON.parse(raw) as GuardBusState;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { outcome: "unavailable", reason: "guard-bus state file is not an object" };
    }
    return { outcome: "ok", state: parsed, modifiedAt: stats.mtime };
  } catch (error) {
    return {
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export type GuardCloseEvaluation =
  | { outcome: "not_a_guard_card" }
  | { outcome: "green"; guardName: string }
  | { outcome: "waived"; guardName: string; streak: number; reason: string }
  | { outcome: "stale"; guardName: string; reason: string }
  | { outcome: "unknown_guard"; guardName: string }
  | { outcome: "red"; guardName: string; streak: number; cardOfRecord: string | null };

export async function evaluateGuardCardClose(input: {
  issue: { title?: string | null; identifier?: string | null };
  nextStatus: string;
  /** Comment bodies and the closing comment — any may carry the waiver. */
  waiverTexts?: Array<string | null | undefined>;
  statePath?: string;
  stalenessWindowMs?: number;
  now?: Date;
  readState?: (statePath: string) => Promise<GuardStateReadResult>;
}): Promise<GuardCloseEvaluation> {
  // `cancelled` silences a card just as effectively as `done`. Gate both, or the
  // treadmill simply changes which verb it uses.
  if (input.nextStatus !== "done" && input.nextStatus !== "cancelled") {
    return { outcome: "not_a_guard_card" };
  }
  const guardName = parseGuardCardTitle(input.issue.title);
  if (!guardName) return { outcome: "not_a_guard_card" };

  const statePath = input.statePath ?? DEFAULT_GUARD_BUS_STATE_PATH;
  const read = await (input.readState ?? readGuardBusState)(statePath);
  if (read.outcome !== "ok") return { outcome: "stale", guardName, reason: read.reason };

  const windowMs = input.stalenessWindowMs ?? DEFAULT_GUARD_STATE_STALENESS_MS;
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - read.modifiedAt.getTime();
  if (ageMs > windowMs) {
    return {
      outcome: "stale",
      guardName,
      reason: `guard-bus state is ${Math.round(ageMs / 60000)} min old (window ${Math.round(windowMs / 60000)} min)`,
    };
  }

  const entry = read.state[guardName];
  if (!entry || typeof entry !== "object") return { outcome: "unknown_guard", guardName };
  const streak = Number((entry as { streak?: unknown }).streak ?? 0);
  if (!Number.isFinite(streak) || streak <= 0) return { outcome: "green", guardName };

  const waiver = findGuardCloseWaiver(input.waiverTexts ?? []);
  if (waiver) return { outcome: "waived", guardName, streak, reason: waiver };

  const cardOfRecord = typeof (entry as { issue?: unknown }).issue === "string"
    ? ((entry as { issue: string }).issue)
    : null;
  return { outcome: "red", guardName, streak, cardOfRecord };
}

export function guardCloseRefusalMessage(evaluation: Extract<GuardCloseEvaluation, { outcome: "red" }>) {
  return (
    `Guard \`${evaluation.guardName}\` is still RED (${evaluation.streak} consecutive red run(s)) — `
    + "this card cannot be closed. Closing it does not clear the finding: guard-bus mints a replacement "
    + "card on the next run, which is the treadmill this gate exists to stop. "
    + "Fix the finding until the guard exits 0 and guard-bus will close this card itself, or close it "
    + "with an explicit waiver line in a comment: `no-guard-close: <reason>`."
  );
}
