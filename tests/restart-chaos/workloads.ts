import { questionHandoffWorkload, questionSequenceWorkload } from "./question-handoff.js";
import { l1Workload } from "./contention.js";
import { journeyWorkloadDefinitions } from "./journeys.js";
import { rewakeWorkloadDefinitions } from "./rewake.js";
import { stagingMixWorkloadDefinition } from "./staging-mix.js";
import type { OracleArtifacts, OracleResult, WorkloadId } from "./types.js";

/** Deterministic bench output: sum of squares 1..240. */
export const BENCH_STEPS = 240;
export const BENCH_EXPECTED = `BENCH_RESULT=${(BENCH_STEPS * (BENCH_STEPS + 1) * (2 * BENCH_STEPS + 1)) / 6}`;

export interface WorkloadDefinition {
  id: WorkloadId;
  label: string;
  usesRepository: boolean;
  /** Fault fire offset from issue creation (seeded uniform). */
  fireWindowMs: readonly [number, number];
  followUpWindowMs?: readonly [number, number];
  /** Time budget for the task excluding outage time (R1). */
  budgetMs: number;
  title(nonce: string): string;
  description(nonce: string, agents?: WorkloadAgents): string;
  followUp?(nonce: string): string;
  startComment?(nonce: string): string;
  stopBeforeFollowUp?: boolean;
  /** Files and commands the observer must collect for the T-oracle. */
  collect: { documents: string[]; files(nonce: string): string[]; commands: Array<{ name: string; argv: string[] | ((nonce: string) => string[]) }>;
    childDocuments?: string[] };
  grade(nonce: string, artifacts: OracleArtifacts, agents?: WorkloadAgents): OracleResult;
}

export interface WorkloadAgents { self: { id: string; name: string }; other: { id: string; name: string }; companyId?: string }

/** G1: the board's decision for this task, fixed by its nonce (about half approve, half reject). */
export function g1Decision(nonce: string): "approve" | "reject" {
  return Number.parseInt(nonce.slice(0, 1), 16) % 2 === 0 ? "approve" : "reject";
}
export const g1ApprovalTitle = (nonce: string) => `Approve G1-${nonce}`;
export const g1ChildTitle = (nonce: string) => `Approved G1-${nonce}`;

const partMarker = (nonce: string, part: number) => `PART${part}-${nonce}`;

const briefMarker = (nonce: string) => `CHAOS-${nonce}`;
const followUpMarker = (nonce: string) => `FOLLOWUP-${nonce}`;
const continueMarker = (nonce: string) => `CONTINUE-${nonce}`;
const notesFile = (nonce: string) => `NOTES-${nonce}.md`;
/** F1: the absolute symlink the agent creates and keeps in the repository root. */
export const f1LinkName = (nonce: string) => `hosts-link-${nonce}`;
/** T1: ticks of the long tool (2 s each) and the line the agent reports after it finished. */
export const T1_TICKS = 50;
export const t1Marker = (nonce: string) => `TICKS-${nonce}`;
/** Prints `<ticks> start=<epoch s> end=<epoch s>`: the loop's own clock window, so the harness can check a fault crossed it. */
export const t1Command = (nonce: string) =>
  `s=$(date +%s); i=0; while [ $i -lt ${T1_TICKS} ]; do i=$((i+1)); echo tick-$i; sleep 2; done > ticks-${nonce}.txt;`
  + ` echo "$(wc -l < ticks-${nonce}.txt | tr -d ' ') start=$s end=$(date +%s)"`;

/** The brief's first line, `TICKS-<nonce>=<ticks> start=<s> end=<s>`, parsed; null when it does not match. */
export function parseT1Report(nonce: string, brief: string | null | undefined): { ticks: number; startMs: number; endMs: number } | null {
  const first = (brief ?? "").split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
  const match = new RegExp(`^${t1Marker(nonce)}=([0-9]+) start=([0-9]{9,11}) end=([0-9]{9,11})$`).exec(first);
  if (!match) return null;
  const [ticks, start, end] = [Number(match[1]), Number(match[2]) * 1000, Number(match[3]) * 1000];
  return end >= start ? { ticks, startMs: start, endMs: end } : null;
}

/** Sandbox and host clocks are not the same clock: a fault this close to the loop's edges still counts as crossing it. */
export const T1_CLOCK_SLACK_MS = 5_000;

/**
 * T1 tested a mid-tool fault only if one of the task's own faults started while the loop ran. A fault that landed
 * during preparation, with the loop run afterwards, tested nothing mid-tool: the task fails `fault_crossed_tool`,
 * as a provider-fault task whose fault never applied does.
 */
