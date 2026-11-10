import { describe, expect, it } from "vitest";
import type { ChaosApi } from "./api.js";
import { parseCommand } from "./config.js";
import { gradeR1 } from "./grader.js";
import { BUDGET_PAUSE_HOLD_MS, BUDGET_RESUME_HEADROOM_CENTS, REST_CONFIRM_MS, TaskObserver, approvalTitleMatches, runsStartedAfter } from "./observer.js";
import { planTasks, replayOnCurrentBuild, triggerFitsWorkload } from "./scheduler.js";
import type { ChaosLab } from "./seed.js";
import { Timeline } from "./timeline.js";
import type { FaultReceipt, OracleArtifacts, TaskPlan, TaskRecord, TaskSample, WavePlan } from "./types.js";
import { g1ApprovalTitle, g1ChildTitle, g1Decision, workloadDefinitions } from "./workloads.js";

process.env.RESTART_CHAOS_QUIET = "1";
const lab: ChaosLab = { companyId: "c1", environmentId: "e1", environmentKind: "local", projectId: "p1", fixtureRepositoryPath: "/tmp/none",
  agents: { codex: { id: "a1", name: "Chaos codex" }, claude: { id: "a2", name: "Chaos claude" }, opencode: { id: "a3", name: "Chaos opencode" } } };
const ready = { serverReady: true, faultInProgress: false };
const APPROVE = "0bcd1234";
const REJECT = "1bcd1234";

/** Fake board API: routes answered by prefix, every write recorded. */
function fakeApi(routes: Record<string, (route: string) => unknown>) {
  const writes: Array<{ method: string; route: string; body: unknown }> = [];
  const answer = (route: string) => {
    for (const [prefix, handler] of Object.entries(routes)) if (route.includes(prefix)) return handler(route);
    if (route.endsWith("/runs")) return [];
    return { id: "i1", status: "blocked", interruption: null };
  };
  const api = {
    async get(route: string) { return answer(route); },
    async post(route: string, body: unknown) { writes.push({ method: "POST", route, body }); return route.endsWith("/issues") ? { id: "i1", identifier: "CHA-1" } : {}; },
    async patch(route: string, body: unknown) { writes.push({ method: "PATCH", route, body }); return {}; },
  };
  return { api: api as unknown as ChaosApi, writes };
}

const g1Plan = (nonce: string): TaskPlan => ({ taskId: "t01", index: 0, workload: "G1", adapter: "codex", fault: "K1", fireAfterMs: 30_000,
  holdMs: 0, followUpAfterMs: null, nonce, trigger: "approval", triggerDelayMs: 0 });

