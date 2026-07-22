// Live pre-read — the SHARED segment pipeline both the Daily Huddle and the Weekly Tactical plugin jobs
// run against the live CK company (no seeded source). It reuses the exact segment primitives
// (segueLine + the SPC filter) so the huddle and the tactical don't duplicate logic (build-notes §7):
//   * Segment 1 — segue/good-news from recent 'keep' verdicts.
//   * Segment 2 (a metric) — apply the SPC filter to EACH unit's cost-adjusted-score history (a uniform
//     metric present on every scorecard). A red unit (verdict tune/quarantine) is only an Issue if SPC
//     says special-cause; common-cause noise is dropped.
//   * "Where are you stuck" — the open board issues (passed in by the caller).
// The Daily Huddle stops here (no IDS). The Weekly Tactical feeds the promoted issues into IDS.

import type { Sql } from "postgres";
import { spcClassify } from "./spc.js";
import { segueLine } from "./segments.js";
import type { IssueCandidate } from "./segments.js";

interface SpecScoreRow {
  spec_id: string;
  name: string;
  scores: number[];
  latest_verdict: string | null;
}

export interface LivePreRead {
  wins: string[];
  keepCount: number;
  redCount: number;
  issues: IssueCandidate[];
  dropped: Array<{ unit: string; reason: string }>;
  unitsConsidered: number;
}

// Assemble the live pre-read for a company from ck_eval scorecards. Pure read; deterministic.
export async function assembleLivePreRead(sql: Sql, companyId: string): Promise<LivePreRead> {
  const specs = (await sql`
    select spec.id as spec_id, spec.name as name,
           array_agg(sc.cost_adjusted_score order by sc.computed_at asc)
             filter (where sc.cost_adjusted_score is not null) as scores,
           (array_agg(sc.verdict order by sc.computed_at desc))[1] as latest_verdict
    from ck_eval.agent_spec spec
    join public.agents a on a.id = spec.paperclip_agent_id
    left join ck_eval.scorecard sc on sc.spec_id = spec.id
    where a.company_id = ${companyId}
    group by spec.id, spec.name
    having count(sc.id) > 0
    order by spec.name
  `) as unknown as SpecScoreRow[];

  const issues: IssueCandidate[] = [];
  const dropped: Array<{ unit: string; reason: string }> = [];
  const wins: string[] = [];
  let keepCount = 0;
  let redCount = 0;

  for (const s of specs) {
    const scores = (s.scores ?? []).map(Number).filter((n) => Number.isFinite(n));
    const red = s.latest_verdict === "tune" || s.latest_verdict === "quarantine";
    if (s.latest_verdict === "keep") {
      keepCount++;
      if (wins.length < 3) wins.push(s.name);
    }
    if (!red) continue;
    redCount++;
    // cost-adjusted score: lower is worse, so a drop is the bad side.
    const spc = scores.length >= 5 ? spcClassify({ series: scores, direction: "lower_is_bad" }) : null;
    if (spc && spc.classification === "signal") {
      const latest = scores[scores.length - 1];
      const sigmaUnits = spc.sigmaHat > 0 ? Math.abs(latest - spc.mean) / spc.sigmaHat : 6;
      issues.push({
        sourceKind: "scorecard_spc",
        sourceRef: s.spec_id,
        title: `Unit red is special-cause: ${s.name} (verdict ${s.latest_verdict}, cost-adj score ${latest.toFixed(3)})`,
        impactScore: Number(sigmaUnits.toFixed(3)),
        believability: 1,
        evidence: { unit: s.name, latest_verdict: s.latest_verdict, spc_rules: spc.rulesFired, mean: spc.mean, lcl: spc.lcl },
      });
    } else {
      dropped.push({
        unit: s.name,
        reason: spc ? spc.reason : `verdict ${s.latest_verdict} but <5 scorecards — insufficient history for SPC`,
      });
    }
  }

  return {
    wins: segueLine(wins, keepCount, keepCount),
    keepCount,
    redCount,
    issues,
    dropped,
    unitsConsidered: specs.length,
  };
}
