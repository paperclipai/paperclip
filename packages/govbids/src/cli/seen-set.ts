import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ScoredOpportunity } from "../core/types.js";
import { normalizeTitle } from "../core/cross-source-dedup.js";

const SEEN_DIR = join(import.meta.dirname ?? ".", "../../data");
const SEEN_FILE = join(SEEN_DIR, ".seen-ids.json");

export interface SeenEntry {
  /** When this opportunity was first emitted to the team. */
  firstSeen: string;
  /** Last dueDate we showed the team for this opportunity (ISO). */
  lastDueDate: string | null;
  /** Last score we showed. Used to flag big score changes if we ever want to. */
  lastScore: number;
  /** Title at time of last emission (for debugging). */
  lastTitle: string;
}

export interface SeenStore {
  /** Keyed by opportunity id (source-prefixed). */
  entries: Record<string, SeenEntry>;
  /**
   * Keyed by title-fingerprint (state + normalized title) → first id seen with it.
   * Catches re-posts/addenda that arrive with a fresh source id but the same
   * underlying solicitation (common for BidPrime/RFPMart).
   */
  fingerprints: Record<string, string>;
}

const DUE_DATE_DRIFT_DAYS = 3;

/** state + normalized title; stable across re-posts of the same solicitation. */
export function fingerprintOf(opp: ScoredOpportunity): string {
  return `${opp.state ?? ""}::${normalizeTitle(opp.title)}`;
}

export async function loadSeenStore(): Promise<SeenStore> {
  try {
    const raw = await readFile(SEEN_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SeenStore>;
    return {
      entries: parsed.entries ?? {},
      fingerprints: parsed.fingerprints ?? {},
    };
  } catch {
    return { entries: {}, fingerprints: {} };
  }
}

export async function saveSeenStore(store: SeenStore): Promise<void> {
  await mkdir(dirname(SEEN_FILE), { recursive: true });
  await writeFile(SEEN_FILE, JSON.stringify(store, null, 2));
}

/**
 * Decide whether to re-show an opportunity that's already in the seen-set.
 *
 * Re-show when:
 *   - dueDate shifted by more than DUE_DATE_DRIFT_DAYS (amendment / extension)
 *   - today is the day-of-deadline (final-day reminder)
 *
 * Otherwise: suppress.
 */
export function shouldReshow(opp: ScoredOpportunity, entry: SeenEntry): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Day-of-deadline
  if (opp.dueDate) {
    const due = new Date(opp.dueDate);
    due.setHours(0, 0, 0, 0);
    if (due.getTime() === today.getTime()) return true;
  }

  // Due-date drift
  if (opp.dueDate && entry.lastDueDate) {
    const newDue = new Date(opp.dueDate).getTime();
    const oldDue = new Date(entry.lastDueDate).getTime();
    const driftDays = Math.abs(newDue - oldDue) / (1000 * 60 * 60 * 24);
    if (driftDays > DUE_DATE_DRIFT_DAYS) return true;
  } else if (opp.dueDate && !entry.lastDueDate) {
    // Newly-discovered due date is informative
    return true;
  }

  return false;
}

export interface FilterResult {
  /** Genuinely new: id unknown AND title-fingerprint unknown. */
  fresh: ScoredOpportunity[];
  /** Same solicitation seen before but arriving with a NEW source id (re-post). */
  repost: ScoredOpportunity[];
  /** Already-shown RFP re-surfaced due to due-date drift / day-of-deadline. */
  reshownDeadline: ScoredOpportunity[];
  /** Suppressed because already shown and nothing changed. */
  suppressed: ScoredOpportunity[];
}

export function filterSeen(
  opportunities: ScoredOpportunity[],
  store: SeenStore,
  options: { includeSeen?: boolean } = {},
): FilterResult {
  const fresh: ScoredOpportunity[] = [];
  const repost: ScoredOpportunity[] = [];
  const reshownDeadline: ScoredOpportunity[] = [];
  const suppressed: ScoredOpportunity[] = [];

  for (const opp of opportunities) {
    const entry = store.entries[opp.id];
    const fpKnown = !!store.fingerprints[fingerprintOf(opp)];

    if (!entry) {
      // id never seen. If the underlying solicitation (fingerprint) was seen
      // before, this is a re-post with a fresh id.
      if (fpKnown) {
        repost.push(opp);
      } else {
        fresh.push(opp);
      }
      continue;
    }

    // id seen before.
    if (options.includeSeen) {
      reshownDeadline.push(opp);
      continue;
    }
    if (shouldReshow(opp, entry)) {
      reshownDeadline.push(opp);
    } else {
      suppressed.push(opp);
    }
  }

  return { fresh, repost, reshownDeadline, suppressed };
}

/** Mark these opportunities as seen, updating id entries and fingerprint index. */
export function markSeen(
  opportunities: ScoredOpportunity[],
  store: SeenStore,
): void {
  const nowIso = new Date().toISOString();
  for (const opp of opportunities) {
    const existing = store.entries[opp.id];
    store.entries[opp.id] = {
      firstSeen: existing?.firstSeen ?? nowIso,
      lastDueDate: opp.dueDate ?? null,
      lastScore: opp.score,
      lastTitle: opp.title,
    };
    const fp = fingerprintOf(opp);
    if (!store.fingerprints[fp]) {
      store.fingerprints[fp] = opp.id;
    }
  }
}
