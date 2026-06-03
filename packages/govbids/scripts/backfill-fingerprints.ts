/**
 * US-3 one-time backfill: enrich existing seen-set entries with the `agency`
 * field (newly added) by looking each entry's id up in the historical
 * scored-*.json files.
 *
 * Why: the agency+title-similarity repost matcher needs an agency on each seen
 * entry. Production entries recorded before this field existed have only a
 * title. Backfilling agency makes pre-existing originals (e.g. the March Oakland
 * Housing pen-test, the early-May Redwood City SharePoint RFP) recognizable when
 * their amendments re-appear with a fresh id and/or a mutated title.
 *
 * This does NOT add new seen entries — it only annotates existing ones, so the
 * set of "already shown to the team" solicitations is unchanged.
 *
 * Usage: npx tsx scripts/backfill-fingerprints.ts [--dry-run]
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  loadSeenStore,
  saveSeenStore,
  fingerprintOf,
  type SeenStore,
} from "../src/cli/seen-set.js";
import type { ScoredOpportunity } from "../src/core/types.js";

const DATA = join(import.meta.dirname ?? ".", "../data");
const DAILY = join(DATA, "daily");

/**
 * Seed the seen index from every solicitation in the scored archive, so re-posts
 * of RFPs that crossed our desk weeks ago (whose original ids were pruned from
 * the live seen-set during past backup/restore cycles, and which may have carried
 * a now-removed disqualifier) are recognized. Each historical row becomes a seen
 * entry keyed by its own id, carrying agency + title so both fingerprint and
 * agency-similarity matching can catch a fresh-id / mutated-title re-post.
 *
 * We seed ALL scored rows (not just ones that qualified) because "have we seen
 * this solicitation before" is the right repost signal — independent of whether
 * it cleared the score bar on the day we first saw it. The agency-exact +
 * high-title-similarity gate keeps this from collapsing genuinely different RFPs.
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const store: SeenStore = await loadSeenStore();
  const before = Object.keys(store.entries).length;

  const files = (await readdir(DAILY))
    .filter((f) => f.startsWith("scored-") && f.endsWith(".json"))
    .sort();

  let added = 0;
  let enrichedAgency = 0;
  for (const f of files) {
    const fileDate = `${f.slice("scored-".length, -".json".length)}T07:00:00.000Z`;
    const data = JSON.parse(await readFile(join(DAILY, f), "utf-8")) as {
      scored: ScoredOpportunity[];
    };
    for (const o of data.scored) {
      if (!o.agency) continue;

      const existing = store.entries[o.id];
      if (existing) {
        if (!existing.agency) {
          existing.agency = o.agency;
          enrichedAgency++;
        }
      } else {
        store.entries[o.id] = {
          firstSeen: fileDate,
          lastDueDate: o.dueDate ?? null,
          lastScore: o.score,
          lastTitle: o.title,
          agency: o.agency,
        };
        added++;
      }
      const fp = fingerprintOf(o);
      if (!store.fingerprints[fp]) store.fingerprints[fp] = o.id;
    }
  }

  const after = Object.keys(store.entries).length;
  console.log(`Scanned ${files.length} scored files (all rows with an agency).`);
  console.log(`Seen entries: ${before} → ${after}`);
  console.log(`  new historical entries added: ${added}`);
  console.log(`  existing entries given agency: ${enrichedAgency}`);
  console.log(`  fingerprints: ${Object.keys(store.fingerprints).length}`);

  if (dryRun) {
    console.log("\n--dry-run: not saving.");
    return;
  }
  await saveSeenStore(store);
  console.log("\nSaved. Historical re-post recognition is now active.");
}

main().catch((err: Error) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
