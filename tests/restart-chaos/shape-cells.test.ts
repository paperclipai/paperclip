import net from "node:net";
import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { startEdgeProxy } from "./edge-proxy.js";
import { longTurnChecks, longTurnCommand, longTurnRounds, parseLongTurnLog, withLongTurn } from "./long-turn.js";
import { q1AnswerMarker, q1Code } from "./question-handoff.js";
import { parseRecoveryStep, parseRecoveryStepReceipts, recoveryStepControlSpec, withRecoveryStepCheck } from "./recovery-step-faults.js";
import { generationHome, parseK15DeployShape, redeployEnvironment, redeployIdentity } from "./redeploy.js";
import { awaitingRewake, gradeRewake, noteMarker, rewakeKind, rewakeMarker, rewakeStep, type RewakeArtifacts } from "./rewake.js";
import { planTasks, planWave, taskFaultSchedule } from "./scheduler.js";
import { stableRequestId } from "./observer.js";
import type { OracleArtifacts, RunSample, TaskPlan, TaskRecord, TaskSample } from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const wave = (argv: string[]) => {
  const command = parseCommand(argv);
  if (command.mode !== "wave") throw new Error("expected a wave");
  return command.options;
};

const run = (id: string, status: string, createdAt: number): RunSample => ({ id, status, createdAt: new Date(createdAt).toISOString(), startedAt: null,
  finishedAt: null, errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null });
const sample = (issueStatus: string, runs: RunSample[]): TaskSample => ({ at: 0, reachable: true, serverReady: true, issueStatus, runs });