describe("G1: approval-gated action across a restart", () => {
  it("splits the board's decisions by nonce", () => {
    expect(g1Decision(APPROVE)).toBe("approve");
    expect(g1Decision(REJECT)).toBe("reject");
  });

  it.each([[APPROVE, "approve"], [REJECT, "reject"]] as const)("decides (%s) only after the fault the pending approval armed, with the server ready",
    async (nonce, kind) => {
      const pending = { id: "ap1", status: "pending", payload: { title: g1ApprovalTitle(nonce) } };
      const { api, writes } = fakeApi({ "/approvals": () => [pending], "view=index": () => [] });
      const observer = new TaskObserver(g1Plan(nonce), api, lab, new Timeline(null), ready);
      await observer.launch();
      const start = observer.record.createdAt!;
      await observer.poll(start + 1_000);
      expect(observer.record.governance?.approvalSeenAt).toBe(start + 1_000);
      // The board does not act before the fault the pending approval armed.
      expect(observer.record.governance?.decision).toBeUndefined();
      expect(observer.faultDue(start + 1_001)).toMatchObject({ kind: "K1", trigger: "approval" });
      observer.noteFault("f01", start + 1_001);
      await observer.poll(start + 60_000);
      expect(observer.record.governance?.decision).toMatchObject({ kind, error: null, pendingWhenDecided: true, afterFault: true });
      expect(observer.record.governance?.childrenBeforeDecision).toBe(0);
      expect(writes.filter(write => write.route === `/api/approvals/ap1/${kind}`)).toHaveLength(1);
      expect(writes.some(write => write.method === "PATCH" && (write.body as { status?: string }).status === "cancelled")).toBe(kind === "reject");
    });

  it("holds a task blocked on its approval as waiting, not resting, while its fault is still to come", async () => {
    const pending = { id: "ap1", status: "pending", payload: { title: g1ApprovalTitle(APPROVE) } };
    const { api, writes } = fakeApi({ "/approvals": () => [pending] });
    const observer = new TaskObserver({ ...g1Plan(APPROVE), trigger: undefined, triggerDelayMs: undefined, fireAfterMs: 999_999 },
      api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 1_000);
    await observer.poll(start + 1_000 + REST_CONFIRM_MS + 1);
    await observer.poll(start + 1_000 + 2 * REST_CONFIRM_MS + 2);
    expect(observer.done).toBe(false);
    expect(observer.record.governance?.decision).toBeUndefined();
    expect(writes.some(write => write.route.startsWith("/api/approvals/"))).toBe(false);
  });

  const artifacts = (nonce: string, overrides: Partial<OracleArtifacts> = {}): OracleArtifacts => {
    const approve = g1Decision(nonce) === "approve";
    return { issueStatus: approve ? "done" : "cancelled", documents: {}, agentComments: [], files: {}, commands: {}, workspacePath: null,
      approvals: [{ id: "ap1", status: approve ? "approved" : "rejected", title: g1ApprovalTitle(nonce) }],
      children: approve ? [{ id: "c1", title: g1ChildTitle(nonce), status: "backlog", assigneeAgentId: null, documents: {} }] : [],
      governance: { approvalSeenAt: 1, childrenBeforeDecision: 0,
        decision: { kind: g1Decision(nonce), at: 2, httpStatus: 200, error: null, pendingWhenDecided: true, afterFault: true } },
      ...overrides };
  };

  it("passes an approved action that ran once and a rejected one that never ran", () => {
    expect(workloadDefinitions.G1.grade(APPROVE, artifacts(APPROVE)).verdict).toBe("pass");
    expect(workloadDefinitions.G1.grade(REJECT, artifacts(REJECT)).verdict).toBe("pass");
  });

  it("fails a duplicate request, an action that ran twice or after a rejection, and a decision that crossed no restart", () => {
    const failed = (nonce: string, overrides: Partial<OracleArtifacts>) =>
      workloadDefinitions.G1.grade(nonce, artifacts(nonce, overrides)).checks.filter(check => !check.ok).map(check => check.name);
    expect(failed(APPROVE, { approvals: [{ id: "ap1", status: "approved", title: g1ApprovalTitle(APPROVE) },
      { id: "ap2", status: "pending", title: g1ApprovalTitle(APPROVE) }] })).toContain("one_approval_requested");
    const child = { id: "c", title: g1ChildTitle(APPROVE), status: "backlog", assigneeAgentId: null, documents: {} };
    expect(failed(APPROVE, { children: [child, { ...child, id: "d" }] })).toEqual(["approved_action_ran_once"]);
    expect(failed(REJECT, { children: [{ ...child, title: g1ChildTitle(REJECT) }] })).toEqual(["rejected_action_never_ran"]);
    expect(failed(APPROVE, { governance: { approvalSeenAt: 1, childrenBeforeDecision: 0, decision: { kind: "approve", at: 2, httpStatus: 200,
      error: null, pendingWhenDecided: true, afterFault: false } } })).toEqual(["board_decided_after_restart"]);
    // The agent created the subtask while the approval was still pending: the approval did not gate it.
    expect(failed(APPROVE, { governance: { approvalSeenAt: 1, childrenBeforeDecision: 1, decision: { kind: "approve", at: 2, httpStatus: 200,
      error: null, pendingWhenDecided: true, afterFault: true } } })).toEqual(["action_gated_by_approval"]);
  });

  it("ends a task whose approval a restart lost at its deadline instead of waiting forever", async () => {
    let approvals: unknown[] = [{ id: "ap1", status: "pending", payload: { title: g1ApprovalTitle(APPROVE) } }];
    const { api } = fakeApi({ "/approvals": () => approvals, "view=index": () => [] });
    const observer = new TaskObserver({ ...g1Plan(APPROVE), trigger: undefined, triggerDelayMs: undefined, fireAfterMs: 999_999 },
      api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 1_000);
    approvals = [];
    const late = observer.record.deadlineAt! + 1;
    await observer.poll(late - REST_CONFIRM_MS - 1);
    await observer.poll(late);
    expect(observer.done).toBe(true);
    expect(observer.record.timedOut).toBe(true);
  });

  it("grades a rejected task that rests cancelled as continuing correctly (R1)", () => {
    const record = { plan: g1Plan(REJECT), launchError: null, retry: null, finalStatus: "cancelled", timedOut: false,
      createdAt: 0, restAt: 60_000, samples: [] } as unknown as TaskRecord;
    expect(gradeR1(record, 15 * 60_000, []).verdict).toBe("pass");
    expect(gradeR1({ ...record, finalStatus: "done" }, 15 * 60_000, []).verdict).toBe("fail");
    const unrested = gradeR1({ ...record, timedOut: true, restAt: null }, 15 * 60_000,
      [{ startedAt: 1_000, readyAt: null, healthyAt: null } as unknown as FaultReceipt]);
    expect(unrested).toEqual({ verdict: "fail", detail: "no_rest_within_budget (last status cancelled)" });
  });

  it("counts a redacted approval title as the task's own", () => {
    expect(approvalTitleMatches({ payload: { title: g1ApprovalTitle(APPROVE) } }, APPROVE)).toBe(true);
    expect(approvalTitleMatches({ payload: {} }, APPROVE)).toBe(true);
    expect(approvalTitleMatches({ payload: { title: "Approve something else" } }, APPROVE)).toBe(false);
  });
});

