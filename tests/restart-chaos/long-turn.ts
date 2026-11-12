/**
 * `--long-turn-minutes <n>` (15–60): every task's first turn does n minutes of real tool work before its
 * workload, for any cell (README "Long turn").
 *
 * The staging failures of 2026-11-11 followed turns of 14–43 minutes, while every chaos workload finishes in
 * a few minutes. A long turn grows what the run holds when its fault or next wake arrives: the provider
 * session's history, the controller journal, tool receipts and the sandbox's working files.
 *
 * The agent runs one shell command per round, in the foreground, each about 90 s (well short of provider
 * shell-tool timeouts). Each round appends `ROUND <i> <start> <end>` to a log in its working directory and
 * hashes data as it goes. Then it saves the log as the issue document `long-turn` and carries on with the
 * workload. The oracle checks the rounds the agent reported and, from the harness's own observations, that
 * one run of the task ran at least n minutes.
 */
import type { OracleArtifacts, OracleResult } from "./types.js";
import type { WorkloadDefinition } from "./workloads.js";

export const LONG_TURN_MINUTES_RANGE: readonly [number, number] = [15, 60];
/** Seconds of one round (45 ticks of 2 s). */
export const LONG_TURN_ROUND_SECONDS = 90;
export const LONG_TURN_DOCUMENT = "long-turn";
/** Sandbox and host clocks differ, and a round may start a little late: slack on the reported span. */
const SPAN_SLACK_SECONDS = 60;

export function parseLongTurnMinutes(raw: string | undefined): { longTurnMinutes?: number } {
  if (raw === undefined) return {};
  if (!/^[0-9]+$/.test(raw)) throw new Error("--long-turn-minutes takes whole minutes");
  const minutes = Number(raw);
  const [min, max] = LONG_TURN_MINUTES_RANGE;
  if (minutes < min || minutes > max) throw new Error(`--long-turn-minutes must be between ${min} and ${max}`);
  return { longTurnMinutes: minutes };
}

export function longTurnRounds(minutes: number): number {
  return Math.ceil((minutes * 60) / LONG_TURN_ROUND_SECONDS);
}

export const longTurnLog = (nonce: string) => `long-turn-${nonce}.log`;

/** One round: ticks of real work (hashing) with a sleep, then one log line with the round's own clock window. */
export function longTurnCommand(nonce: string, round: number): string {
  const ticks = LONG_TURN_ROUND_SECONDS / 2;
  return `s=$(date +%s); i=0; h=${nonce}; while [ $i -lt ${ticks} ]; do i=$((i+1)); h=$(printf '%s %s' "$h" "$i" | cksum | cut -d' ' -f1); sleep 2; done;`
    + ` echo "ROUND ${round} $s $(date +%s) $h" >> ${longTurnLog(nonce)}; tail -n 1 ${longTurnLog(nonce)}`;
}

export function longTurnPreamble(nonce: string, minutes: number): string {
  const rounds = longTurnRounds(minutes);
  return [
    `Before anything else in this task, do about ${minutes} minutes of preparation in your working directory, in this same turn.`,
    `Run this shell command ${rounds} times, once per round, as separate tool calls in the foreground, replacing <N> with the round number 1 to ${rounds}`,
    `(each takes about ${LONG_TURN_ROUND_SECONDS} seconds; do not run rounds in the background or in parallel, and do not skip or shorten any):`,
    `\`${longTurnCommand(nonce, 0).replace("ROUND 0 ", "ROUND <N> ")}\``,
    `After the last round, save the full contents of \`${longTurnLog(nonce)}\` as this issue's document with key \`${LONG_TURN_DOCUMENT}\``,
    "(title \"Long turn\"), exactly as the file reads. Then, still in this turn, do the task below.",
    "",
  ].join("\n");
}

/** The rounds the agent reported, in order. */
export function parseLongTurnLog(text: string | null | undefined): Array<{ round: number; start: number; end: number }> {
  return (text ?? "").split(/\r?\n/).flatMap(line => {
    const match = /^\s*ROUND ([0-9]+) ([0-9]{9,11}) ([0-9]{9,11})(?: \S+)?\s*$/.exec(line);
    return match ? [{ round: Number(match[1]), start: Number(match[2]), end: Number(match[3]) }] : [];
  });
}

export function longTurnChecks(minutes: number, artifacts: Pick<OracleArtifacts, "documents" | "runs">): OracleResult["checks"] {
  const rounds = parseLongTurnLog(artifacts.documents[LONG_TURN_DOCUMENT]);
  const wanted = longTurnRounds(minutes);
  const complete = rounds.length >= wanted && rounds.slice(0, wanted).every((entry, index) => entry.round === index + 1
    && entry.end - entry.start >= LONG_TURN_ROUND_SECONDS - 10);
  const span = rounds.length ? rounds[rounds.length - 1]!.end - rounds[0]!.start : 0;
  // The harness's own evidence: a run of the task that ran for the whole turn.
  const longest = Math.max(0, ...(artifacts.runs ?? []).map(run => {
    const started = Date.parse(run.createdAt ?? ""), finished = Date.parse(run.finishedAt ?? "");
    return Number.isFinite(started) && Number.isFinite(finished) ? (finished - started) / 1000 : 0;
  }));
  return [
    { name: "long_turn_rounds", ok: complete && span >= minutes * 60 - SPAN_SLACK_SECONDS,
      detail: `rounds=${rounds.length}/${wanted} span=${span}s` },
    { name: "long_turn_run_observed", ok: longest >= minutes * 60 - SPAN_SLACK_SECONDS, detail: `longest run ${Math.round(longest)}s` },
  ];
}

/** The workload with the long turn in front: description, budget, collected documents and oracle. */
export function withLongTurn(definition: WorkloadDefinition, minutes: number | undefined): WorkloadDefinition {
  if (!minutes) return definition;
  return {
    ...definition,
    budgetMs: definition.budgetMs + minutes * 60_000,
    description: (nonce, agents) => `${longTurnPreamble(nonce, minutes)}${definition.description(nonce, agents)}`,
    collect: { ...definition.collect, documents: [...new Set([...definition.collect.documents, LONG_TURN_DOCUMENT])] },
    grade(nonce, artifacts, agents) {
      const base = definition.grade(nonce, artifacts, agents);
      const checks = [...base.checks, ...longTurnChecks(minutes, artifacts)];
      return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
    },
  };
}