export function withT1CrossingCheck(oracle: OracleResult, plan: { taskId: string; workload: WorkloadId; nonce: string; fault: string },
  brief: string | null | undefined, faults: ReadonlyArray<{ requestedBy: string; startedAt: number; faultId: string }>): OracleResult {
  // A matrix baseline (K0) expects no fault, a provider message fault (PV*) restarts nothing of its own, and CR5
  // stalls the plugin at launch, before the tool loop starts (class-r.ts).
  if (plan.workload !== "T1" || plan.fault === "K0" || plan.fault.startsWith("PV") || plan.fault === "CR5") return oracle;
  const report = parseT1Report(plan.nonce, brief);
  // A storm task (K13) has no fault of its own: the storm's faults (requested by "storm") are the ones that cross it.
  const own = faults.filter(fault => fault.requestedBy === plan.taskId || (plan.fault === "K13" && fault.requestedBy === "storm"));
  const crossing = report ? own.filter(fault => fault.startedAt >= report.startMs - T1_CLOCK_SLACK_MS
    && fault.startedAt <= report.endMs + T1_CLOCK_SLACK_MS) : [];
  const check = { name: "fault_crossed_tool", ok: crossing.length > 0,
    detail: report ? `loop ${new Date(report.startMs).toISOString()}..${new Date(report.endMs).toISOString()}; `
      + `faults ${own.map(fault => `${fault.faultId}@${new Date(fault.startedAt).toISOString()}`).join(",") || "none"}`
      : "no loop window reported" };
  const checks = [...oracle.checks, check];
  return { ...oracle, checks, verdict: checks.every(entry => entry.ok) ? "pass" : "fail" };
}
/** F1: an `ls -l` line for that link: a symlink (`l` mode) naming the link and its absolute target. */
export const f1LinkListing = (nonce: string) => new RegExp(`^l\\S*\\s.*\\s${f1LinkName(nonce)} -> /etc/hosts$`);
const benchFile = (nonce: string) => `bench-result-${nonce}.txt`;
const benchRecord = (nonce: string) => `.bench/run-${nonce}.txt`;
const r1Module = (nonce: string) => `packages/shared/src/chaos/slug-${nonce}.ts`;
const r1Test = (nonce: string) => `packages/shared/src/chaos/slug-${nonce}.test.ts`;

