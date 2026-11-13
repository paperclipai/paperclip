import { describe, expect, it } from "vitest";
import {
  classifyIssueGraphLiveness,
  classifyIssueReviewPaths,
  createIssueReviewPathClassifier,
  type IssueGraphLivenessInput,
  type IssueLivenessAgentInput,
  type IssueLivenessExecutionPathInput,
  type IssueLivenessIssueInput,
  type IssueLivenessWaitingPathInput,
} from "../services/recovery/issue-graph-liveness.js";
import {
  referenceClassifyIssueGraphLiveness,
  referenceClassifyIssueReviewPaths,
} from "./helpers/issue-graph-liveness-reference.js";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const COMPANIES = ["company-a", "company-b"];

/** A deterministic pseudo-random source, so a failing case can be replayed by its seed. */
function randomSource(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (max: number) => Math.floor(next() * max);
  return {
    int,
    chance: (probability: number) => next() < probability,
    pick: <Value>(values: readonly Value[]) => values[int(values.length)]!,
  };
}

/**
 * A task graph of two companies that reaches the rules of the classification:
 * reviews with every kind of path and without one, blocked chains and cycles,
 * terminal blockers, relations and paths that name another company or a task
 * that does not exist, reporting chains with cycles, missing managers and
 * managers of another company, and ids that the input lists twice.
 */
function randomInput(seed: number): IssueGraphLivenessInput {
  const random = randomSource(seed);
  const agentCount = 2 + random.int(10), issueCount = 4 + random.int(22);
  const agentId = (index: number) => `agent-${index}`;
  const issueId = (index: number) => `issue-${index}`;
  const anyAgentId = () => random.chance(0.05) ? "agent-missing" : agentId(random.int(agentCount));
  const anyIssueId = () => random.chance(0.05) ? "issue-missing" : issueId(random.int(issueCount));
  const company = () => random.chance(0.8) ? COMPANIES[0]! : COMPANIES[1]!;

  const agents: IssueLivenessAgentInput[] = Array.from({ length: agentCount }, (_unused, index) => ({
    id: agentId(index), companyId: company(), name: `Agent ${index}`, role: "engineer", title: null,
    status: random.pick(["idle", "idle", "running", "active", "error", "paused", "terminated", "pending_approval", "unknown"]),
    reportsTo: random.chance(0.3) ? null : anyAgentId(),
  }));
  if (random.chance(0.2)) agents.push({ ...random.pick(agents), status: "paused", reportsTo: null });

  const participant = () => random.pick<unknown>([
    null, undefined, {}, "agent", { type: "agent", agentId: anyAgentId() }, { type: "agent", agentId: "" },
    { type: "user", userId: "user-1" }, { type: "user", userId: "" }, { type: "user" },
  ]);
  const issues: IssueLivenessIssueInput[] = Array.from({ length: issueCount }, (_unused, index) => {
    const conversation = random.chance(0.1);
    return {
      id: issueId(index), companyId: company(), identifier: random.chance(0.9) ? `T-${index}` : null, title: `Task ${index}`,
      status: random.pick(["in_review", "in_review", "in_review", "blocked", "blocked", "todo", "backlog", "in_progress", "done", "cancelled"]),
      assigneeAgentId: random.chance(0.75) ? anyAgentId() : null,
      assigneeUserId: random.chance(0.12) ? "user-1" : null,
      createdByAgentId: random.chance(0.5) ? anyAgentId() : null,
      createdByUserId: null,
      conversationAgentId: conversation ? anyAgentId() : null,
      conversationUserId: conversation ? "user-2" : null,
      conversationState: conversation ? random.pick(["waiting", "active"]) : null,
      executionState: random.pick<Record<string, unknown> | null>([
        null, null, null, { status: "pending", currentParticipant: participant() },
        { status: "completed", currentParticipant: participant() }, { monitor: { maxAttempts: 2, attemptCount: random.int(4) } },
      ]),
      executionPolicy: random.pick<Record<string, unknown> | null>([
        null, null, { monitor: { maxAttempts: 1 + random.int(3) } },
        { monitor: { timeoutAt: new Date(NOW.getTime() + (random.int(3) - 1) * 60_000).toISOString() } },
      ]),
      monitorNextCheckAt: random.pick([null, null, new Date(NOW.getTime() + 60_000), new Date(NOW.getTime() - 60_000), "not a date"]),
      monitorAttemptCount: random.pick([null, 0, 1, 5]),
    };
  });
  if (random.chance(0.15)) issues.push({ ...random.pick(issues), status: "in_review" });

  const relations = Array.from({ length: random.int(issueCount * 2) }, () => ({
    companyId: company(), blockerIssueId: anyIssueId(), blockedIssueId: anyIssueId(),
  }));
  const executionPaths = (): IssueLivenessExecutionPathInput[] => Array.from({ length: random.int(8) }, (_unused, index) => ({
    id: random.chance(0.9) ? `execution-${index}` : null, companyId: company(),
    issueId: random.chance(0.1) ? null : anyIssueId(), agentId: random.chance(0.8) ? anyAgentId() : null,
    status: "queued", createdAt: random.chance(0.7) ? new Date(NOW.getTime() - index * 1_000) : null,
  }));
  const waitingPaths = (): IssueLivenessWaitingPathInput[] => Array.from({ length: random.int(8) }, (_unused, index) => ({
    id: random.chance(0.9) ? `waiting-${index}` : null, companyId: company(), issueId: anyIssueId(),
    status: "pending", createdAt: random.chance(0.7) ? new Date(NOW.getTime() - index * 1_000).toISOString() : null,
  }));
  const optional = <Value>(build: () => Value) => random.chance(0.85) ? build() : undefined;
  return {
    issues, relations, agents, now: NOW,
    activeRuns: optional(executionPaths), queuedWakeRequests: optional(executionPaths),
    pendingInteractions: optional(waitingPaths), pendingApprovals: optional(waitingPaths),
    externalResponseWaits: optional(waitingPaths), openRecoveryIssues: optional(waitingPaths),
  };
}

