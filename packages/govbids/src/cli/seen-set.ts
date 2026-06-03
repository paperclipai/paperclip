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
  /** Agency at time of emission — used for US-3 agency+similarity repost matching. */
  agency?: string;
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

/**
 * US-3: title-similarity threshold for declaring two same-agency solicitations the
 * same RFP. Calibrated on real BidPrime re-posts: the Redwood City SharePoint RFP
 * mutated its title across re-posts (Jaccard 0.46–0.91 between variants) while two
 * genuinely different RFPs from one agency score ~0.11. 0.45 catches the re-posts
 * without collapsing distinct RFPs.
 */
const REPOST_TITLE_SIMILARITY = 0.45;

/** state + normalized title; stable across re-posts of the same solicitation. */
export function fingerprintOf(opp: ScoredOpportunity): string {
  return `${opp.state ?? ""}::${normalizeTitle(opp.title)}`;
}

/**
 * Normalize an agency name for matching: lowercase, strip leading
 * "City of / County of / Town of / etc.", drop punctuation. So "City of Redwood
 * City" and "Redwood City" both reduce to "redwood city".
 */
export function normAgency(agency: string | null | undefined): string {
  if (!agency) return "";
  return agency
    .toLowerCase()
    .replace(/^(the\s+)?(city|county|town|village|borough|township)\s+of\s+/i, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(" ").filter((w) => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Build an agency-bucketed index of seen solicitations for fuzzy matching.
 * Only entries that recorded an agency (post-backfill) participate.
 */
export function buildAgencyIndex(
  store: SeenStore,
): Map<string, Array<{ id: string; tokens: Set<string> }>> {
  const idx = new Map<string, Array<{ id: string; tokens: Set<string> }>>();
  for (const [id, entry] of Object.entries(store.entries)) {
    if (!entry.agency || !entry.lastTitle) continue;
    const key = normAgency(entry.agency);
    if (!key) continue;
    const bucket = idx.get(key) ?? [];
    bucket.push({ id, tokens: titleTokens(entry.lastTitle) });
    idx.set(key, bucket);
  }
  return idx;
}

/**
 * US-3: has this solicitation been seen before under ANY of: exact id, exact
 * title-fingerprint, or same-agency + high title similarity (catches re-posts
 * whose title mutated and/or whose source id changed)?
 * Returns the match kind, or null if genuinely new.
 */
export function findPriorSolicitation(
  opp: ScoredOpportunity,
  store: SeenStore,
  agencyIndex: Map<string, Array<{ id: string; tokens: Set<string> }>>,
): "id" | "fingerprint" | "fuzzy" | null {
  if (store.entries[opp.id]) return "id";
  if (store.fingerprints[fingerprintOf(opp)]) return "fingerprint";

  const key = normAgency(opp.agency);
  if (key) {
    const bucket = agencyIndex.get(key);
    if (bucket) {
      const oppTokens = titleTokens(opp.title);
      for (const cand of bucket) {
        if (cand.id === opp.id) continue;
        if (jaccard(oppTokens, cand.tokens) >= REPOST_TITLE_SIMILARITY) {
          return "fuzzy";
        }
      }
    }
  }
  return null;
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

  // US-3: build the agency index once so re-posts with a mutated title and/or a
  // fresh source id are recognized (exact id + fingerprint + agency-fuzzy).
  const agencyIndex = buildAgencyIndex(store);

  for (const opp of opportunities) {
    const entry = store.entries[opp.id];

    if (!entry) {
      // id never seen. If the underlying solicitation was seen before (by
      // fingerprint or agency+title similarity), this is a re-post.
      const prior = findPriorSolicitation(opp, store, agencyIndex);
      if (prior) {
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
      agency: opp.agency, // US-3: enables agency+similarity repost matching
    };
    const fp = fingerprintOf(opp);
    if (!store.fingerprints[fp]) {
      store.fingerprints[fp] = opp.id;
    }
  }
}