export function r1TestChecksSlug(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.includes("node:test") && text.includes("node:assert") && /\bassert(\.\w+)?\s*\(/.test(text)
    && text.includes("chaosSlug") && text.includes("hello-chaos-world");
}
/** bench.sh must have actually run: at least this long between start and finish. */
export const BENCH_MIN_SECONDS = 200;
/** B5: distinct progress values the harness must have observed itself while polling. */
export const BENCH_MIN_OBSERVED_PROGRESS = 3;

/** Parse bench.sh's own completion record: `started=<epoch> finished=<epoch> result=<line>`. */
export function parseBenchRecord(text: string | null | undefined) {
  const fields = Object.fromEntries((text ?? "").trim().split(/\s+/).map(part => part.split("=")).filter(pair => pair.length >= 2)
    .map(([key, ...rest]) => [key!, rest.join("=")]));
  const started = Number(fields.started), finished = Number(fields.finished);
  return Number.isFinite(started) && Number.isFinite(finished) && fields.result
    ? { seconds: finished - started, result: fields.result } : null;
}

export function stallWakeChecks(artifacts: OracleArtifacts): OracleResult["checks"] {
  const stalls = artifacts.childStalls ?? [];
  if (!stalls.length) return [];
  const wakes = artifacts.stallWakes ?? [];
  const matching = (stall: { childIssueId: string; recoveryActionId: string | null }) => wakes.filter(wake =>
    wake.stalledIssueId === stall.childIssueId && (stall.recoveryActionId === null || wake.recoveryActionId === stall.recoveryActionId));
  const unwoken = stalls.filter(stall => matching(stall).length === 0).map(stall => `${stall.childIssueId}:${stall.recoveryActionId}`);
  const perPair = new Map<string, number>();
  for (const wake of wakes) perPair.set(`${wake.stalledIssueId}:${wake.recoveryActionId}`, (perPair.get(`${wake.stalledIssueId}:${wake.recoveryActionId}`) ?? 0) + 1);
  const repeated = [...perPair.entries()].filter(([, count]) => count > 1).map(([key]) => key);
  return [{ name: "parent_woken_once_per_stall", ok: !unwoken.length && !repeated.length,
    detail: `stalls=${stalls.length} wakes=${wakes.length}${unwoken.length ? ` unwoken=${unwoken.join(",")}` : ""}${repeated.length ? ` repeated=${repeated.join(",")}` : ""}` }];
}

function result(checks: OracleResult["checks"]): OracleResult {
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

function statusCheck(artifacts: OracleArtifacts) {
  return { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` };
}

function briefChecks(body: string | null | undefined, markers: string[]) {
  const text = body ?? "";
  const bullets = text.split(/\r?\n/).filter(line => /^\s*[-*] \S/.test(line)).length;
  return [
    { name: "brief_document_present", ok: body != null && text.trim().length > 0 },
    ...markers.map(marker => ({ name: `brief_contains_${marker.split("-")[0]!.toLowerCase()}_marker`, ok: text.includes(marker), detail: marker })),
    { name: "brief_has_three_bullets", ok: bullets >= 3, detail: `bullets=${bullets}` },
  ];
}

const briefDescription = (nonce: string) => [
  "Write a short brief on why idempotent retries matter for background job queues.",
  "Save it as this issue's document with key `brief` (title \"Brief\"), in markdown.",
  `The document must contain the line \`${briefMarker(nonce)}\` exactly, on its own line,`,
  "and at least three bullet points that start with \"- \".",
  "Do not create files or other tasks. When the document is saved, mark this task done.",
].join("\n");

/** H2: the brief, then the agent's own last step hands the task to the person who created it, in review. */
const handoffDescription = (nonce: string) => [
  "Write a short brief on why idempotent retries matter for background job queues.",
  "Save it as this issue's document with key `brief` (title \"Brief\"), in markdown.",
  `The document must contain the line \`${briefMarker(nonce)}\` exactly, on its own line,`,
  "and at least three bullet points that start with \"- \".",
  "Do not create files or other tasks. Do not mark this task done.",
  "When the document is saved, hand this task to the person who created it for review, as your last step:",
  "update this task with `assigneeAgentId` null, `assigneeUserId` set to the task's `createdByUserId`, and status `in_review`.",
  "Then end your turn.",
].join("\n");

/**
 * H2 (staging class H): the agent's own hand-off to a person must not cancel its run. The task rests in review with
 * that person, every run of the task settled without `issue_reassigned`, and nothing blocks the task's execution.
 */
export function handoffChecks(artifacts: OracleArtifacts): OracleResult["checks"] {
  const handoff = artifacts.handoff;
  const runs = handoff?.runs ?? null;
  const reassignedRuns = (runs ?? []).filter(run => run.errorCode === "issue_reassigned").map(run => run.id);
  // A restart after the hand-off settles the run as failed (it is not resumed without the task); it must settle.
  const unsettled = (runs ?? []).filter(run => !["succeeded", "cancelled", "failed", "timed_out"].includes(run.status));
  return [
    { name: "issue_in_review", ok: artifacts.issueStatus === "in_review", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
    { name: "handed_to_creator", ok: Boolean(handoff?.createdByUserId) && handoff!.assigneeAgentId === null
        && handoff!.assigneeUserId === handoff!.createdByUserId,
      detail: `agent=${handoff?.assigneeAgentId ?? "none"} user=${handoff?.assigneeUserId ?? "none"} creator=${handoff?.createdByUserId ?? "none"}` },
    { name: "handoff_did_not_cancel_run", ok: Boolean(runs?.length) && reassignedRuns.length === 0 && unsettled.length === 0,
      detail: runs === null ? "run history unavailable" : reassignedRuns.length ? `issue_reassigned=${reassignedRuns.join(",")}`
        : `runs=${runs.map(run => `${run.id}:${run.status}`).join(",") || "none"}` },
    { name: "no_execution_blocker", ok: Boolean(handoff) && !handoff!.executionBlocker && !handoff!.activeRecoveryAction,
      detail: `blocker=${handoff?.executionBlocker ?? "unknown"} recovery=${handoff?.activeRecoveryAction ?? "unknown"}` },
  ];
}

const delegateDescription = (nonce: string, agents?: WorkloadAgents) => {
  const self = agents?.self.name ?? "yourself";
  const other = agents?.other.name ?? "yourself";
  return [
    "Coordinate this task by delegating it to two subtasks, then summarize.",
    `1. Create subtask "Part 1 ${nonce}" with this task as its parent, assigned to ${other}. Its description:`,
    `   "Save this issue's document with key \`part\` (title \"Part\"), in markdown, containing the line \`${partMarker(nonce, 1)}\` exactly on its own line and one sentence on why retries need idempotency keys. Then mark this subtask done."`,
    `2. Create subtask "Part 2 ${nonce}" with this task as its parent, assigned to ${self}. Same description, with the line \`${partMarker(nonce, 2)}\` instead.`,
    "Do not do the subtasks' work yourself. Wait until both subtasks are done.",
    `3. Then save this issue's document with key \`summary\` (title "Summary") containing both lines \`${partMarker(nonce, 1)}\` and \`${partMarker(nonce, 2)}\`, each on its own line.`,
    "Then mark this task done.",
  ].join("\n");
};

const approvalDescription = (nonce: string, agents?: WorkloadAgents) => [
  "This task needs the board's approval before you act.",
  "1. Request approval exactly once with the `call_api` tool: operationId `POST /api/companies/{companyId}/approvals`,"
    + ` pathParams \`{ "companyId": "${agents?.companyId ?? "<your company id>"}" }\`, and this body:`,
  `   \`{ "type": "request_board_approval", "issueIds": ["<this task's id>"], "payload": { "title": "${g1ApprovalTitle(nonce)}",`
    + ` "summary": "Create the follow-up subtask for ${nonce}.", "recommendedAction": "Approve", "risks": [] } }\``,
  "2. Then set this task's status to `blocked` and end your turn. Do not create anything else yet.",
  `3. Only if you are woken because that approval was approved: create exactly one subtask titled "${g1ChildTitle(nonce)}"`,
  "   with this task as its parent and status `backlog`, unassigned. Then mark this task done.",
  "If the approval is rejected, do not create the subtask.",
].join("\n");

function approvalChecks(nonce: string, artifacts: OracleArtifacts) {
  const decision = g1Decision(nonce);
  const governance = artifacts.governance;
  const approvals = (artifacts.approvals ?? []).filter(approval => approval.title === null || approval.title.includes(nonce));
  const children = (artifacts.children ?? []).filter(child => (child.title ?? "").includes(g1ChildTitle(nonce)));
  return [
    { name: "issue_status", ok: artifacts.issueStatus === (decision === "approve" ? "done" : "cancelled"),
      detail: `decision=${decision} status=${artifacts.issueStatus ?? "unknown"}` },
    // The agent's create is not idempotent: a restart that makes it ask twice is a finding.
    { name: "one_approval_requested", ok: approvals.length === 1, detail: `approvals=${approvals.length}` },
    { name: "board_decided_after_restart", ok: governance?.decision !== undefined && governance.decision.error === null
      && governance.decision.afterFault, detail: JSON.stringify(governance?.decision ?? null) },
    { name: "approval_pending_across_restart", ok: governance?.decision?.pendingWhenDecided === true },
    { name: "action_gated_by_approval", ok: governance?.childrenBeforeDecision === 0,
      detail: `subtasks_before_decision=${governance?.childrenBeforeDecision ?? "not checked"}` },
    { name: "approval_decided", ok: approvals.length === 1 && approvals[0]!.status === (decision === "approve" ? "approved" : "rejected"),
      detail: approvals.map(approval => approval.status).join(",") },
    { name: decision === "approve" ? "approved_action_ran_once" : "rejected_action_never_ran",
      ok: children.length === (decision === "approve" ? 1 : 0), detail: `subtasks=${children.length}` },
  ];
}

function budgetChecks(artifacts: OracleArtifacts) {
  const governance = artifacts.governance;
  return [
    { name: "budget_set", ok: typeof governance?.budgetSetCents === "number" && !governance.budgetSetError,
      detail: governance?.budgetSetError ?? `budget=${governance?.budgetSetCents ?? "unset"}` },
    { name: "company_paused_for_budget", ok: typeof governance?.budgetPausedAt === "number" },
    { name: "pause_held_until_resume", ok: typeof governance?.budgetPausedAt === "number" && !governance.pauseLostAt },
    { name: "nothing_dispatched_while_paused", ok: governance?.runsStartedWhilePaused !== undefined && governance.runsStartedWhilePaused.length === 0,
      detail: (governance?.runsStartedWhilePaused ?? ["not checked"]).join(",") },
    { name: "board_resumed_after_restart", ok: governance?.resume !== undefined && governance.resume.error === null && governance.resume.afterFault,
      detail: JSON.stringify(governance?.resume ?? null) },
    { name: "company_active_at_rest", ok: governance?.companyActiveAtRest === true },
  ];
}

export const workloadDefinitions: Record<WorkloadId, WorkloadDefinition> = {
  Q1: questionHandoffWorkload,
  Q4: questionSequenceWorkload,
  L1: l1Workload,
  ...journeyWorkloadDefinitions,
  ...rewakeWorkloadDefinitions,
  SM: stagingMixWorkloadDefinition,
  G1: {
    id: "G1",
    label: "Approval-gated action across a restart",
    usesRepository: false,
    // The `approval` trigger fires on the pending approval; a `time` fault lands around it.
    fireWindowMs: [20_000, 90_000],
    budgetMs: 15 * 60_000,
    title: nonce => `Chaos G1 approval ${nonce}`,
    description: approvalDescription,
    collect: { documents: [], files: () => [], commands: [], childDocuments: [] },
    grade(nonce, artifacts) {
      return result(approvalChecks(nonce, artifacts));
    },
  },
  H1: {
    id: "H1",
    label: "Budget hard stop crossed mid-run, across a restart",
    usesRepository: false,
    fireWindowMs: [15_000, 60_000],
    budgetMs: 15 * 60_000,
    title: nonce => `Chaos H1 budget ${nonce}`,
    description: briefDescription,
    collect: { documents: ["brief"], files: () => [], commands: [] },
    grade(nonce, artifacts) {
      return result([statusCheck(artifacts), ...briefChecks(artifacts.documents.brief, [briefMarker(nonce)]), ...budgetChecks(artifacts)]);
    },
  },
  H2: {
    id: "H2",
    label: "The agent's own hand-off to a person, in review",
    usesRepository: false,
    fireWindowMs: [10_000, 45_000],
    budgetMs: 10 * 60_000,
    title: nonce => `Chaos H2 handoff ${nonce}`,
    description: handoffDescription,
    collect: { documents: ["brief"], files: () => [], commands: [] },
    grade(nonce, artifacts) {
      return result([...handoffChecks(artifacts), ...briefChecks(artifacts.documents.brief, [briefMarker(nonce)])]);
    },
  },
  M1: {
    id: "M1",
    label: "Delegate to two subtasks",
    usesRepository: false,
    fireWindowMs: [20_000, 120_000],
    budgetMs: 20 * 60_000,
    title: nonce => `Chaos M1 delegation ${nonce}`,
    description: delegateDescription,
    collect: { documents: ["summary"], files: () => [], commands: [], childDocuments: ["part"] },
    grade(nonce, artifacts, agents) {
      const children = artifacts.children ?? [];
      const holders = (n: number) => children.filter(child => (child.documents.part ?? "").includes(partMarker(nonce, n)));
      const part1 = holders(1), part2 = holders(2);
      const distinct = part1.length === 1 && part2.length === 1 && part1[0]!.id !== part2[0]!.id;
      const summary = artifacts.documents.summary ?? "";
      return result([
        statusCheck(artifacts),
        { name: "two_agents", ok: Boolean(agents) && agents!.self.id !== agents!.other.id,
          detail: agents ? `self=${agents.self.id} other=${agents.other.id}` : "no agents" },
        { name: "two_subtasks", ok: children.length === 2, detail: `children=${children.length}` },
        { name: "subtasks_done", ok: children.length > 0 && children.every(child => child.status === "done"),
          detail: children.map(child => child.status).join(",") },
        { name: "parts_in_distinct_subtasks", ok: distinct, detail: `part1=${part1.length} part2=${part2.length}` },
        { name: "part1_delegated", ok: distinct && Boolean(agents) && part1[0]!.assigneeAgentId === agents!.other.id,
          detail: `assignee=${part1[0]?.assigneeAgentId ?? "none"}` },
        { name: "part2_kept", ok: distinct && Boolean(agents) && part2[0]!.assigneeAgentId === agents!.self.id,
          detail: `assignee=${part2[0]?.assigneeAgentId ?? "none"}` },
        { name: "summary_has_both_parts", ok: summary.includes(partMarker(nonce, 1)) && summary.includes(partMarker(nonce, 2)) },
        ...stallWakeChecks(artifacts),
      ]);
    },
  },
  A1: {
    id: "A1",
    label: "Brief to issue document",
    usesRepository: false,
    fireWindowMs: [10_000, 45_000],
    budgetMs: 10 * 60_000,
    title: nonce => `Chaos A1 brief ${nonce}`,
    description: briefDescription,
    collect: { documents: ["brief"], files: () => [], commands: [] },
    grade(nonce, artifacts) {
      return result([statusCheck(artifacts), ...briefChecks(artifacts.documents.brief, [briefMarker(nonce)])]);
    },
  },
  C1: {
    id: "C1",
    label: "Comment while running",
    usesRepository: false,
    fireWindowMs: [20_000, 60_000],
    followUpWindowMs: [8_000, 25_000],
    budgetMs: 12 * 60_000,
    title: nonce => `Chaos C1 brief with follow-up ${nonce}`,
    description: briefDescription,
    followUp: nonce => `Additional requirement for this task: also include the line \`${followUpMarker(nonce)}\` on its own line in the \`brief\` document before you mark the task done.`,
    collect: { documents: ["brief"], files: () => [], commands: [] },
    grade(nonce, artifacts) {
      return result([statusCheck(artifacts), ...briefChecks(artifacts.documents.brief, [briefMarker(nonce), followUpMarker(nonce)])]);
    },
  },
  S1: {
    id: "S1",
    label: "Stop while running, then continue",
    usesRepository: false,
    fireWindowMs: [20_000, 60_000],
    followUpWindowMs: [8_000, 25_000],
    budgetMs: 12 * 60_000,
    title: nonce => `Chaos S1 brief stopped and continued ${nonce}`,
    description: briefDescription,
    stopBeforeFollowUp: true,
    followUp: nonce => `I stopped your previous run on purpose. Please continue the task now: finish the \`brief\` document and also include the line \`${continueMarker(nonce)}\` on its own line before you mark the task done.`,
    collect: { documents: ["brief"], files: () => [], commands: [] },
    grade(nonce, artifacts) {
      const stop = artifacts.stop;
      return result([
        statusCheck(artifacts),
        ...briefChecks(artifacts.documents.brief, [briefMarker(nonce), continueMarker(nonce)]),
        { name: "stop_took_effect", ok: Boolean(stop?.missed) || stop?.runStatus === "cancelled",
          detail: stop?.missed ? "missed: the run finished before the stop window" : `run=${stop?.runId ?? "none"} status=${stop?.runStatus ?? "none"}` },
        { name: "nothing_ran_after_stop", ok: Boolean(stop) && stop!.continuePosted && stop!.runsStartedBeforeContinue.length === 0,
          detail: stop ? `continue=${stop.continuePosted} runs=${stop.runsStartedBeforeContinue.join(",") || "none"}` : "not stopped" },
      ]);
    },
  },
  B1: {
    id: "B1",
    label: "Python CLI with tests",
    usesRepository: true,
    fireWindowMs: [20_000, 90_000],
    budgetMs: 15 * 60_000,
    title: nonce => `Chaos B1 slugify command ${nonce}`,
    description: nonce => [
      "Work in this task's repository workspace (a small Python CLI called chaoscli).",
      "Implement the `slugify` subcommand in `chaoscli/cli.py` so that",
      "`python3 -m chaoscli slugify \"Hello Chaos World\"` prints `hello-chaos-world`",
      "(lowercase, runs of non-alphanumeric characters become a single `-`, no leading or trailing `-`).",
      "The currently failing test must pass: run `python3 -m unittest discover -s tests -v`.",
      `Also create \`${notesFile(nonce)}\` in the repository root containing exactly the line \`B1-${nonce}\`.`,
      "Use only the Python standard library. Do not run ./bench.sh. When the tests pass, mark this task done.",
    ].join("\n"),
    collect: {
      documents: [],
      files: nonce => [notesFile(nonce), "chaoscli/cli.py"],
      commands: [
        { name: "unittest", argv: ["python3", "-m", "unittest", "discover", "-s", "tests"] },
        { name: "slugify", argv: ["python3", "-m", "chaoscli", "slugify", "Hello Chaos World"] },
      ],
    },
    grade(nonce, artifacts) {
      const tests = artifacts.commands.unittest;
      const slug = artifacts.commands.slugify;
      return result([
        statusCheck(artifacts),
        { name: "workspace_located", ok: artifacts.workspacePath !== null },
        { name: "unittest_passes", ok: tests?.exitCode === 0, detail: `exit=${tests?.exitCode ?? "not run"}` },
        { name: "slugify_output", ok: slug?.exitCode === 0 && slug.stdout.trim() === "hello-chaos-world", detail: JSON.stringify(slug?.stdout.trim() ?? null) },
        { name: "notes_file", ok: artifacts.files[notesFile(nonce)]?.trim() === `B1-${nonce}` },
      ]);
    },
  },
  F1: {
    // Staging class F (doc/plans/2026-11-11-staging-failures-vs-chaos-coverage.md): a remote save-back refused
    // an absolute symlink (`remote_workspace_archive_unsafe_symlink`), exhausted its retries and left the task
    // blocked. Agents create such links in ordinary work (tool caches, `node_modules/.bin`). The oracle expects
    // the task to finish with its result saved, with no Retry; how the link itself is saved is the product's choice.
    id: "F1",
    label: "Absolute symlink kept in the repository workspace",
    usesRepository: true,
    fireWindowMs: [20_000, 90_000],
    budgetMs: 12 * 60_000,
    title: nonce => `Chaos F1 workspace link ${nonce}`,
    description: nonce => [
      "Work in this task's repository workspace (a small Python CLI called chaoscli).",
      `Run \`ln -s /etc/hosts ${f1LinkName(nonce)}\` in the repository root to create a symbolic link, and keep it.`,
      `Create \`${notesFile(nonce)}\` in the repository root. Its first line is exactly \`F1-${nonce}\`.`,
      `Its second line is the exact output of \`ls -l ${f1LinkName(nonce)}\`, run after you created the link.`,
      "Do not change any other file and do not run ./bench.sh. Then mark this task done.",
    ].join("\n"),
    collect: { documents: [], files: nonce => [notesFile(nonce)], commands: [] },
    grade(nonce, artifacts) {
      const lines = (artifacts.files[notesFile(nonce)] ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      return result([
        statusCheck(artifacts),
        { name: "workspace_located", ok: artifacts.workspacePath !== null },
        { name: "notes_file", ok: lines[0] === `F1-${nonce}` },
        // Proof the absolute link was in the workspace before the save-back: the agent's own `ls -l` output, saved
        // with the notes file. Best-effort against an agent that invents it; how the link itself is saved is not graded.
        { name: "link_listed", ok: f1LinkListing(nonce).test(lines[1] ?? ""), detail: JSON.stringify((lines[1] ?? "").slice(0, 160)) },
      ]);
    },
  },
  T1: {
    // Staging class R (`runner_remote_process_identity_unavailable`): the controller went away mid-turn while a
    // tool ran in the sandbox, and recovery 4–7 minutes later found the remote Runner gone. T1 keeps one shell
    // tool running for about 100 s (short of provider shell-tool timeouts), so a fault in its window lands mid-tool.
    id: "T1",
    label: "Long shell tool in the agent's workspace",
    usesRepository: false,
    fireWindowMs: [35_000, 80_000],
    budgetMs: 15 * 60_000,
    title: nonce => `Chaos T1 long tool ${nonce}`,
    description: nonce => [
      "Run this exact shell command in your working directory as one tool call, in the foreground, and wait for it to finish",
      `(about 100 seconds; do not run it in the background): \`${t1Command(nonce)}\``,
      `Then save this issue's document with key \`brief\` (title "Brief"). Its first line is \`${t1Marker(nonce)}=<the exact line the command printed>\`.`,
      "Do not create other files or tasks. When the document is saved, mark this task done.",
    ].join("\n"),
    collect: { documents: ["brief"], files: () => [], commands: [] },
    grade(nonce, artifacts) {
      const report = parseT1Report(nonce, artifacts.documents.brief);
      const first = (artifacts.documents.brief ?? "").split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
      return result([
        statusCheck(artifacts),
        { name: "tool_finished", ok: report?.ticks === T1_TICKS, detail: JSON.stringify(first.slice(0, 120)) },
      ]);
    },
  },
  R1: {
    id: "R1",
    label: "Code change in a Paperclip clone",
    usesRepository: true,
    fireWindowMs: [20_000, 90_000],
    budgetMs: 15 * 60_000,
    title: nonce => `Chaos R1 slug module ${nonce}`,
    description: nonce => [
      "Work in this task's repository workspace, a clone of the Paperclip repository.",
      `Add \`${r1Module(nonce)}\` exporting \`chaosSlug(input: string): string\`: lowercase, every run of characters`,
      "other than a-z and 0-9 becomes a single `-`, and no leading or trailing `-`.",
      `Add \`${r1Test(nonce)}\` that uses \`node:test\` and \`node:assert/strict\`, imports \`./slug-${nonce}.ts\`,`,
      "and checks at least three cases, including `chaosSlug(\"Hello Chaos World\") === \"hello-chaos-world\"`.",
      `Run \`node --test ${r1Test(nonce)}\` from the repository root until it passes.`,
      "Do not install dependencies and do not change any other file. Then mark this task done.",
    ].join("\n"),
    collect: {
      documents: [],
      files: nonce => [r1Module(nonce), r1Test(nonce)],
      commands: [
        { name: "node_test", argv: nonce => [process.execPath, "--test", r1Test(nonce)] },
        { name: "slug", argv: nonce => [process.execPath, "--input-type=module", "-e",
          `import { chaosSlug } from "./${r1Module(nonce)}"; console.log(JSON.stringify(["Hello Chaos World", "  R1 -- Paperclip__Chaos 2026! "].map(chaosSlug)));`] },
      ],
    },
    grade(nonce, artifacts) {
      const tests = artifacts.commands.node_test;
      const slug = artifacts.commands.slug;
      return result([
        statusCheck(artifacts),
        { name: "workspace_located", ok: artifacts.workspacePath !== null },
        { name: "module_present", ok: typeof artifacts.files[r1Module(nonce)] === "string" },
        { name: "test_checks_chaos_slug", ok: r1TestChecksSlug(artifacts.files[r1Test(nonce)]) },
        { name: "node_test_passes", ok: tests?.exitCode === 0, detail: `exit=${tests?.exitCode ?? "not run"}` },
        { name: "required_and_hidden_cases", ok: slug?.exitCode === 0 && slug.stdout.trim() === JSON.stringify(["hello-chaos-world", "r1-paperclip-chaos-2026"]),
          detail: JSON.stringify(slug?.stdout.trim() ?? null) },
      ]);
    },
  },
  B5: {
    id: "B5",
    label: "Long bench.sh run",
    usesRepository: true,
    fireWindowMs: [60_000, 180_000],
    budgetMs: 20 * 60_000,
    title: nonce => `Chaos B5 bench ${nonce}`,
    description: nonce => [
      "Work in this task's repository workspace.",
      `Run \`./bench.sh ${nonce}\` from the repository root in the foreground and wait for it to finish.`,
      "It takes about four minutes; if your shell tool has a timeout, set it to at least 10 minutes. Do not background or interrupt it.",
      "It prints one line of the form `BENCH_RESULT=<number>`.",
      `Write exactly that line into a new file \`${benchFile(nonce)}\` in the repository root.`,
      "Do not compute the result yourself and do not edit bench.sh. Then mark this task done.",
    ].join("\n"),
    collect: { documents: [], files: nonce => [benchFile(nonce), benchRecord(nonce)], commands: [] },
    grade(nonce, artifacts) {
      const content = artifacts.files[benchFile(nonce)]?.trim() ?? null;
      const record = parseBenchRecord(artifacts.files[benchRecord(nonce)]);
      return result([
        statusCheck(artifacts),
        { name: "workspace_located", ok: artifacts.workspacePath !== null },
        { name: "bench_result_file", ok: content === BENCH_EXPECTED, detail: JSON.stringify(content) },
        { name: "bench_actually_ran", ok: record !== null && record.result === BENCH_EXPECTED && record.seconds >= BENCH_MIN_SECONDS,
          detail: record ? `ran ${record.seconds}s, ${record.result}` : "no completion record from bench.sh" },
        // The record is agent-writable; the harness's own progress observations are not.
        { name: "bench_progress_observed", ok: (artifacts.benchProgressObserved ?? 0) >= BENCH_MIN_OBSERVED_PROGRESS,
          detail: `observed ${artifacts.benchProgressObserved ?? 0} progress values` },
      ]);
    },
  },
};

/** Files committed into the `chaos-sandbox` fixture repository. */
export function fixtureRepositoryFiles(benchSeconds = 240): Record<string, { content: string; mode?: number }> {
  return {
    "README.md": { content: "# chaos-sandbox\n\nFixture repository for the Paperclip restart chaos harness.\n" },
    "chaoscli/__init__.py": { content: "" },
    "chaoscli/__main__.py": { content: "from chaoscli.cli import main\n\nraise SystemExit(main())\n" },
    "chaoscli/cli.py": { content: [
      "import argparse",
      "import sys",
      "",
      "",
      "def greet(name: str) -> str:",
      "    return f\"hello, {name}\"",
      "",
      "",
      "def slugify(text: str) -> str:",
      "    raise NotImplementedError(\"slugify is not implemented yet\")",
      "",
      "",
      "def main(argv=None) -> int:",
      "    parser = argparse.ArgumentParser(prog=\"chaoscli\")",
      "    commands = parser.add_subparsers(dest=\"command\", required=True)",
      "    greet_parser = commands.add_parser(\"greet\")",
      "    greet_parser.add_argument(\"name\")",
      "    args = parser.parse_args(argv)",
      "    if args.command == \"greet\":",
      "        print(greet(args.name))",
      "        return 0",
      "    return 2",
      "",
    ].join("\n") },
    "tests/__init__.py": { content: "" },
    "tests/test_cli.py": { content: [
      "import unittest",
      "",
      "from chaoscli.cli import greet, slugify",
      "",
      "",
      "class CliTest(unittest.TestCase):",
      "    def test_greet(self):",
      "        self.assertEqual(greet(\"chaos\"), \"hello, chaos\")",
      "",
      "    def test_slugify(self):",
      "        self.assertEqual(slugify(\"Hello Chaos World\"), \"hello-chaos-world\")",
      "        self.assertEqual(slugify(\"  A--b__C!! \"), \"a-b-c\")",
      "",
      "",
      "if __name__ == \"__main__\":",
      "    unittest.main()",
      "",
    ].join("\n") },
    "bench.sh": { mode: 0o755, content: [
      "#!/bin/sh",
      "# Deterministic long-running benchmark for restart chaos boundary B6.",
      "set -eu",
      `steps=${BENCH_STEPS}`,
      `seconds="\${BENCH_SECONDS:-${benchSeconds}}"`,
      "tag=\"${1:-untagged}\"",
      "mkdir -p .bench",
      "started=$(date +%s)",
      "total=0",
      "i=1",
      "while [ \"$i\" -le \"$steps\" ]; do",
      "  total=$((total + i * i))",
      "  if [ $((i % 24)) -eq 0 ]; then echo \"bench progress $i/$steps\"; echo \"$i\" > .bench/progress; fi",
      "  sleep \"$(awk -v s=\"$seconds\" -v n=\"$steps\" 'BEGIN { printf \"%.3f\", s / n }')\"",
      "  i=$((i + 1))",
      "done",
      "echo \"started=$started finished=$(date +%s) result=BENCH_RESULT=$total\" > \".bench/run-$tag.txt\"",
      "echo \"BENCH_RESULT=$total\"",
      "",
    ].join("\n") },
    ".gitignore": { content: ".bench/\n__pycache__/\n" },
  };
}