describe("W2, W2Q, W2C: re-wake after success", () => {
  it("are opt-in workloads that run as K0 cells on one agent", () => {
    expect(wave(["--adapters", "codex"]).workloads).not.toContain("W2");
    const options = wave(["--adapters", "codex", "--workloads", "W2,W2Q,W2C", "--faults", "K0", "--tasks", "10", "--concurrency", "10", "--lifecycle", "warm"]);
    expect(options).toMatchObject({ faults: [], baseline: true, workloads: ["W2", "W2Q", "W2C"] });
    const tasks = planTasks(options);
    expect(tasks).toHaveLength(10);
    expect(new Set(tasks.map(task => task.adapter))).toEqual(new Set(["codex"]));
    expect(tasks.every(task => task.fault === "K0" && taskFaultSchedule(task).length === 0)).toBe(true);
    // The seeded re-wake delay is 0–60 s after the first run settled.
    expect(tasks.every(task => task.followUpAfterMs !== null && task.followUpAfterMs >= 0 && task.followUpAfterMs <= 60_000)).toBe(true);
    expect(() => parseCommand(["--workloads", "W2", "--faults", "K0", "--storm-minutes", "5"])).toThrow("K0");
    // A restart may also land around the first run or the wake.
    expect(planTasks(wave(["--workloads", "W2", "--faults", "K2", "--adapters", "codex", "--tasks", "2"])).map(task => task.fault)).toEqual(["K2", "K2"]);
  });

  it("asks phase 1 to leave the task open and phase 2 to wait for the board", () => {
    const text = workloadDefinitions.W2.description("0bcd1234");
    expect(text).toContain("leave this task `in_progress`");
    expect(text).toContain(rewakeMarker("0bcd1234"));
    expect(workloadDefinitions.W2Q.description("0bcd1234")).toContain("request_human_input");
    expect(rewakeKind({ workload: "W2Q", nonce: "0bcd1234" })).toBe("comment");
    expect(new Set(["00", "10", "20", "30"].map(tail => rewakeKind({ workload: "W2", nonce: `0bcd12${tail}` })))).toEqual(new Set(["comment", "monitor"]));
  });

  function harness(plan: Partial<TaskPlan>) {
    const calls: Array<{ method: string; route: string; body: unknown }> = [];
    const record = { plan: { taskId: "t01", index: 3, nonce: "0bcd1204", followUpAfterMs: 10_000, workload: "W2", ...plan } } as unknown as TaskRecord;
    const api = {
      async get<T>(route: string) { return (route.endsWith("/interactions") ? interactions : []) as T; },
      async post<T>(route: string, body?: unknown) { calls.push({ method: "post", route, body }); return { id: "c1" } as T; },
      async patch<T>(route: string, body?: unknown) { calls.push({ method: "patch", route, body }); return {} as T; },
    };
    let interactions: Array<Record<string, unknown>> = [];
    const notes: string[] = [];
    const step = (s: TaskSample, now: number, boardMayAct = true) => rewakeStep({ api, record, plan: record.plan, issueId: "i1", agentId: "a1",
      sample: s, now, boardMayAct, note: kind => notes.push(kind) });
    return { calls, record, notes, step, setInteractions: (rows: Array<Record<string, unknown>>) => { interactions = rows; } };
  }

  it("W2: wakes the task with a comment after the seeded delay, and waits until a run serves it", async () => {
    const { calls, record, notes, step } = harness({});
    await step(sample("in_progress", [run("r1", "running", 1_000)]), 2_000);
    expect(awaitingRewake(record, 2_000)).toBe(false);
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 5_000);
    expect(record.rewake).toMatchObject({ firstRunId: "r1", firstSettledAt: 5_000 });
    expect(awaitingRewake(record, 5_000)).toBe(true);
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 14_000);
    expect(calls).toHaveLength(0);
    // Faults still pending: the board waits.
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 16_000, false);
    expect(calls).toHaveLength(0);
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 16_000);
    expect(calls).toEqual([{ method: "post", route: "/api/issues/i1/comments", body: { body: expect.stringContaining(rewakeMarker("0bcd1204")) } }]);
    expect(awaitingRewake(record, 17_000)).toBe(true);
    await step(sample("in_progress", [run("r1", "succeeded", 1_000), run("r2", "running", 16_500)]), 20_000);
    expect(record.rewake).toMatchObject({ servedByRunId: "r2" });
    expect(awaitingRewake(record, 20_000)).toBe(false);
    expect(notes).toEqual(["rewake_first_run_settled", "rewake_sent", "rewake_served"]);
  });

  it("W2 monitor: schedules a board monitor due now", async () => {
    const { calls, step } = harness({ nonce: "0bcd1214" });
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 5_000);
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 15_000);
    expect(calls).toEqual([{ method: "patch", route: "/api/issues/i1", body: { executionPolicy: { monitor: {
      nextCheckAt: new Date(17_000).toISOString(), notes: "Phase 2 check for 0bcd1214", scheduledBy: "board" } } } }]);
  });

  it("W2C: changes the agent configuration first, then wakes at least 5 s later", async () => {
    const { calls, record, step } = harness({ workload: "W2C", followUpAfterMs: 0 });
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 5_000);
    expect(calls).toEqual([{ method: "patch", route: "/api/agents/a1", body: { adapterConfig: { idleTimeoutMs: 301_003 } } }]);
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 7_000);
    expect(calls).toHaveLength(1);
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 10_000);
    expect(calls).toHaveLength(2);
  });

  it("W2C: waits CONFIG_SETTLE_MS after a late configuration change", async () => {
    const { calls, record, step } = harness({ workload: "W2C", followUpAfterMs: 0 });
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 5_000, false);
    // The board was held for 30 s; the seeded delay is long past when it may act.
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 35_000);
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 38_000);
    expect(calls).toHaveLength(1);
    await step(sample("in_review", [run("r1", "succeeded", 1_000)]), 40_000);
    expect(calls).toHaveLength(2);
    expect(record.rewake?.configChange).toMatchObject({ httpStatus: 200, idleTimeoutMs: 301_003 });
  });

  it("W2Q: comments while the question is pending, and answers only after that run settled", async () => {
    const { calls, record, step, setInteractions } = harness({ workload: "W2Q", followUpAfterMs: 0 });
    setInteractions([{ id: "q1", kind: "ask_user_questions", status: "pending", sourceRunId: "r1",
      payload: { questions: [{ id: "codename", options: [{ id: "opt-a", label: "ALPHA" }, { id: "opt-b", label: "BRAVO" }] }] } }]);
    await step(sample("in_progress", [run("r1", "running", 1_000)]), 2_000);
    expect(record.rewake?.firstSettledAt).toBeNull();
    await step(sample("in_progress", [run("r1", "succeeded", 1_000)]), 4_000);
    expect(calls.map(call => call.route)).toEqual(["/api/issues/i1/comments"]);
    expect(calls[0]!.body).toEqual({ body: expect.stringContaining(noteMarker("0bcd1204")) });
    await step(sample("in_progress", [run("r1", "succeeded", 1_000), run("r2", "running", 4_500)]), 6_000);
    expect(calls).toHaveLength(1);
    expect(awaitingRewake(record, 6_000)).toBe(true);
    await step(sample("in_progress", [run("r1", "succeeded", 1_000), run("r2", "succeeded", 4_500)]), 9_000);
    expect(calls.map(call => call.route)).toEqual(["/api/issues/i1/comments", "/api/issues/i1/interactions/q1/respond"]);
    expect(awaitingRewake(record, 9_000)).toBe(false);
  });

  const rewakeArtifacts = (overrides: Partial<RewakeArtifacts> = {}): RewakeArtifacts => ({ kind: "comment", firstRunId: "r1", firstSettledAt: 5_000,
    sent: { at: 16_000, kind: "comment", statusAtWake: "in_review", httpStatus: 200, error: null }, servedByRunId: "r2",
    runs: [{ id: "r1", status: "succeeded", errorCode: null, createdAt: null, finishedAt: null },
      { id: "r2", status: "succeeded", errorCode: null, createdAt: null, finishedAt: null }], ...overrides });
  const artifacts = (brief: string, rewake: RewakeArtifacts, extra: Partial<OracleArtifacts> = {}): OracleArtifacts => ({ issueStatus: "done",
    documents: { brief }, agentComments: [], files: {}, commands: {}, workspacePath: null, rewake, ...extra });

  it("grades a served wake and fails a failed attempt before it (staging class C+)", () => {
    const brief = `CHAOS-0bcd1204\n- a\n- b\n- c\n${rewakeMarker("0bcd1204")}\n`;
    expect(gradeRewake({ workload: "W2", nonce: "0bcd1204" }, artifacts(brief, rewakeArtifacts())).verdict).toBe("pass");
    const failed = gradeRewake({ workload: "W2", nonce: "0bcd1204" }, artifacts(brief, rewakeArtifacts({ servedByRunId: "r2", runs: [
      { id: "r1", status: "succeeded", errorCode: null, createdAt: null, finishedAt: null },
      { id: "r2", status: "failed", errorCode: "provider_transport_failed", createdAt: null, finishedAt: null },
      { id: "r3", status: "succeeded", errorCode: null, createdAt: null, finishedAt: null }] })));
    expect(failed.checks.filter(check => !check.ok).map(check => check.name)).toEqual(["rewake_served", "no_failed_attempt"]);
    const w2q = gradeRewake({ workload: "W2Q", nonce: "0bcd1204" }, artifacts(`${q1AnswerMarker("0bcd1204", q1Code("0bcd1204"))}\n${noteMarker("0bcd1204")}\n- a\n- b\n- c`,
      rewakeArtifacts(), { question: { interactionIds: ["q1"], seenAt: 1, askedByRunId: "r1", pendingNow: false, statuses: {}, runs: [],
        answer: { at: 20_000, interactionId: "q1", code: q1Code("0bcd1204"), httpStatus: 200, error: null } } }));
    expect(w2q.verdict).toBe("pass");
  });
});