describe("H1: budget hard stop across a restart", () => {
  const h1Plan: TaskPlan = { taskId: "t01", index: 0, workload: "H1", adapter: "codex", fault: "K2", fireAfterMs: 30_000,
    holdMs: 0, followUpAfterMs: null, nonce: "abcd1234", trigger: "paused", triggerDelayMs: 0 };

  it("sets the budget to spend plus one cent, then resumes through the incident after the pause held across the fault", async () => {
    const pausedAt = new Date(Date.now() + 2_000).toISOString();
    let paused = false;
    const { api, writes } = fakeApi({
      "/budgets/overview": () => ({ policies: [{ scopeType: "company", observedAmount: 40.25 }],
        activeIncidents: paused ? [{ id: "inc1", scopeType: "company", amountObserved: 55.5 }] : [] }),
      "/api/companies/c1": () => paused ? { id: "c1", status: "paused", pauseReason: "budget", pausedAt } : { id: "c1", status: "active" },
    });
    const observer = new TaskObserver(h1Plan, api, lab, new Timeline(null), ready);
    await observer.launch();
    // Whole cents: observed spend can be fractional.
    expect(writes[0]).toMatchObject({ method: "PATCH", route: "/api/companies/c1/budgets", body: { budgetMonthlyCents: 42 } });
    const start = observer.record.createdAt!;
    paused = true;
    await observer.poll(start + 3_000);
    expect(observer.record.governance?.budgetPausedAt).toBeDefined();
    expect(observer.faultDue(start + 3_001)).toMatchObject({ kind: "K2", trigger: "paused" });
    observer.noteFault("f01", start + 3_001);
    // The pause must hold with the server ready before the board resumes.
    await observer.poll(start + 10_000);
    expect(observer.record.governance?.resume).toBeUndefined();
    await observer.poll(start + 10_000 + BUDGET_PAUSE_HOLD_MS + 1);
    expect(observer.record.governance?.resume).toMatchObject({ incidentId: "inc1", amount: 56 + BUDGET_RESUME_HEADROOM_CENTS,
      error: null, afterFault: true });
    expect(observer.record.governance?.runsStartedWhilePaused).toEqual([]);
    expect(writes.at(-1)).toMatchObject({ method: "POST", route: "/api/companies/c1/budget-incidents/inc1/resolve",
      body: { action: "raise_budget_and_resume", amount: 56 + BUDGET_RESUME_HEADROOM_CENTS } });
  });

  it("catches, at grading, a run that started after the last poll but before the resume returned", async () => {
    let paused = true;
    let runs: unknown[] = [];
    const { api } = fakeApi({
      "/budgets/overview": () => ({ policies: [{ scopeType: "company", observedAmount: 0 }],
        activeIncidents: [{ id: "inc1", scopeType: "company", amountObserved: 1 }] }),
      "/api/companies/c1": () => paused ? { id: "c1", status: "paused", pauseReason: "budget" } : { id: "c1", status: "active" },
      "/runs": () => runs,
      "/documents/": () => null,
      "/comments": () => [],
    });
    const observer = new TaskObserver(h1Plan, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 1_000);
    observer.faultDue(start + 1_001);
    observer.noteFault("f01", start + 1_001);
    await observer.poll(start + 5_000);
    await observer.poll(start + 5_000 + BUDGET_PAUSE_HOLD_MS + 1);
    expect(observer.record.governance?.runsStartedWhilePaused).toEqual([]);
    const resumeDone = observer.record.governance!.resume!.doneAt!;
    paused = false;
    // Dispatched while still paused, but only visible after the resume.
    runs = [{ runId: "sneaky", status: "succeeded", startedAt: new Date(resumeDone - 1).toISOString(), createdAt: null, finishedAt: null }];
    const artifacts = await observer.collectArtifacts();
    expect(artifacts.governance?.runsStartedWhilePaused).toEqual(["sneaky"]);
  });

  it("records a pause that clears before the board resumes it, and does not resume", async () => {
    let paused = true;
    const { api, writes } = fakeApi({
      "/budgets/overview": () => ({ policies: [{ scopeType: "company", observedAmount: 0 }], activeIncidents: [{ id: "inc1", scopeType: "company" }] }),
      "/api/companies/c1": () => paused ? { id: "c1", status: "paused", pauseReason: "budget" } : { id: "c1", status: "active" },
    });
    const observer = new TaskObserver(h1Plan, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 1_000);
    observer.faultDue(start + 1_001);
    observer.noteFault("f01", start + 1_001);
    paused = false;
    await observer.poll(start + 1_000 + BUDGET_PAUSE_HOLD_MS + 10_000);
    await observer.poll(start + 1_000 + 2 * BUDGET_PAUSE_HOLD_MS + 20_000);
    expect(observer.record.governance?.pauseLostAt).toBeDefined();
    expect(observer.record.governance?.resume).toBeUndefined();
    expect(writes.some(write => write.route.includes("/resolve"))).toBe(false);
  });

  it("finds runs that started while the company was paused", () => {
    const sample = (runs: Array<{ id: string; startedAt: string | null }>): TaskSample => ({ at: 0, reachable: true, serverReady: true,
      runs: runs.map(run => ({ ...run, status: "running", createdAt: null, finishedAt: null, errorCode: null, retryOfRunId: null,
        wakeCommentIds: [], livenessState: null })) });
    expect(runsStartedAfter([sample([{ id: "before", startedAt: new Date(1_000).toISOString() }]),
      sample([{ id: "after", startedAt: new Date(5_000).toISOString() }, { id: "queued", startedAt: null }])], 2_000)).toEqual(["after"]);
  });

  it("grades a missing pause, a dispatch while paused and a resume that crossed no restart as failures", () => {
    const base: OracleArtifacts = { issueStatus: "done", documents: { brief: "CHAOS-abcd1234\n- a\n- b\n- c" }, agentComments: [], files: {},
      commands: {}, workspacePath: null, governance: { budgetSetCents: 41, budgetPausedAt: 1, runsStartedWhilePaused: [],
        resume: { at: 2, amount: 3055, incidentId: "inc1", httpStatus: 200, error: null, afterFault: true }, companyActiveAtRest: true } };
    expect(workloadDefinitions.H1.grade("abcd1234", base).verdict).toBe("pass");
    const failed = (governance: OracleArtifacts["governance"]) => workloadDefinitions.H1.grade("abcd1234", { ...base, governance })
      .checks.filter(check => !check.ok).map(check => check.name);
    expect(failed({ ...base.governance, budgetPausedAt: null })).toContain("company_paused_for_budget");
    expect(failed({ ...base.governance, pauseLostAt: 5 })).toEqual(["pause_held_until_resume"]);
    expect(failed({ ...base.governance, runsStartedWhilePaused: ["r2"] })).toEqual(["nothing_dispatched_while_paused"]);
    expect(failed({ ...base.governance, resume: { ...base.governance!.resume!, afterFault: false } })).toEqual(["board_resumed_after_restart"]);
  });
});