function agent(index: number, reportsTo: string | null, status = "idle"): IssueLivenessAgentInput {
  return { id: `agent-${index}`, companyId: COMPANIES[0]!, name: `Agent ${index}`, role: "engineer", title: null, status, reportsTo };
}

function review(index: number, overrides: Partial<IssueLivenessIssueInput> = {}): IssueLivenessIssueInput {
  return {
    id: `review-${index}`, companyId: COMPANIES[0]!, identifier: `R-${index}`, title: `Review ${index}`, status: "in_review",
    assigneeAgentId: "agent-1", assigneeUserId: null, createdByAgentId: null, createdByUserId: null, executionState: null,
    ...overrides,
  };
}

/** Counts how often a classification reads the `status` of an agent or the `issueId` of a path. */
function countedInput(reviews: number) {
  const reads = { agentStatus: 0, pathIssueId: 0 };
  const counted = <Row extends object>(row: Row, key: keyof Row & string, counter: keyof typeof reads) => {
    const value = row[key];
    return Object.defineProperty({ ...row }, key, { enumerable: true, get: () => { reads[counter] += 1; return value; } }) as Row;
  };
  // Forty agents under one manager; every third is paused.
  const agents = Array.from({ length: 40 }, (_unused, index) =>
    counted(agent(index, index === 0 ? null : "agent-0", index % 3 === 2 ? "paused" : "idle"), "status", "agentStatus"));
  const waitingPaths = (prefix: string) => Array.from({ length: 60 }, (_unused, index) => counted({
    id: `${prefix}-${index}`, companyId: COMPANIES[0]!, issueId: `elsewhere-${index}`, status: "pending", createdAt: NOW,
  }, "issueId", "pathIssueId"));
  const executionPaths = (prefix: string) => Array.from({ length: 60 }, (_unused, index) => counted({
    id: `${prefix}-${index}`, companyId: COMPANIES[0]!, issueId: `elsewhere-${index}` as string | null, agentId: "agent-1",
    status: "queued", createdAt: NOW,
  }, "issueId", "pathIssueId"));
  const input: IssueGraphLivenessInput = {
    // Every review is stalled: an invokable assignee and no path.
    issues: Array.from({ length: reviews }, (_unused, index) => review(index)),
    relations: [], agents, now: NOW,
    activeRuns: executionPaths("run"), queuedWakeRequests: executionPaths("wake"),
    pendingInteractions: waitingPaths("interaction"), pendingApprovals: waitingPaths("approval"),
    externalResponseWaits: waitingPaths("external"), openRecoveryIssues: waitingPaths("recovery"),
  };
  return { input, reads };
}

