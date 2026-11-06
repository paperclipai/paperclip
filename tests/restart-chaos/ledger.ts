import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { replayCommand } from "./config.js";
import type { RuleId, TaskGrade, TaskRecord, WavePlan } from "./types.js";

export interface LedgerLine {
  schema: "paperclip.restart-chaos.ledger/v1";
  waveId: string;
  taskId: string;
  seed: number;
  gitSha: string;
  env: string;
  adapter: string;
  workload: string;
  fault: string;
  /** Fault timing trigger (absent means time). */
  trigger?: string;
  /** Triggered faults whose condition never held. */
  triggerMissed?: string[];
  holdMs: number;
  fireAfterMs: number;
  issue: string | null;
  crossed: boolean;
  crossingFaults: string[];
  rules: Record<RuleId, string>;
  ruleDetails: Record<RuleId, string>;
  T: string;
  pass: boolean;
  signature: string | null;
  retried: boolean;
  /** Highest host 1-minute load average among the crossing faults. */
  maxLoadAvg1m?: number;
  evidence: string | null;
  replay: string;
  recordedAt: string;
}

export function ledgerLine(plan: WavePlan, record: TaskRecord, grade: TaskGrade, gitSha: string, evidence: string | null,
  faults: ReadonlyArray<{ faultId: string; loadAvg1m?: number }> = []): LedgerLine {
  const loads = faults.filter(fault => grade.crossingFaults.includes(fault.faultId) && fault.loadAvg1m !== undefined).map(fault => fault.loadAvg1m!);
  const rules = Object.fromEntries(Object.entries(grade.rules).map(([id, rule]) => [id, rule.verdict])) as Record<RuleId, string>;
  const ruleDetails = Object.fromEntries(Object.entries(grade.rules).map(([id, rule]) => [id, rule.detail])) as Record<RuleId, string>;
  return {
    schema: "paperclip.restart-chaos.ledger/v1", waveId: plan.waveId, taskId: record.plan.taskId, seed: plan.seed, gitSha,
    env: plan.options.env, adapter: record.plan.adapter, workload: record.plan.workload, fault: record.plan.fault,
    ...(record.plan.trigger ? { trigger: record.plan.trigger, triggerMissed: record.triggerMissed ?? [] } : {}),
    holdMs: record.plan.holdMs, fireAfterMs: record.plan.fireAfterMs, issue: record.identifier ?? record.issueId,
    crossed: grade.crossed, crossingFaults: grade.crossingFaults, rules, ruleDetails, T: grade.T.verdict, pass: grade.pass,
    ...(loads.length ? { maxLoadAvg1m: Math.max(...loads) } : {}),
    signature: grade.signature, retried: Boolean(record.retry), evidence, replay: replayCommand(plan.waveId, record.plan.taskId),
    recordedAt: new Date().toISOString(),
  };
}

export async function appendLedger(resultsRoot: string, lines: readonly LedgerLine[]) {
  await mkdir(resultsRoot, { recursive: true });
  await appendFile(path.join(resultsRoot, "ledger.jsonl"), lines.map(line => `${JSON.stringify(line)}\n`).join(""), { mode: 0o600 });
}

export async function readLedger(resultsRoot: string): Promise<LedgerLine[]> {
  const text = await readFile(path.join(resultsRoot, "ledger.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as LedgerLine);
}

/** Short summary: per-cell pass rate and open signatures across the ledger. */
export function renderSummary(lines: readonly LedgerLine[], latestWave?: string): string {
  const cells = new Map<string, { pass: number; total: number; crossed: number }>();
  const signatures = new Map<string, { count: number; latest: LedgerLine }>();
  for (const line of lines) {
    const key = `${line.env} · ${line.adapter} · ${line.workload} · ${line.fault}${line.trigger ? ` ^${line.trigger}` : ""}`;
    const cell = cells.get(key) ?? { pass: 0, total: 0, crossed: 0 };
    cell.total += 1; if (line.pass) cell.pass += 1; if (line.crossed) cell.crossed += 1;
    cells.set(key, cell);
    if (line.signature) {
      const entry = signatures.get(line.signature) ?? { count: 0, latest: line };
      entry.count += 1; entry.latest = line;
      signatures.set(line.signature, entry);
    }
  }
  const out = ["# Restart chaos summary", "", `Tasks graded: ${lines.length}; passed: ${lines.filter(line => line.pass).length}; restart-crossing: ${lines.filter(line => line.crossed).length}.`, ""];
  if (latestWave) {
    out.push(`## Latest wave ${latestWave}`, "", "| Task | Cell | Crossed | R1 | R2 | R3 | R4 | R5 | R6 | T | Result |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const line of lines.filter(candidate => candidate.waveId === latestWave)) {
      out.push(`| ${line.taskId} ${line.issue ?? ""} | ${line.adapter} ${line.workload} ${line.fault}${line.trigger ? ` ^${line.trigger}${line.triggerMissed?.length ? " (missed)" : ""}` : ""} | ${line.crossed ? "yes" : "no"} | ${line.rules.R1} | ${line.rules.R2} | ${line.rules.R3} | ${line.rules.R4} | ${line.rules.R5} | ${line.rules.R6} | ${line.T} | ${line.pass ? "PASS" : `FAIL ${line.signature}`} |`);
    }
    out.push("");
  }
  out.push("## Cells", "", "| Cell | Pass | Total | Crossed |", "| --- | --- | --- | --- |");
  for (const [key, cell] of [...cells].sort()) out.push(`| ${key} | ${cell.pass} | ${cell.total} | ${cell.crossed} |`);
  out.push("", "## Open signatures", "");
  if (!signatures.size) out.push("None.");
  for (const [signature, entry] of signatures) out.push(`- \`${signature}\` × ${entry.count} — latest ${entry.latest.waveId}/${entry.latest.taskId}; evidence ${entry.latest.evidence ?? "n/a"}; replay \`${entry.latest.replay}\``);
  out.push("");
  return out.join("\n");
}

export async function writeSummary(resultsRoot: string, latestWave: string) {
  const summary = renderSummary(await readLedger(resultsRoot), latestWave);
  await writeFile(path.join(resultsRoot, "SUMMARY.md"), summary, { mode: 0o600 });
  return summary;
}