describe("--fail-recovery-step", () => {
  it("names a step by its short name or crash point, after a restart fault, in an environment that reaches it", () => {
    expect(parseRecoveryStep("directory-lock:2")).toEqual({ point: "agent_directory.operation_lock.before_acquire", nth: 2 });
    expect(parseRecoveryStep("native.process_start.after_requested_before_spawn")).toEqual({ point: "native.process_start.after_requested_before_spawn", nth: 1 });
    expect(recoveryStepControlSpec({ point: "environment.teardown.after_claim_before_destroy", nth: 3 })).toBe("environment.teardown.after_claim_before_destroy:3 fail");
    expect(() => parseRecoveryStep("nope")).toThrow("unknown step");
    expect(wave(["--faults", "K1", "--fail-recovery-step", "runnerd-start:2"]).failRecoveryStep).toBe("native.process_start.after_requested_before_spawn:2");
    expect(() => parseCommand(["--faults", "K0", "--workloads", "A1", "--fail-recovery-step", "runnerd-start"])).toThrow("add one of");
    expect(() => parseCommand(["--faults", "K1", "--fail-recovery-step", "directory-lock"])).toThrow("--env daytona");
  });

  it("checks that the armed step failed and that no attempt of a crossed task failed", () => {
    const hits = parseRecoveryStepReceipts([JSON.stringify({ point: "x", hit: 2, pid: 1, token: "rs-f01", mode: "fail" }),
      JSON.stringify({ point: "y", hit: 1, pid: 1 }), "partial"].join("\n"));
    expect(hits).toHaveLength(1);
    const base = { verdict: "pass" as const, checks: [{ name: "issue_done", ok: true }] };
    const armed = { faultId: "f01", spec: "x:2", token: "rs-f01" };
    expect(withRecoveryStepCheck(base, armed, ["f02"], hits, [])).toBe(base);
    expect(withRecoveryStepCheck(base, armed, ["f01"], hits, [{ id: "r1", status: "succeeded", errorCode: null }]).verdict).toBe("pass");
    const failed = withRecoveryStepCheck(base, armed, ["f01"], hits, [{ id: "r1", status: "failed", errorCode: "runner_remote_process_identity_unavailable" }]);
    expect(failed.checks.find(check => check.name === "no_failed_attempt")).toMatchObject({ ok: false });
    expect(withRecoveryStepCheck(base, armed, ["f01"], [], []).checks.find(check => check.name === "recovery_step_failed_once")).toMatchObject({ ok: false });
  });
});

