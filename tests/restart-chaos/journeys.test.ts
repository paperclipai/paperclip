import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { actionRequestRows, JourneyDriver, questionAnswer, reviewClockNames, shiftReviewClockWith, type JourneyHost } from "./journey-driver.js";
import { matrixCells, matrixMayLaunch, planMatrixWave } from "./journey-matrix.js";
import { pkceChallenge, startOAuthApp } from "./journey-oauth-app.js";
import {
  answerMarker, gradeBlockedQuestionJourney, gradeToolReviewJourney, journeyChoice, q3ToolArgument, Q3_REVIEW_AGE_MS,
  type JourneyArtifacts, type JourneyRecord,
} from "./journeys.js";
import { planTasks, taskFaultSchedule } from "./scheduler.js";
import { Timeline } from "./timeline.js";
import type { OracleArtifacts, ScheduledFault, TaskPlan, TaskRecord, TaskSample } from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const nonce = "a1b2c3d4";

function artifacts(journey: Partial<JourneyArtifacts> & { record: JourneyRecord }, overrides: Partial<OracleArtifacts> = {}): OracleArtifacts {
  return { issueStatus: "done", documents: { brief: `CHAOS-${nonce}\n${answerMarker(nonce)}\n- one\n- two\n- three\n` }, agentComments: [],
    files: {}, commands: {}, workspacePath: null,
    journey: { questions: [{ id: "q", status: "answered", createdAt: null }], agentComments: [], runErrorCodes: [], interruption: null, ...journey },
    ...overrides };
}

const answered = (extra: Partial<NonNullable<JourneyRecord["answer"]>> = {}) => ({ at: 2_000, doneAt: 2_100, httpStatus: 200, error: null,
  status: "answered", pendingWhenAnswered: true, faultsBefore: 1, ...extra });

const failed = (result: ReturnType<typeof gradeBlockedQuestionJourney>) => result.checks.filter(check => !check.ok).map(check => check.name);

const q2Record = (extra: Partial<JourneyRecord> = {}): JourneyRecord => ({ requestSeenAt: 1_000, blocker: { issueId: "b", at: 1_500, error: null },
  answer: answered(), answerTurn: { at: 60_000, issueStatus: "blocked", blockerKept: true }, blockerResolved: { at: 70_000, error: null }, ...extra });