describe("K14 replay", () => {
  it("replays a task that launched after the upgrade on the current build, its K14 restarts as K2", () => {
    const plan = { schema: "paperclip.restart-chaos.wave-plan/v1", waveId: "w", seed: 1, createdAt: "",
      options: { env: "local", adapters: ["codex"], workloads: ["A1"], faults: ["K14", "K1"], concurrency: 1, tasks: 1, seed: 1,
        budgetCents: 3_000, pollMs: 3_000, upgradeFrom: "/old" },
      tasks: [{ taskId: "t02", index: 0, workload: "A1", adapter: "codex", fault: "K14", fireAfterMs: 1, holdMs: 0, followUpAfterMs: null,
        nonce: "n", replayFaults: [{ kind: "K14", holdMs: 0, atMs: 5 }, { kind: "K1", holdMs: 0, atMs: 9 }] }] } as WavePlan;
    const replay = replayOnCurrentBuild(plan);
    expect(replay.options.upgradeFrom).toBeUndefined();
    expect(replay.options.faults).toEqual(["K2", "K1"]);
    expect(replay.tasks[0]).toMatchObject({ fault: "K2", replayFaults: [{ kind: "K2" }, { kind: "K1" }] });
  });
});

describe("governance wave options", () => {
  it("keeps G1 and H1 out of default waves and gates their triggers", () => {
    const command = parseCommand(["--seed", "3"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.workloads).not.toContain("G1");
    expect(command.options.workloads).not.toContain("H1");
    expect(triggerFitsWorkload("approval", "G1")).toBe(true);
    expect(triggerFitsWorkload("stop", "S1")).toBe(true);
    expect(triggerFitsWorkload("stop", "C1")).toBe(false);
    expect(triggerFitsWorkload("approval", "A1")).toBe(false);
    expect(triggerFitsWorkload("paused", "H1")).toBe(true);
    expect(() => planTasks({ seed: 1, tasks: 2, workloads: ["A1"], adapters: ["codex"], faults: ["K1"], triggers: ["approval"] }))
      .toThrow(/needs workload G1/);
    const tasks = planTasks({ seed: 1, tasks: 4, workloads: ["G1"], adapters: ["codex"], faults: ["K1", "K2"], triggers: ["approval"] });
    expect(tasks.every(task => task.trigger === "approval")).toBe(true);
  });

  it("runs H1 alone, one task at a time, with the hard stop on", () => {
    expect(parseCommand(["--workloads", "H1", "--concurrency", "1", "--triggers", "paused"]).mode).toBe("wave");
    expect(() => parseCommand(["--workloads", "H1,A1", "--concurrency", "1"])).toThrow(/its own wave/);
    expect(() => parseCommand(["--workloads", "H1"])).toThrow(/--concurrency 1/);
    expect(() => parseCommand(["--workloads", "H1", "--concurrency", "1", "--rc06-masked"])).toThrow(/hard stop/);
  });
});