describe("--long-turn-minutes", () => {
  it("puts rounds of real tool work in front of any workload, with a longer budget and its own checks", () => {
    const options = wave(["--workloads", "A1", "--faults", "K1", "--long-turn-minutes", "15", "--adapters", "codex", "--tasks", "1"]);
    expect(options.longTurnMinutes).toBe(15);
    expect(planWave("w-20261111T000000-s1", options).tasks[0]).toMatchObject({ longTurnMinutes: 15 });
    expect(() => parseCommand(["--long-turn-minutes", "5"])).toThrow("between 15 and 60");
    expect(() => parseCommand(["--workloads", "Q1", "--faults", "K1", "--matrix", "--long-turn-minutes", "15"])).toThrow("not a --matrix option");
    const definition = withLongTurn(workloadDefinitions.A1, 15);
    expect(definition.budgetMs).toBe(workloadDefinitions.A1.budgetMs + 15 * 60_000);
    expect(definition.collect.documents).toEqual(["brief", "long-turn"]);
    expect(definition.description("0bcd1234")).toContain(`Run this shell command ${longTurnRounds(15)} times`);
    expect(longTurnCommand("0bcd1234", 3)).toContain("ROUND 3 $s");
    expect(withLongTurn(workloadDefinitions.A1, undefined)).toBe(workloadDefinitions.A1);
  });

  it("checks the reported rounds and a run the harness saw last the whole turn", () => {
    const start = 1_800_000_000;
    const log = Array.from({ length: 10 }, (_, index) => `ROUND ${index + 1} ${start + index * 92} ${start + index * 92 + 91} 1234`).join("\n");
    expect(parseLongTurnLog(log)).toHaveLength(10);
    const runs = [{ id: "r1", status: "succeeded", errorCode: null, createdAt: new Date(0).toISOString(), finishedAt: new Date(16 * 60_000).toISOString() }];
    expect(longTurnChecks(15, { documents: { "long-turn": log }, runs }).every(check => check.ok)).toBe(true);
    const short = longTurnChecks(15, { documents: { "long-turn": log.split("\n").slice(0, 4).join("\n") }, runs: [{ ...runs[0]!, finishedAt: new Date(5 * 60_000).toISOString() }] });
    expect(short.map(check => check.ok)).toEqual([false, false]);
  });
});

