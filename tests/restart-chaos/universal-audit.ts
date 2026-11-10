/**
 * Run the universal checks U1–U4 over saved wave evidence, to measure false
 * positives before a rule is enforced.
 *
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/universal-audit.ts [--json] <results dir> [...]
 *
 * Each results dir holds `w-*` wave directories with `<task>.grade.json`. A
 * task counts as known-good when it passed R1–R6 and T; a wave is known-good
 * when every graded task in it passed. Every rule is graded as a warning here,
 * whatever its enforcement, so all flags are shown.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TaskGrade, TaskRecord } from "./types.js";
import { DEFAULT_UNIVERSAL_BOUNDS, gradeUniversal, type UniversalBounds, type UniversalId } from "./universal.js";

export interface AuditFlag { wave: string; task: string; workload: string; adapter: string; taskPassed: boolean; waveGood: boolean; rule: UniversalId; detail: string }
export interface AuditReport {
  waves: number; tasks: number; knownGoodTasks: number; knownGoodWaves: number;
  byRule: Record<UniversalId, { flagged: number; onKnownGoodTasks: number; onKnownGoodWaves: number }>;
  flags: AuditFlag[];
  /** Per metric, over tasks that passed R1–R6+T: p50, p95, p99 and max. */
  passingMetrics: Record<string, { n: number; p50: number; p95: number; p99: number; max: number }>;
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
}

const RULES: UniversalId[] = ["U1", "U2", "U3", "U4"];

export function auditWaves(roots: readonly string[], bounds: UniversalBounds = DEFAULT_UNIVERSAL_BOUNDS): AuditReport {
  const report: AuditReport = { waves: 0, tasks: 0, knownGoodTasks: 0, knownGoodWaves: 0,
    byRule: Object.fromEntries(RULES.map(rule => [rule, { flagged: 0, onKnownGoodTasks: 0, onKnownGoodWaves: 0 }])) as AuditReport["byRule"], flags: [],
    passingMetrics: {} };
  const metrics = new Map<string, number[]>();
  for (const root of roots) {
    let waves: string[] = [];
    try { waves = readdirSync(root).filter(name => name.startsWith("w-")).sort(); } catch { continue; }
    for (const wave of waves) {
      const dir = path.join(root, wave);
      const graded: Array<{ task: string; record: TaskRecord; grade: TaskGrade }> = [];
      for (const file of readdirSync(dir).filter(name => /^t\d+\.grade\.json$/.test(name)).sort()) {
        try {
          const parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { record: TaskRecord; grade: TaskGrade };
          graded.push({ task: file.replace(".grade.json", ""), ...parsed });
        } catch { /* a truncated grade file is not evidence */ }
      }
      if (!graded.length) continue;
      report.waves += 1;
      // Known-good is R1–R6 and T only: `grade.pass` on newer grades also includes enforced universal checks.
      const known = (grade: TaskGrade) => grade.T.verdict === "pass" && Object.values(grade.rules).every(rule => rule.verdict !== "fail");
      const waveGood = graded.every(entry => known(entry.grade));
      if (waveGood) report.knownGoodWaves += 1;
      for (const { task, record, grade } of graded) {
        report.tasks += 1;
        const passed = known(grade);
        if (passed) report.knownGoodTasks += 1;
        const universal = gradeUniversal(record, { bounds, enforced: new Set() });
        // A grade saved with universal checks graded U3 with the wave database (run messages, recovery
        // actions) that the saved record lacks: keep that verdict instead of a samples-only recomputation.
        if (grade.universal?.U3) universal.U3 = { ...grade.universal.U3, enforced: false };
        for (const rule of RULES) {
          if (passed) for (const [name, value] of Object.entries(universal[rule].metrics ?? {})) metrics.set(name, [...(metrics.get(name) ?? []), value]);
          if (universal[rule].verdict !== "fail") continue;
          report.byRule[rule].flagged += 1;
          if (passed) report.byRule[rule].onKnownGoodTasks += 1;
          if (waveGood) report.byRule[rule].onKnownGoodWaves += 1;
          report.flags.push({ wave: `${path.basename(path.resolve(root, "../../.."))}:${wave}`, task, workload: record.plan.workload,
            adapter: record.plan.adapter, taskPassed: passed, waveGood, rule, detail: universal[rule].detail });
        }
      }
    }
  }
  report.passingMetrics = Object.fromEntries([...metrics].map(([name, values]) => [name, percentiles(values)]));
  return report;
}

export function renderAudit(report: AuditReport): string {
  const lines = [
    `Universal check audit: ${report.waves} waves (${report.knownGoodWaves} all-pass), ${report.tasks} tasks (${report.knownGoodTasks} passed R1–R6+T)`,
    "",
    "| Rule | Flagged tasks | On passing tasks | On all-pass waves |",
    "| --- | --- | --- | --- |",
    ...RULES.map(rule => `| ${rule} | ${report.byRule[rule].flagged} | ${report.byRule[rule].onKnownGoodTasks} | ${report.byRule[rule].onKnownGoodWaves} |`),
    "",
    "Passing tasks: | metric | n | p50 | p95 | p99 | max |",
    ...Object.entries(report.passingMetrics).map(([name, value]) => `| ${name} | ${value.n} | ${value.p50} | ${value.p95} | ${value.p99} | ${value.max} |`),
    "",
    ...report.flags.map(flag => `${flag.rule} ${flag.wave}/${flag.task} ${flag.adapter}/${flag.workload} task=${flag.taskPassed ? "pass" : "fail"}: ${flag.detail}`),
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("universal-audit.ts")) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const roots = args.filter(arg => arg !== "--json").map(arg => path.resolve(arg));
  if (!roots.length) { console.error("usage: universal-audit.ts [--json] <results dir> [...]"); process.exit(2); }
  const report = auditWaves(roots);
  console.info(json ? JSON.stringify(report, null, 2) : renderAudit(report));
}