describe("journey oracles", () => {
  it("passes Q2 when the answer turn ran while the task stayed blocked by its prerequisite", () => {
    expect(failed(gradeBlockedQuestionJourney(nonce, artifacts({ record: q2Record({ faultTrigger: "asked" }) })))).toEqual([]);
  });

  it("fails Q2 when a restart made the agent ask twice, the board answered before the restart, or the answer missed the brief", () => {
    const result = gradeBlockedQuestionJourney(nonce, artifacts({ record: q2Record({ faultTrigger: "asked", answer: answered({ faultsBefore: 0 }) }),
      questions: [{ id: "a", status: "answered", createdAt: null }, { id: "b", status: "pending", createdAt: null }] },
    { documents: { brief: `CHAOS-${nonce}\n- one\n- two\n- three` } }));
    expect(failed(result)).toEqual(["one_question_saved", "response_after_restart", "brief_contains_answer_marker"]);
  });

  it("fails Q2 on a stale Retry notice left after the answered work finished", () => {
    const result = gradeBlockedQuestionJourney(nonce, artifacts({ record: q2Record(), interruption: { state: "failed", canRetry: true } }));
    expect(failed(result)).toEqual(["no_stale_retry_notice"]);
  });

  it("fails Q2 the way #20363's parent does: the answer never reaches the blocked task", () => {
    const record = q2Record({ answerTurn: { missedAt: 400_000 }, blockerResolved: { at: 400_100, error: null } });
    expect(failed(gradeBlockedQuestionJourney(nonce, artifacts({ record, runErrorCodes: ["issue_dependencies_blocked"] }))))
      .toEqual(["answer_reached_agent_while_blocked", "prerequisite_kept_through_answer", "answer_turn_before_prerequisite_finished",
        "no_dependency_blocked_failure"]);
  });

  const q3Record = (extra: Partial<JourneyRecord> = {}): JourneyRecord => ({
    requestSeenAt: 1_000, app: { connectionId: "c", agentId: "a", receipt: "receipt-x", setupError: null },
    timeShift: { at: 1_100, ms: Q3_REVIEW_AGE_MS, requests: 1, grants: 1, error: null },
    refresh: { at: 1_200, httpStatus: 200, error: null }, answer: answered({ status: "executed" }), ...extra });

  it("passes Q3 when an aged review approved after a token refresh runs the reviewed action once", () => {
    const result = gradeToolReviewJourney(nonce, artifacts({ record: q3Record(), actionRequests: [{ id: "r", status: "executed" }],
      provider: { toolCalls: [{ at: 2_050, title: q3ToolArgument(nonce) }], refreshes: [1_250] },
      agentComments: [{ createdAt: 3_000, body: "Q3 result: Created page. receipt-x" }] }, { documents: {} }));
    expect(failed(result)).toEqual([]);
  });

  it("fails Q3 the way #20340's parent does: the refresh invalidates the approval", () => {
    const record = q3Record({ answer: answered({ httpStatus: 409, error: "approved_tool_target_changed", status: null }) });
    const result = gradeToolReviewJourney(nonce, artifacts({ record, actionRequests: [{ id: "r", status: "pending" }],
      provider: { toolCalls: [], refreshes: [1_250] } }, { issueStatus: "in_review", documents: {} }));
    expect(failed(result)).toEqual(["issue_done", "board_approved", "reviewed_action_ran_once", "action_executed", "agent_reported_result"]);
  });

  it("does not credit a refresh that happened only during the approval itself", () => {
    const result = gradeToolReviewJourney(nonce, artifacts({ record: q3Record(), actionRequests: [{ id: "r", status: "executed" }],
      provider: { toolCalls: [{ at: 2_050, title: q3ToolArgument(nonce) }], refreshes: [2_010] },
      agentComments: [{ createdAt: 3_000, body: "receipt-x" }] }, { documents: {} }));
    expect(failed(result)).toEqual(["token_refreshed_before_decision"]);
  });
});