describe("K15 staging deploy shape", () => {
  it("parses the overlap and the fresh home, and refuses what does not fit", () => {
    const options = wave(["--env", "daytona", "--daytona-image", `ghcr.io/x/y@sha256:${"a".repeat(64)}`, "--faults", "K15", "--k15-overlap-seconds", "30-150",
      "--k15-fresh-home", "--concurrency", "2"]);
    expect(options).toMatchObject({ k15HoldMs: [30_000, 150_000], k15Overlap: true, k15FreshHome: true });
    expect(planTasks(options).every(task => task.fault !== "K15" || (task.holdMs >= 30_000 && task.holdMs <= 150_000))).toBe(true);
    expect(() => parseK15DeployShape({ env: "local", faults: ["K15"] }, undefined, true)).toThrow("--env daytona");
    expect(() => parseK15DeployShape({ env: "daytona", faults: ["K1"] }, "30", false)).toThrow("add K15");
    expect(() => parseK15DeployShape({ env: "daytona", faults: ["K15"], k15HoldMs: [1, 2] }, "30", false)).toThrow("--k15-hold-seconds");
    expect(() => parseK15DeployShape({ env: "daytona", faults: ["K15"] }, "2-3", false)).toThrow("between 5 and 600");
  });

  it("runs volume-free servers only on Daytona with the wave's object store", () => {
    const image = `ghcr.io/x/y@sha256:${"a".repeat(64)}`;
    expect(wave(["--env", "daytona", "--daytona-image", image, "--storage", "s3", "--ephemeral-server", "--faults", "K15", "--k15-fresh-home"]))
      .toMatchObject({ ephemeralServer: true, storage: "s3", k15FreshHome: true });
    expect(wave(["--env", "daytona", "--daytona-image", image])).not.toHaveProperty("ephemeralServer");
    expect(wave(["--env", "daytona", "--daytona-image", image, "--storage", "s3", "--ephemeral-server"]).workloads.every(workload => !workloadDefinitions[workload].usesRepository)).toBe(true);
    expect(workloadDefinitions.W2.startComment?.("n1")).toContain("CHAOS-n1");
    expect(workloadDefinitions.W2C.startComment).toBeDefined();
    expect(workloadDefinitions.W2Q.startComment).toBeUndefined();
    expect(stableRequestId("start-t01-n1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableRequestId("start-t01-n1")).toBe(stableRequestId("start-t01-n1"));
    expect(stableRequestId("start-t02-n1")).not.toBe(stableRequestId("start-t01-n1"));
    expect(wave(["--env", "daytona", "--daytona-image", image, "--faults", "K15", "--k15-fresh-home"]))
      .toMatchObject({ ephemeralServer: true, storage: "s3", k15FreshHome: true });
    expect(() => wave(["--env", "daytona", "--daytona-image", image, "--storage", "local", "--faults", "K15", "--k15-fresh-home"]))
      .toThrow("--k15-fresh-home");
    expect(() => wave(["--env", "daytona", "--daytona-image", image, "--ephemeral-server"])).toThrow("--storage s3");
    expect(() => wave(["--env", "local", "--storage", "s3", "--ephemeral-server"])).toThrow("--env daytona");
    expect(() => wave(["--env", "daytona", "--daytona-image", image, "--storage", "s3", "--ephemeral-server", "--workloads", "A1,B1"])).toThrow("B1");
  });

  it("drops the volume variables for a fresh home, and gives each generation its own home", () => {
    const identity = redeployIdentity("w-20261111T000000-s1", 1);
    expect(redeployEnvironment(identity, "/tmp/home")).toMatchObject({ RAILWAY_VOLUME_MOUNT_PATH: "/tmp/home" });
    expect(redeployEnvironment(identity, null)).not.toHaveProperty("RAILWAY_VOLUME_ID");
    expect(generationHome("/tmp/root", "/tmp/root/home", 0)).toBe("/tmp/root/home");
    expect(generationHome("/tmp/root", "/tmp/root/home", 2)).toBe("/tmp/root/home-g2");
  });

  it("switches new connections at the edge while old connections stay on the old backend", async () => {
    const listen = (reply: string) => new Promise<net.Server>(resolve => {
      const server = net.createServer(socket => socket.end(reply));
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const port = (server: net.Server) => (server.address() as net.AddressInfo).port;
    const read = (edgePort: number) => new Promise<string>((resolve, reject) => {
      const socket = net.connect(edgePort, "127.0.0.1");
      let text = "";
      socket.on("data", chunk => { text += chunk.toString(); });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    const [a, b] = await Promise.all([listen("A"), listen("B")]);
    const free = await listen("");
    const edgePort = port(free);
    await new Promise<void>(resolve => free.close(() => resolve()));
    const edge = await startEdgeProxy(edgePort, port(a));
    try {
      expect(await read(edgePort)).toBe("A");
      edge.target = port(b);
      expect(await read(edgePort)).toBe("B");
    } finally {
      await edge.close();
      a.close(); b.close();
    }
  });
});