describe("issue graph liveness: one index for every task of a classification", () => {
  it("returns the findings and review paths of the pre-fix classification for random task graphs", () => {
    const findingStates = new Map<string, number>(), pathKinds = new Map<string, number>();
    const count = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
    for (let seed = 1; seed <= 400; seed += 1) {
      const input = randomInput(seed);
      const expected = referenceClassifyIssueGraphLiveness(input);
      expect(classifyIssueGraphLiveness(input), `findings of seed ${seed}`).toEqual(expected);
      for (const finding of expected) count(findingStates, finding.state);

      const reviewPathsOf = createIssueReviewPathClassifier(input);
      for (const issue of input.issues) {
        const expectedPaths = referenceClassifyIssueReviewPaths(input, issue);
        expect(classifyIssueReviewPaths(input, issue), `review paths of ${issue.id}, seed ${seed}`).toEqual(expectedPaths);
        expect(reviewPathsOf(issue), `indexed review paths of ${issue.id}, seed ${seed}`).toEqual(expectedPaths);
        for (const path of expectedPaths) count(pathKinds, path.kind);
      }
    }
    // The random graphs reach every finding and every kind of review path,
    // each of them many times.
    expect([...findingStates.keys()].sort()).toEqual([
      "blocked_by_assigned_backlog_issue", "blocked_by_cancelled_issue", "blocked_by_unassigned_issue",
      "blocked_by_uninvokable_assignee", "in_review_without_action_path", "invalid_review_participant",
    ]);
    expect([...pathKinds.keys()].sort()).toEqual([
      "active_run", "approval", "execution_participant", "external_response", "human_reviewer", "interaction",
      "monitor", "queued_wake", "recovery",
    ]);
    expect(Math.min(...findingStates.values(), ...pathKinds.values())).toBeGreaterThanOrEqual(20);
  });

  it("returns the pre-fix findings for blocked chains, cycles and terminal blockers", () => {
    const agents = [agent(0, null), agent(1, "agent-0"), agent(2, "agent-0", "paused"), agent(3, "agent-2", "terminated")];
    const task = (id: string, status: string, overrides: Partial<IssueLivenessIssueInput> = {}): IssueLivenessIssueInput => ({
      id, companyId: COMPANIES[0]!, identifier: id.toUpperCase(), title: id, status, assigneeAgentId: "agent-1",
      assigneeUserId: null, createdByAgentId: "agent-1", createdByUserId: null, executionState: null, ...overrides,
    });
    const blocks = (blockerIssueId: string, blockedIssueId: string, companyId = COMPANIES[0]!) => ({ companyId, blockerIssueId, blockedIssueId });
    const input: IssueGraphLivenessInput = {
      now: NOW,
      agents,
      issues: [
        task("chain-1", "blocked"), task("chain-2", "blocked"), task("chain-3", "blocked"),
        task("chain-leaf", "todo", { assigneeAgentId: null }),
        task("cycle-1", "blocked"), task("cycle-2", "blocked"),
        task("behind-cancelled", "blocked"), task("cancelled", "cancelled"),
        task("behind-done", "blocked"), task("done", "done"),
        task("behind-backlog", "blocked"), task("backlog", "backlog"),
        task("behind-paused", "blocked"), task("paused-owner", "todo", { assigneeAgentId: "agent-2" }),
        task("behind-terminated-chain", "blocked"), task("terminated-chain-owner", "todo", { assigneeAgentId: "agent-3" }),
        task("behind-review", "blocked"), task("stalled-review", "in_review"),
        task("behind-covered-review", "blocked"), task("covered-review", "in_review"),
        task("behind-running", "blocked"), task("running", "in_progress"),
        task("behind-other-company", "blocked"), { ...task("other-company", "todo", { assigneeAgentId: null }), companyId: COMPANIES[1]! },
        task("waiting-external", "in_review"),
        task("invalid-participant", "in_review", { executionState: { status: "pending", currentParticipant: { type: "agent", agentId: "agent-2" } } }),
      ],
      relations: [
        blocks("chain-2", "chain-1"), blocks("chain-3", "chain-2"), blocks("chain-leaf", "chain-3"),
        blocks("cycle-2", "cycle-1"), blocks("cycle-1", "cycle-2"),
        blocks("cancelled", "behind-cancelled"), blocks("done", "behind-done"), blocks("backlog", "behind-backlog"),
        blocks("paused-owner", "behind-paused"), blocks("terminated-chain-owner", "behind-terminated-chain"),
        blocks("stalled-review", "behind-review"), blocks("covered-review", "behind-covered-review"),
        blocks("running", "behind-running"), blocks("other-company", "behind-other-company"),
        blocks("chain-leaf", "behind-other-company", COMPANIES[1]!),
      ],
      activeRuns: [{ id: "run-1", companyId: COMPANIES[0]!, issueId: "running", agentId: "agent-1", status: "running", createdAt: NOW }],
      queuedWakeRequests: [{ id: "wake-other", companyId: COMPANIES[1]!, issueId: "stalled-review", agentId: "agent-1", status: "queued" }],
      pendingInteractions: [{ id: "interaction-1", companyId: COMPANIES[0]!, issueId: "covered-review", status: "pending", createdAt: NOW }],
      externalResponseWaits: [{ id: "wait-1", companyId: COMPANIES[0]!, issueId: "waiting-external", status: "waiting", createdAt: NOW }],
    };

    const findings = classifyIssueGraphLiveness(input);
    expect(findings).toEqual(referenceClassifyIssueGraphLiveness(input));
    expect(Object.fromEntries(findings.map((finding) => [finding.issueId, finding.state]))).toEqual({
      "chain-1": "blocked_by_unassigned_issue",
      "behind-cancelled": "blocked_by_cancelled_issue",
      "behind-backlog": "blocked_by_assigned_backlog_issue",
      "behind-paused": "blocked_by_uninvokable_assignee",
      "behind-terminated-chain": "blocked_by_uninvokable_assignee",
      "behind-review": "in_review_without_action_path",
      "invalid-participant": "invalid_review_participant",
    });
    // A wake of another company does not cover the review; the external wait does.
    const reviewPathsOf = createIssueReviewPathClassifier(input);
    const kinds = (id: string) => reviewPathsOf(input.issues.find((issue) => issue.id === id)!).map((path) => path.kind);
    expect(kinds("stalled-review")).toEqual([]);
    expect(kinds("covered-review")).toEqual(["interaction"]);
    expect(kinds("waiting-external")).toEqual(["external_response"]);
  });

  it("reads each agent and each path a number of times that does not grow with the reviews", () => {
    const few = countedInput(20), many = countedInput(400);
    const fewFindings = classifyIssueGraphLiveness(few.input), manyFindings = classifyIssueGraphLiveness(many.input);
    expect(fewFindings).toHaveLength(20);
    expect(manyFindings).toHaveLength(400);
    expect(manyFindings[0]!.recommendedOwnerCandidateAgentIds).toHaveLength(27);
    // Twenty times the reviews, the same reads: each of the 360 paths once
    // and each of the 40 agents a few times.
    expect(many.reads).toEqual(few.reads);
    expect(many.reads.pathIssueId).toBe(360);
    expect(many.reads.agentStatus).toBeLessThanOrEqual(40 * 10);

    // The pre-fix classification is what this test catches: it read every
    // agent and every path again for each review.
    const referenceFew = countedInput(20), referenceMany = countedInput(400);
    expect(referenceClassifyIssueGraphLiveness(referenceMany.input)).toEqual(manyFindings);
    referenceClassifyIssueGraphLiveness(referenceFew.input);
    expect(referenceMany.reads.agentStatus).toBeGreaterThan(referenceFew.reads.agentStatus * 15);
    expect(referenceMany.reads.pathIssueId).toBeGreaterThan(referenceFew.reads.pathIssueId * 15);
  });

  it("classifies the review paths of a page from one index", () => {
    const few = countedInput(20), many = countedInput(400);
    for (const { input } of [few, many]) {
      const reviewPathsOf = createIssueReviewPathClassifier(input);
      for (const issue of input.issues) expect(reviewPathsOf(issue)).toEqual([]);
    }
    expect(many.reads).toEqual(few.reads);
  });
});