describe("journey planning", () => {
  it("fires journey faults at their own boundaries", () => {
    const tasks = planTasks({ seed: 5, tasks: 4, workloads: ["Q1", "Q2"], adapters: ["codex"], faults: ["K1"], triggers: ["asked", "answered"] });
    expect(new Set(tasks.map(task => task.trigger))).toEqual(new Set(["asked", "answered"]));
    for (const task of tasks) expect(taskFaultSchedule(task)).toEqual([expect.objectContaining({ kind: "K1", trigger: task.trigger })]);
    expect(() => planTasks({ seed: 5, tasks: 1, workloads: ["A1"], adapters: ["codex"], faults: ["K1"], triggers: ["asked"] }))
      .toThrow(/Q1, Q2 or Q3/);
  });

  it("crosses every journey with a baseline and every fault at each of its triggers", () => {
    const cells = matrixCells({ workloads: ["Q1", "Q2", "Q3"], adapters: ["codex"], faults: ["K1", "K2", "K4"] });
    expect(cells).toHaveLength(3 * (1 + 3 * 2));
    expect(cells.filter(cell => cell.workload === "Q3").map(cell => `${cell.fault}^${cell.trigger}`)).toEqual([
      "K0^time", "K1^asked", "K1^answered", "K2^asked", "K2^answered", "K4^asked", "K4^answered"]);
    // Baselines come first, so they finish before any fault cell shares the server.
    expect(cells.slice(0, 3).map(cell => cell.fault)).toEqual(["K0", "K0", "K0"]);
    expect(cells.slice(3).every(cell => cell.fault !== "K0")).toBe(true);
    const command = parseCommand(["--workloads", "Q1,Q2,Q3,G1", "--faults", "K1,K2,K4", "--adapters", "codex", "--matrix", "--seed", "9"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options).toMatchObject({ matrix: true, tasks: 21 + 3 });
    const plan = planMatrixWave("w-20261109T000000-s9", command.options);
    expect(plan.tasks).toHaveLength(24);
    const baseline = plan.tasks.find(task => task.fault === "K0")!;
    expect(taskFaultSchedule(baseline)).toEqual([]);
    // G1 grades a decision made after a restart, so it has no no-fault baseline.
    expect(plan.tasks.filter(task => task.workload === "G1").map(task => task.trigger ?? "time")).toEqual(["approval", "approval", "approval"]);
    expect(planMatrixWave("w-20261109T000000-s9", command.options).tasks).toEqual(plan.tasks);
  });

  it("never runs a baseline beside a fault cell", () => {
    expect(matrixMayLaunch({ fault: "K0" }, [])).toBe(true);
    expect(matrixMayLaunch({ fault: "K0" }, [{ fault: "K0" }])).toBe(true);
    expect(matrixMayLaunch({ fault: "K1" }, [{ fault: "K0" }])).toBe(false);
    expect(matrixMayLaunch({ fault: "K0" }, [{ fault: "K4" }])).toBe(false);
    expect(matrixMayLaunch({ fault: "K2" }, [{ fault: "K1" }])).toBe(true);
  });

  it("honours --fault-after-seconds for time-fired matrix cells", () => {
    const command = parseCommand(["--workloads", "A1,Q1", "--faults", "K1", "--adapters", "codex", "--matrix", "--fault-after-seconds", "60", "--seed", "4"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    const tasks = planMatrixWave("w-20261109T000000-s4", command.options).tasks;
    expect(tasks.find(task => task.workload === "A1" && task.fault === "K1")!.fireAfterMs).toBe(60_000);
    expect(tasks.filter(task => task.fault === "K0").every(task => task.fireAfterMs === 0)).toBe(true);
  });

  it("validates --matrix and --server-from", () => {
    expect(() => parseCommand(["--workloads", "Q1", "--matrix", "--tasks", "3"])).toThrow(/do not pass --tasks/);
    expect(() => parseCommand(["--workloads", "Q1", "--matrix", "--triggers", "asked"])).toThrow(/own triggers/);
    const command = parseCommand(["--workloads", "Q2", "--server-from", "../old", "--faults", "K1"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.serverFrom).toMatch(/\/old$/);
    expect(() => parseCommand(["--workloads", "Q2", "--server-from", "../old", "--faults", "K14", "--upgrade-from", "../older"])).toThrow(/upgrade-from/);
    // Provider message faults cross the matrix too, each armed once per workload.
    const provider = parseCommand(["--workloads", "Q1", "--faults", "PV1,PV2", "--adapters", "codex", "--matrix", "--seed", "3"]);
    if (provider.mode !== "wave") throw new Error("expected a wave");
    const tasks = planMatrixWave("w-20261109T000000-s3", provider.options).tasks;
    expect(tasks.map(task => task.fault)).toEqual(["K0", "PV1", "PV2"]);
    expect(tasks.filter(task => task.providerFault).map(task => task.providerFault!.kind)).toEqual(["PV1", "PV2"]);
  });

  it("keeps journeys out of the default workloads and registers their definitions", () => {
    const command = parseCommand(["--adapters", "codex"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.workloads).not.toContain("Q1");
    expect(workloadDefinitions.Q2.description(nonce)).toContain(`ANSWER-${nonce}-<code word>`);
    expect(journeyChoice(nonce)).toMatch(/^(amber|cobalt)$/);
  });
});

describe("harness OAuth app", () => {
  it("runs a PKCE authorization, rotates tokens on refresh and records tool calls", async () => {
    const app = await startOAuthApp();
    try {
      const unauthenticated = await fetch(app.mcpUrl, { method: "POST", body: "{}" });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("www-authenticate")).toContain("oauth-protected-resource");
      await fetch(`${app.origin}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:1/cb"] }) });
      const verifier = "chaos-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
      const authorizeUrl = (state: string) => `${app.origin}/authorize?redirect_uri=${encodeURIComponent("http://127.0.0.1:1/cb")}`
        + `&state=${state}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256`;
      expect((await fetch(`${app.origin}/authorize?redirect_uri=${encodeURIComponent("http://127.0.0.1:1/cb")}&state=x`, { redirect: "manual" })).status).toBe(400);
      const codeFor = async (state: string) => {
        const back = new URL((await fetch(authorizeUrl(state), { redirect: "manual" })).headers.get("location")!);
        expect(back.searchParams.get("state")).toBe(state);
        return back.searchParams.get("code")!;
      };
      const token = async (form: Record<string, string>) => (await fetch(`${app.origin}/token`, { method: "POST", body: new URLSearchParams(form) })).json() as Promise<Record<string, string>>;
      // A missing or wrong verifier is refused, and the refused code cannot be reused.
      expect((await token({ grant_type: "authorization_code", code: await codeFor("s0") })).error).toBe("invalid_grant");
      const wrong = await codeFor("s2");
      expect((await token({ grant_type: "authorization_code", code: wrong, code_verifier: `${verifier}x` })).error).toBe("invalid_grant");
      expect((await token({ grant_type: "authorization_code", code: wrong, code_verifier: verifier })).error).toBe("invalid_grant");
      const first = await token({ grant_type: "authorization_code", code: await codeFor("s1"), code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:1/cb" });
      const second = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token! });
      expect(second.access_token).not.toBe(first.access_token);
      expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token! })).error).toBe("invalid_grant");
      const call = await fetch(app.mcpUrl, { method: "POST", headers: { authorization: `Bearer ${second.access_token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_page", arguments: { title: "T" } } }) });
      expect(JSON.stringify(await call.json())).toContain(app.receipt);
      expect(app.record).toMatchObject({ registrations: 1, codeExchanges: 1, rejectedCodes: 3, rejectedRefreshes: 1, toolCalls: [{ title: "T" }] });
      expect(app.record.refreshes).toHaveLength(1);
    } finally { await app.close(); }
  });
});

describe("journey driver", () => {
  function harness(workload: "Q2", trigger: TaskPlan["trigger"] = "answered") {
    const plan: TaskPlan = { taskId: "t01", index: 0, workload, adapter: "codex", fault: "K1", fireAfterMs: 0, holdMs: 0,
      trigger, triggerDelayMs: 0, followUpAfterMs: null, nonce };
    const record = { plan, issueId: "issue-1", faultIds: [] } as unknown as TaskRecord;
    const calls: string[] = [];
    let interaction = { id: "i1", kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [{ id: "codeword",
      prompt: "Which code word?", options: [{ id: "opt-a", label: "Amber" }, { id: "opt-c", label: "Cobalt" }] }] } };
    const api = {
      baseUrl: "http://x",
      async get(route: string) {
        if (route.endsWith("/interactions")) return [interaction];
        if (route.endsWith("/comments")) return [{ authorAgentId: "agent", body: `ok ${answerMarker(nonce)}`, createdAt: new Date(Date.now() + 60_000).toISOString() }];
        if (route === "/api/issues/issue-1") return { status: "blocked", blockedBy: [{ id: "blocker-1" }] };
        throw new Error(`unexpected GET ${route}`);
      },
      async post(route: string, body: unknown) {
        calls.push(`POST ${route} ${JSON.stringify(body)}`);
        if (route.endsWith("/respond")) { interaction = { ...interaction, status: "answered" }; return interaction; }
        if (route.endsWith("/issues")) return { id: "blocker-1" };
        throw new Error(`unexpected POST ${route}`);
      },
      async patch(route: string, body: unknown) { calls.push(`PATCH ${route} ${JSON.stringify(body)}`); return {}; },
    };
    const host: JourneyHost = { plan, api: api as unknown as JourneyHost["api"], lab: { companyId: "c" } as JourneyHost["lab"],
      timeline: new Timeline(null), record, databaseUrl: () => null };
    return { driver: new JourneyDriver(workload, host), calls, record };
  }
  it("reads Apps → Review rows in the route's nested shape", () => {
    expect(actionRequestRows({ actionRequests: [{ request: { id: "r1", issueId: "i", status: "pending" }, connection: {} }] }))
      .toEqual([{ id: "r1", issueId: "i", status: "pending" }]);
    expect(actionRequestRows(null)).toEqual([]);
  });

  it("answers with the agent's own question and option ids, matched by the chosen code word", () => {
    const card = { payload: { questionSet: { questions: [{ id: "q-7", options: [{ id: "x", label: " Cobalt " }, { id: "amber", label: "Warm" }] }] } } };
    expect(questionAnswer(card, "cobalt")).toEqual({ questionId: "q-7", optionIds: ["x"] });
    expect(questionAnswer(card, "amber")).toEqual({ questionId: "q-7", optionIds: ["amber"] });
    expect(questionAnswer({ payload: {} }, "amber")).toBeNull();
  });

  const sample = (runs: TaskSample["runs"] = []): TaskSample => ({ at: 0, reachable: true, serverReady: true, runs });
  const answeredFault: ScheduledFault = { kind: "K1", holdMs: 0, atMs: 0, trigger: "answered", delayMs: 0 };

  it("answers only once the planned faults before the answer fired, then arms the answered trigger", async () => {
    const { driver, calls, record } = harness("Q2", "asked");
    const askedFault: ScheduledFault = { kind: "K1", holdMs: 0, atMs: 0, trigger: "asked", delayMs: 0 };
    expect(await driver.step({ sample: sample(), now: 1_000, quiet: true, pendingFaults: [askedFault] })).toBe(true);
    expect(driver.armedAt("asked")).toBe(1_000);
    expect(driver.awaitingBoard()).toBe(true);
    expect(await driver.step({ sample: sample(), now: 2_000, quiet: true, pendingFaults: [askedFault] })).toBe(false);
    expect(calls.some(call => call.includes("/respond"))).toBe(false);
    record.faultIds.push("f1");
    expect(await driver.step({ sample: sample(), now: 5_000, quiet: true, pendingFaults: [] })).toBe(true);
    const optionId = journeyChoice(nonce) === "amber" ? "opt-a" : "opt-c";
    expect(calls.at(-1)).toBe(`POST /api/issues/issue-1/interactions/i1/respond {"answers":[{"questionId":"codeword","optionIds":["${optionId}"]}]}`);
    expect(driver.armedAt("answered")).toBeGreaterThanOrEqual(5_000);
    expect(record.journey!.answer).toMatchObject({ pendingWhenAnswered: true, faultsBefore: 1, error: null });
  });

  it("Q2: adds the prerequisite, answers, waits for the answer turn, then finishes the prerequisite", async () => {
    const { driver, calls, record } = harness("Q2");
    const running = sample([{ id: "r1", status: "running", createdAt: null, startedAt: null, finishedAt: null, errorCode: null,
      retryOfRunId: null, wakeCommentIds: [], livenessState: null }]);
    expect(await driver.step({ sample: running, now: 1_000, quiet: true, pendingFaults: [answeredFault] })).toBe(false);
    expect(await driver.step({ sample: sample(), now: 2_000, quiet: true, pendingFaults: [answeredFault] })).toBe(true);
    expect(calls.at(-1)).toBe('PATCH /api/issues/issue-1 {"status":"blocked","blockedByIssueIds":["blocker-1"]}');
    expect(await driver.step({ sample: sample(), now: 3_000, quiet: true, pendingFaults: [answeredFault] })).toBe(true);
    expect(calls.at(-1)).toContain("/respond");
    // The answered fault is still pending: the turn is observed, the prerequisite stays until the fault fired.
    expect(await driver.step({ sample: sample(), now: 4_000, quiet: true, pendingFaults: [answeredFault] })).toBe(false);
    expect(record.journey!.answerTurn).toMatchObject({ issueStatus: "blocked", blockerKept: true });
    expect(driver.awaitingBoard()).toBe(true);
    expect(await driver.step({ sample: sample(), now: 5_000, quiet: true, pendingFaults: [] })).toBe(true);
    expect(calls.at(-1)).toBe('PATCH /api/issues/blocker-1 {"status":"done"}');
    expect(driver.awaitingBoard()).toBe(false);
  });

  it("Q2: counts the answer only from a comment or an accepted run result, never a rejected one", async () => {
    const runAfterAnswer = { id: "r2", status: "succeeded", createdAt: new Date(10_000).toISOString(), startedAt: null,
      finishedAt: new Date(20_000).toISOString(), errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null };
    for (const eventType of ["run.result.rejected", "run.result.accepted"]) {
      const plan: TaskPlan = { taskId: "t01", index: 0, workload: "Q2", adapter: "codex", fault: "K0", fireAfterMs: 0, holdMs: 0,
        followUpAfterMs: null, nonce };
      const record = { plan, issueId: "issue-1", faultIds: [], journey: { requestSeenAt: 1, requestId: "i1",
        blocker: { issueId: "blocker-1", at: 2, error: null },
        answer: { at: 5_000, doneAt: 5_000, httpStatus: 200, error: null, status: "answered", pendingWhenAnswered: true, faultsBefore: 0 } } } as unknown as TaskRecord;
      const api = { baseUrl: "http://x", async get(route: string) {
        if (route.endsWith("/comments")) return [];
        if (route.startsWith("/api/heartbeat-runs/r2/events")) return [{ eventType, payload: { result: { summary: answerMarker(nonce) } } }];
        if (route === "/api/issues/issue-1") return { status: "blocked", blockedBy: [{ id: "blocker-1" }] };
        throw new Error(`unexpected GET ${route}`);
      }, async post() { return {}; }, async patch() { return {}; } };
      const driver = new JourneyDriver("Q2", { plan, api: api as unknown as JourneyHost["api"], lab: { companyId: "c" } as JourneyHost["lab"],
        timeline: new Timeline(null), record, databaseUrl: () => null });
      await driver.step({ sample: { at: 0, reachable: true, serverReady: true, runs: [runAfterAnswer] }, now: 30_000, quiet: true, pendingFaults: [] });
      expect(record.journey!.answerTurn ?? null).toEqual(eventType === "run.result.accepted"
        ? { at: 20_000, issueStatus: "blocked", blockerKept: true } : null);
    }
  });
});

describe("Q3 review clock", () => {
  it("moves the pending review and the token expiry back by the given time, using the schema's names", async () => {
    const queries: Array<{ query: string; params: unknown[] }> = [];
    const hour = 61 * 60_000;
    const client = { async unsafe(query: string, params: unknown[] = []) {
      queries.push({ query, params });
      if (query.startsWith("UPDATE tool_action_requests")) return [{ id: "req" }];
      if (query.startsWith("SELECT") && query.includes("FROM connection_grants")) return [{ id: "g", provider_tenant: { oauth: { accessTokenExpiresAt: "2026-11-10T03:00:00.000Z" } } }];
      if (query.startsWith("SELECT") && query.includes("FROM tool_connections")) return [{ id: "c", config: { oauth: { expiresAt: "2026-11-10T03:00:00.000Z" } }, transport_config: null }];
      return [];
    } };
    const names = reviewClockNames();
    expect(names).toMatchObject({ requests: "tool_action_requests", requestTimes: ["created_at", "updated_at", "expires_at"],
      grants: "connection_grants", grantTenant: "provider_tenant", connections: "tool_connections", connectionTransport: "transport_config" });
    expect(await shiftReviewClockWith(client, names, "req", "c", hour)).toEqual({ requests: 1, grants: 2 });
    expect(queries[0]!.params).toEqual(["req", "3660 seconds"]);
    expect(queries[0]!.query).toContain("expires_at = expires_at - $2::interval");
    const grantUpdate = queries.find(entry => entry.query.startsWith("UPDATE connection_grants"))!;
    expect(JSON.parse(String(grantUpdate.params[1])).oauth.accessTokenExpiresAt).toBe("2026-11-10T01:59:00.000Z");
    const connectionUpdate = queries.find(entry => entry.query.startsWith("UPDATE tool_connections"))!;
    expect(JSON.parse(String(connectionUpdate.params[1])).oauth.expiresAt).toBe("2026-11-10T01:59:00.000Z");
    expect(connectionUpdate.params[2]).toBeNull();
  });
});
