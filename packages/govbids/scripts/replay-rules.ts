import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stripSoftDisqualifiers } from "../src/core/scorer.js";

const DATA = "/Users/bb/conductor/workspaces/paperclip/delhi/packages/govbids/data/daily";

interface Scored {
  id: string;
  title: string;
  agency: string;
  state: string | null;
  score: number;
  scoreBreakdown: { serviceAlignment: number };
  disqualifiers: string[];
  serviceCategory: string;
  postedDate?: string;
}

const OLD_MIN = 60;
const NEW_MIN = 50;

async function main() {
  const totals = { runs: 0, oldQualified: 0, newQualified: 0, recoveredByDisq: 0, recoveredByThreshold: 0, both: 0 };
  const recoveredSample: Array<{ run: string; title: string; score: number; oldDq: string[]; reason: string }> = [];

  const files = (await readdir(DATA)).filter((f) => f.startsWith("scored-") && f.endsWith(".json")).sort();
  for (const f of files) {
    const data = JSON.parse(await readFile(join(DATA, f), "utf-8")) as { scored: Scored[] };
    totals.runs++;
    for (const o of data.scored) {
      const oldQualified = o.score >= OLD_MIN && (o.disqualifiers ?? []).length === 0;
      const newDq = stripSoftDisqualifiers(o.disqualifiers ?? []);
      const newQualified = o.score >= NEW_MIN && newDq.length === 0;
      if (oldQualified) totals.oldQualified++;
      if (newQualified) totals.newQualified++;
      if (!oldQualified && newQualified) {
        const droppedByThreshold = o.score < OLD_MIN && o.score >= NEW_MIN;
        const droppedByDisq = (o.disqualifiers ?? []).length > 0 && newDq.length === 0;
        let reason = "";
        if (droppedByThreshold && droppedByDisq) { totals.both++; reason = "threshold + disq"; }
        else if (droppedByThreshold) { totals.recoveredByThreshold++; reason = "threshold (50-59)"; }
        else if (droppedByDisq) { totals.recoveredByDisq++; reason = "soft disq stripped"; }
        if (recoveredSample.length < 25) {
          recoveredSample.push({ run: f.replace("scored-","").replace(".json",""), title: o.title, score: o.score, oldDq: o.disqualifiers ?? [], reason });
        }
      }
    }
  }

  console.log("=== Replay across", totals.runs, "scored days ===");
  console.log("Old rule (score>=60, no disq):       ", totals.oldQualified);
  console.log("New rule (score>=50, soft disq strip):", totals.newQualified);
  console.log("Net recovery:                         +" + (totals.newQualified - totals.oldQualified));
  console.log();
  console.log("  recovered via threshold only (50-59):  ", totals.recoveredByThreshold);
  console.log("  recovered via disqualifier strip only: ", totals.recoveredByDisq);
  console.log("  recovered via both:                    ", totals.both);
  console.log();
  console.log("=== Sample of newly-recovered RFPs ===");
  for (const r of recoveredSample.slice(0, 20)) {
    const dq = r.oldDq.length ? " | OLD DQ: " + r.oldDq[0].slice(0,50) : "";
    console.log("  " + r.run + " | " + r.score + " | [" + r.reason + "] " + r.title.slice(0,55) + dq);
  }
}
main().catch((e: Error) => { console.error("FAILED:", e.message); process.exit(1); });
