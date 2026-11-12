import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import {
  agentRunCaps, assignAdapters, childLine, childNonce, doneMarker, expectedRoundHash, followUpMarker, gradeStagingMix, holdsRetry, planArrivals,
  followUpRequestId, planFaultCarriers, planStagingMixWave, plannedTaskCount, posixCksum, retryDue, roundCommand, ROUND_SECONDS, setOverlapProbe, stagingMixDescription,
  stagingMixStep, SUBTASK_ROUNDS, verifyLedger, type StagingMixTask,
} from "./staging-mix.js";
import { descendantsOf, parseMemInfo, parsePs, parseVmStat, StagingMixRun, stagingMixSeedOptions, unfiredFaultSlots, type ResourceSample } from "./staging-mix-run.js";
import type { OracleArtifacts, TaskRecord, TaskSample } from "./types.js";

const IMAGE = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"a".repeat(64)}`;

const wave = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const command = parseCommand(argv);
    if (command.mode !== "wave") throw new Error("expected a wave");
    return command.options;
  } finally {
    for (const key of Object.keys(env)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
};

const ledgerFor = (nonce: string, rounds: number, extra: string[] = []) => [
  ...Array.from({ length: rounds }, (_, index) => `ROUND ${index + 1} ${1_800_000_000 + index * 100} ${1_800_000_000 + index * 100 + ROUND_SECONDS} ${expectedRoundHash(nonce, index + 1)}`),
  ...extra,
].join("\n");

const artifacts = (overrides: Partial<OracleArtifacts>): OracleArtifacts => ({
  issueStatus: "done", documents: {}, agentComments: [], files: {}, commands: {}, workspacePath: null, ...overrides,
});

const task = (overrides: Partial<StagingMixTask> = {}): StagingMixTask => ({
  turnMinutes: 5, rounds: 4, subtasks: 0, followUpAfterMs: null, arriveAtMs: 0, holdMs: 600_000, ...overrides,
});

describe("staging-mix options", () => {
  it("expands --workload staging-mix into one SM wave with the mix's concurrency, adapters and task count", () => {
    const options = wave(["--workload", "staging-mix", "--faults", "K0", "--seed", "5", "--mix-runs", "30", "--mix-queue", "6", "--mix-minutes", "240"]);
    expect(options.workloads).toEqual(["SM"]);
    expect(options.adapters).toEqual(["opencode", "codex", "claude"]);
    expect(options.concurrency).toBe(36);
    expect(options.tasks).toBe(plannedTaskCount(options.stagingMix!));
    expect(options.tasks).toBeGreaterThan(200);
    expect(options.stagingMix).toMatchObject({ runs: 30, queue: 6, minutes: 240, turnMinutes: [15, 45], subtaskShare: 30, followUpShare: 50, faultSpacingMinutes: 40 });
  });

  it("refuses more runs than the local run cap, and lets the cap be raised", () => {
    expect(() => wave(["--workload", "staging-mix", "--faults", "K0", "--mix-runs", "31"])).toThrow(/local run cap of 30/);
    expect(() => wave(["--workload", "staging-mix", "--faults", "K0", "--mix-runs", "12", "--mix-run-cap", "10"])).toThrow(/run cap of 10/);
    expect(wave(["--workload", "staging-mix", "--faults", "K0", "--mix-runs", "40"], { RESTART_CHAOS_MIX_RUN_CAP: "40" }).stagingMix!.runs).toBe(40);
  });

  it("refuses flags that conflict with its own planning and faults it cannot clock", () => {
    expect(() => wave(["--workload", "staging-mix", "--concurrency", "4"])).toThrow(/do not combine it with --concurrency/);
    expect(() => wave(["--workload", "staging-mix", "--workloads", "A1"])).toThrow(/--workloads/);
    expect(() => wave(["--workload", "staging-mix", "--faults", "TM1"])).toThrow(/remove TM1/);
    expect(() => wave(["--workload", "other"])).toThrow(/Unknown --workload/);
    expect(() => wave(["--mix-runs", "5"])).toThrow(/needs --workload staging-mix/);
    expect(() => wave(["--workload", "staging-mix", "--faults", "K15", "--fault-after-seconds", "60"])).toThrow(/do not combine it with --fault-after-seconds/);
  });

  it("honours --k4-hold-max-seconds for K4 slots", () => {
    const options = wave(["--workload", "staging-mix", "--faults", "K4", "--seed", "3", "--k4-hold-max-seconds", "600"]);
    const holds = planStagingMixWave("w-20261112T000000-s3", options).tasks.filter(entry => entry.fault === "K4").map(entry => entry.holdMs);
    expect(holds.length).toBe(5);
    expect(holds.every(hold => hold >= 120_000 && hold <= 600_000)).toBe(true);
    const many = Array.from({ length: 40 }, (_, seed) => planStagingMixWave("w", wave(["--workload", "staging-mix", "--faults", "K4", "--seed", String(seed), "--k4-hold-max-seconds", "600"])).tasks)
      .flat().filter(entry => entry.fault === "K4").map(entry => entry.holdMs);
    expect(Math.max(...many)).toBeGreaterThan(300_000);
  });

  it("fails fast on a malformed memory floor instead of turning the guard off", () => {
    expect(() => wave(["--workload", "staging-mix", "--faults", "K0"], { RESTART_CHAOS_MIX_MIN_FREE_MB: "lots" })).toThrow(/RESTART_CHAOS_MIX_MIN_FREE_MB must be a whole number/);
    expect(() => wave(["--workload", "staging-mix", "--faults", "K0"], { RESTART_CHAOS_MIX_MIN_FREE_MB: "" })).toThrow(/RESTART_CHAOS_MIX_MIN_FREE_MB/);
    expect(wave(["--workload", "staging-mix", "--faults", "K0"], { RESTART_CHAOS_MIX_MIN_FREE_MB: "8192" }).stagingMix!.minFreeMb).toBe(8192);
    expect(wave(["--workload", "staging-mix", "--faults", "K0"]).stagingMix!.minFreeMb).toBe(3072);
  });

  it("checks the Daytona vCPU budget against running, queued and idle warm sandboxes", () => {
    const daytona = ["--workload", "staging-mix", "--env", "daytona", "--daytona-image", IMAGE, "--faults", "K0", "--daytona-warm", "--daytona-cpu", "1"];
    expect(() => wave(daytona)).toThrow(/about 41 sandboxes/);
    expect(wave(daytona, { RESTART_CHAOS_DAYTONA_VCPU_BUDGET: "48" }).stagingMix!.runs).toBe(30);
    expect(wave([...daytona, "--mix-runs", "5", "--mix-queue", "1", "--mix-turn-minutes", "5"]).concurrency).toBe(6);
  });

  it("parses a ratio and splits the agents' run caps to the runs", () => {
    const options = wave(["--workload", "staging-mix", "--faults", "K0", "--mix-ratio", "opencode=60,codex=25,claude=15", "--mix-runs", "30"]);
    expect(stagingMixSeedOptions(options).maxConcurrentRunsByAdapter).toEqual({ opencode: 17, codex: 8, claude: 5 });
    expect(agentRunCaps([["opencode", 1], ["codex", 1], ["claude", 1]], 3)).toEqual({ opencode: 1, codex: 1, claude: 1 });
  });

  it("never gives the agents more runs than requested, even for an uneven ratio", () => {
    expect(agentRunCaps([["opencode", 98], ["codex", 1], ["claude", 1]], 30)).toEqual({ opencode: 28, codex: 1, claude: 1 });
    for (const runs of [3, 4, 7, 30, 31, 97]) {
      for (const ratio of [[["opencode", 98], ["codex", 1], ["claude", 1]], [["opencode", 60], ["codex", 25], ["claude", 15]], [["opencode", 1], ["codex", 1000]]] as Array<Array<["opencode" | "codex" | "claude", number]>>) {
        const caps = Object.values(agentRunCaps(ratio, runs));
        expect(caps.reduce((sum, cap) => sum + cap, 0)).toBe(runs);
        expect(Math.min(...caps)).toBeGreaterThanOrEqual(1);
      }
    }
    expect(() => wave(["--workload", "staging-mix", "--mix-ratio", "grok=5"])).toThrow(/adapter=weight/);
    expect(wave(["--workload", "staging-mix", "--faults", "K0", "--mix-ratio", "opencode=1,codex=0"]).adapters).toEqual(["opencode"]);
  });
});

describe("staging-mix planning", () => {
  it("interleaves adapters so every prefix keeps the ratio", () => {
    const adapters = assignAdapters([["opencode", 60], ["codex", 25], ["claude", 15]], 100);
    const count = (slice: string[], adapter: string) => slice.filter(entry => entry === adapter).length;
    expect([count(adapters, "opencode"), count(adapters, "codex"), count(adapters, "claude")]).toEqual([60, 25, 15]);
    const six = adapters.slice(0, 6);
    expect(count(six, "opencode")).toBe(4);
    expect(count(six, "codex") + count(six, "claude")).toBe(2);
  });

  it("fills the in-flight target in a burst, then keeps tasks arriving until the wave's last minute", () => {
    let state = 0;
    const arrivals = planArrivals(100, 36, 240 * 60_000, () => (state = (state * 9301 + 49297) % 233280) / 233280);
    expect(arrivals.slice(0, 36)).toEqual(Array.from({ length: 36 }, (_, index) => index * 5_000));
    expect(arrivals).toEqual([...arrivals].sort((a, b) => a - b));
    expect(arrivals.at(-1)!).toBeGreaterThan(230 * 60_000);
    expect(arrivals.at(-1)!).toBeLessThan(240 * 60_000);
    const gaps = arrivals.slice(37).map((at, index) => at - arrivals[36 + index]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(Math.ceil(1.5 * ((240 * 60_000 - 36 * 5_000) / 64)));
  });

  it("puts one fault on the clock every spacing, on a task already running, cycling the kinds", () => {
    const arrivals = Array.from({ length: 60 }, (_, index) => index * 4 * 60_000);
    const { carriers, missedSlotsMs } = planFaultCarriers(arrivals.map(arriveAtMs => ({ arriveAtMs, turnMs: 20 * 60_000 })), 40 * 60_000, 240 * 60_000, ["K15", "K1"]);
    expect(missedSlotsMs).toEqual([]);
    expect(carriers.size).toBe(5);
    const fired = [...carriers.entries()].map(([index, carrier]) => ({ at: arrivals[index]! + carrier.fireAfterMs, kind: carrier.kind, lead: carrier.fireAfterMs }));
    expect(fired.map(entry => entry.at)).toEqual([40, 80, 120, 160, 200].map(minutes => minutes * 60_000));
    expect(fired.map(entry => entry.kind)).toEqual(["K15", "K1", "K15", "K1", "K15"]);
    expect(fired.every(entry => entry.lead >= 60_000)).toBe(true);
    expect(planFaultCarriers(arrivals.map(arriveAtMs => ({ arriveAtMs, turnMs: 20 * 60_000 })), 40 * 60_000, 240 * 60_000, []).carriers.size).toBe(0);
  });

  it("only puts a fault on a task still in its turn, and refuses a plan whose slot no task covers", () => {
    const burst = Array.from({ length: 6 }, (_, index) => ({ arriveAtMs: index * 5_000, turnMs: 6 * 60_000 }));
    const planned = planFaultCarriers(burst, 40 * 60_000, 240 * 60_000, ["K15"]);
    expect(planned.carriers.size).toBe(0);
    expect(planned.missedSlotsMs).toEqual([40, 80, 120, 160, 200].map(minutes => minutes * 60_000));
    const options = wave(["--workload", "staging-mix", "--faults", "K15", "--mix-tasks", "6", "--mix-turn-minutes", "5", "--mix-minutes", "240"]);
    expect(() => planStagingMixWave("w-20261112T000000-s1", options)).toThrow(/No planned task is still in its turn at the fault slot\(s\) 40 min/);
    const smoke = wave(["--workload", "staging-mix", "--faults", "K15", "--mix-runs", "5", "--mix-queue", "1", "--mix-tasks", "6", "--mix-turn-minutes", "5",
      "--mix-minutes", "7", "--mix-fault-spacing-minutes", "3"]);
    const carriers = planStagingMixWave("w-20261112T000000-s1", smoke).tasks.filter(entry => entry.fault === "K15");
    expect(carriers.map(entry => entry.stagingMix!.arriveAtMs + entry.fireAfterMs).sort((a, b) => a - b)).toEqual([3 * 60_000, 6 * 60_000]);
    expect(carriers.every(entry => entry.fireAfterMs <= entry.stagingMix!.rounds * ROUND_SECONDS * 1_000)).toBe(true);
  });

  it("names every planned fault slot that never fired, so the wave fails instead of passing untested", () => {
    const options = wave(["--workload", "staging-mix", "--faults", "K15", "--mix-runs", "5", "--mix-queue", "1", "--mix-tasks", "6", "--mix-turn-minutes", "5",
      "--mix-minutes", "7", "--mix-fault-spacing-minutes", "3"]);
    const tasks = planStagingMixWave("w-20261112T000000-s1", options).tasks;
    const carriers = tasks.filter(entry => entry.fault === "K15").map(entry => entry.taskId);
    expect(unfiredFaultSlots(tasks, [])).toEqual(carriers.map(id => `${id}:K15`));
    expect(unfiredFaultSlots(tasks, [{ requestedBy: carriers[0]! }])).toEqual([`${carriers[1]}:K15`]);
    expect(unfiredFaultSlots(tasks, carriers.map(requestedBy => ({ requestedBy })))).toEqual([]);
  });

  it("plans a deterministic wave where tasks start before a swap and are still running after the next two", () => {
    const options = wave(["--workload", "staging-mix", "--faults", "K15", "--seed", "9", "--mix-turn-minutes", "15-45", "--mix-fault-spacing-minutes", "40"]);
    const plan = planStagingMixWave("w-20261112T000000-s9", options);
    expect(planStagingMixWave("w-20261112T000000-s9", options).tasks).toEqual(plan.tasks);
    const faults = plan.tasks.filter(entry => entry.fault === "K15");
    expect(faults.length).toBe(5);
    expect(plan.tasks.filter(entry => entry.fault === "K0").length).toBe(plan.tasks.length - 5);
    const parents = plan.tasks.filter(entry => entry.stagingMix!.subtasks > 0).length / plan.tasks.length;
    expect(parents).toBeGreaterThan(0.2);
    expect(parents).toBeLessThan(0.4);
    expect(plan.tasks.every(entry => entry.stagingMix!.turnMinutes >= 15 && entry.stagingMix!.turnMinutes <= 45)).toBe(true);
    const followUps = plan.tasks.filter(entry => entry.stagingMix!.followUpAfterMs !== null);
    expect(followUps.every(entry => entry.stagingMix!.followUpAfterMs! <= entry.stagingMix!.rounds * ROUND_SECONDS * 1_000)).toBe(true);
    expect(plan.tasks.some(entry => entry.stagingMix!.arriveAtMs > 200 * 60_000)).toBe(true);
  });

  it("names every subtask's own nonce and the hash the parent must report", () => {
    const text = stagingMixDescription("abcd1234", task({ subtasks: 2, rounds: 3 }), { self: { id: "agent-1", name: "Chaos opencode" }, other: { id: "agent-1", name: "Chaos opencode" } });
    expect(text).toContain(`SM sub 1 ${childNonce("abcd1234", 1)}`);
    expect(text).toContain(`SM sub 2 ${childNonce("abcd1234", 2)}`);
    expect(text).toContain("Chaos opencode (agent id agent-1)");
    expect(text).toContain(doneMarker("abcd1234"));
    expect(text).toContain("CHILD-1=<hash>");
    expect(text).toContain("3 times");
  });
});

describe("staging-mix deliverable", () => {
  it("computes the same hash as the round command in a real shell", () => {
    for (const input of ["", "a", "abcd1234-1 1", "x".repeat(300)]) {
      const shell = execFileSync("sh", ["-c", `printf '%s' "$1" | cksum | cut -d' ' -f1`, "sh", input], { encoding: "utf8" }).trim();
      expect(String(posixCksum(input))).toBe(shell);
    }
    const command = roundCommand("feedc0de").replaceAll("<N>", "2").replace("sleep 2", "true").replace(/>> \S+; tail -n 1 \S+$/, "");
    const line = execFileSync("sh", ["-c", command], { encoding: "utf8" }).trim();
    expect(line.split(" ").at(-1)).toBe(expectedRoundHash("feedc0de", 2));
  });

  it("verifies every round once, and counts a repeated round as a duplicated side effect", () => {
    expect(verifyLedger("n1", 3, ledgerFor("n1", 3))).toMatchObject({ verified: true, duplicates: 0 });
    expect(verifyLedger("n1", 3, ledgerFor("n1", 2)).detail).toContain("missing=3");
    expect(verifyLedger("n1", 3, ledgerFor("n1", 3).replace(expectedRoundHash("n1", 2), "123")).detail).toContain("wrong_hash=2");
    const repeated = `${ledgerFor("n1", 3)}\n${ledgerFor("n1", 3).split("\n")[1]}`;
    expect(verifyLedger("n1", 3, repeated)).toMatchObject({ verified: true, duplicates: 1 });
    const short = ledgerFor("n1", 1).replace(/ (\d+) (\d+) (\d+)$/, (_, start, _end, hash) => ` ${start} ${Number(start) + 30} ${hash}`);
    expect(verifyLedger("n1", 1, short).detail).toContain("short=1");
  });

  it("passes a finished task and fails status-only completion, duplicates, a lost follow-up and an unread subtask", () => {
    const nonce = "cafe0001";
    const base = artifacts({ documents: { ledger: ledgerFor(nonce, 4) }, agentComments: [doneMarker(nonce)] });
    expect(gradeStagingMix(nonce, task(), base).verdict).toBe("pass");
    expect(gradeStagingMix(nonce, task(), artifacts({ agentComments: [doneMarker(nonce)] })).verdict).toBe("fail");
    const twice = gradeStagingMix(nonce, task(), { ...base, agentComments: [doneMarker(nonce), doneMarker(nonce)] });
    expect(twice.checks.find(check => check.name === "done_comment_once")!.ok).toBe(false);
    const withFollowUp = { ...base, stagingMix: { followUp: { at: 1, commentId: "c1", duringRun: true, inOverlap: true, error: null }, followUpErrors: [], retries: [] } };
    expect(gradeStagingMix(nonce, task(), withFollowUp).checks.find(check => check.name === "follow_up_served")!.ok).toBe(false);
    expect(gradeStagingMix(nonce, task({ followUpAfterMs: 1 }), { ...withFollowUp, documents: { ledger: ledgerFor(nonce, 4, [followUpMarker(nonce)]) } }).verdict).toBe("pass");
    const neverPosted = gradeStagingMix(nonce, task({ followUpAfterMs: 1 }), { ...base, stagingMix: { followUp: null, followUpErrors: ["HTTP 502"], retries: [] } });
    expect(neverPosted.checks.find(check => check.name === "follow_up_posted")).toMatchObject({ ok: false, detail: "never posted; errors: HTTP 502" });
    expect(gradeStagingMix(nonce, task({ followUpAfterMs: 1 }), base).checks.find(check => check.name === "follow_up_posted")!.ok).toBe(false);

    const children = [1, 2].map(part => ({ id: `c${part}`, title: `SM sub ${part} ${childNonce(nonce, part)}`, status: "done", assigneeAgentId: "a",
      documents: { ledger: ledgerFor(childNonce(nonce, part), SUBTASK_ROUNDS) } }));
    const childLines = [1, 2].map(part => childLine(part, expectedRoundHash(childNonce(nonce, part), SUBTASK_ROUNDS)));
    const parent = artifacts({ documents: { ledger: ledgerFor(nonce, 4, childLines) }, agentComments: [doneMarker(nonce)], children });
    expect(gradeStagingMix(nonce, task({ subtasks: 2 }), parent).verdict).toBe("pass");
    const unread = gradeStagingMix(nonce, task({ subtasks: 2 }), { ...parent, documents: { ledger: ledgerFor(nonce, 4, childLines.slice(0, 1)) } });
    expect(unread.checks.filter(check => !check.ok).map(check => check.name)).toEqual(["parent_read_subtask_2"]);
    const extra = gradeStagingMix(nonce, task({ subtasks: 2 }), { ...parent, children: [...children, { ...children[0]!, id: "c3" }] });
    expect(extra.checks.find(check => check.name === "subtasks_once")!.ok).toBe(false);
  });
});

describe("staging-mix board step", () => {
  const requests: Array<string | undefined> = [];
  const record = (overrides: Partial<TaskRecord> = {}) => ({ issueId: "i1", createdAt: 0, retry: null, lastFaultAt: undefined, ...overrides }) as TaskRecord;
  const running: TaskSample = { at: 0, reachable: true, serverReady: false, issueStatus: "in_progress",
    runs: [{ id: "r1", status: "running", createdAt: null, startedAt: null, finishedAt: null, errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null }] };
  const failed: TaskSample = { at: 0, reachable: true, serverReady: true, issueStatus: "blocked",
    interruption: { state: "failed", canRetry: true, retryWait: false, workspaceFailure: null, observedRunId: "r1", userAction: null },
    runs: [{ ...running.runs![0]!, status: "failed" }] };
  const step = async (rec: TaskRecord, sample: TaskSample, now: number, faultInProgress: boolean, plan = task({ followUpAfterMs: 60_000 }),
    reply: () => unknown = () => ({ id: "c1" })) => {
    const posted: string[] = [], retried: number[] = [], notes: string[] = [];
    await stagingMixStep({ api: { post: async (_path: string, body: unknown) => { posted.push(JSON.stringify(body)); requests.push((body as { clientRequestId?: string }).clientRequestId); return reply() as never; } },
      record: rec, task: plan, nonce: "n1", sample, now, faultInProgress, retry: async (_sample, at) => { retried.push(at); rec.retry = { at } as never; },
      note: kind => notes.push(kind) });
    return { posted, retried, notes };
  };

  it("posts the follow-up inside a swap's overlap, or once the hold runs out", async () => {
    const early = record();
    expect((await step(early, running, 30_000, true)).posted).toEqual([]);
    expect((await step(early, running, 70_000, false)).posted).toEqual([]);
    const inOverlap = await step(early, running, 80_000, true);
    expect(inOverlap.posted[0]).toContain(followUpMarker("n1"));
    expect(early.stagingMix!.followUp).toMatchObject({ inOverlap: true, duringRun: true, commentId: "c1" });
    expect((await step(early, running, 90_000, true)).posted).toEqual([]);
    const late = record();
    const held = await step(late, running, 60_000 + 600_000, false);
    expect(held.posted.length).toBe(1);
    expect(late.stagingMix!.followUp!.inOverlap).toBe(false);
  });

  it("tries a failed follow-up again on the next poll and keeps every error for the grade", async () => {
    const rec = record();
    const failing = await step(rec, running, 80_000, true, undefined, () => { throw new Error("HTTP 502"); });
    expect(failing.posted.length).toBe(1);
    expect(rec.stagingMix!.followUp).toBeUndefined();
    await step(rec, running, 83_000, true, undefined, () => ({}));
    expect(rec.stagingMix!.followUpErrors).toEqual(["HTTP 502", "the comment response had no id"]);
    expect((await step(rec, running, 86_000, true)).posted.length).toBe(1);
    expect(rec.stagingMix!.followUp).toMatchObject({ commentId: "c1", at: 86_000 });
    const keys = requests.slice(-3);
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toBe(followUpRequestId("i2", "n1"));
  });

  it("posts the follow-up before the turn's last rounds when no overlap comes", async () => {
    const rec = record();
    const plan = task({ rounds: 4, followUpAfterMs: 60_000 });
    expect((await step(rec, running, 60_000 + 200_000, false, plan)).posted).toEqual([]);
    expect((await step(rec, running, Math.round(4 * ROUND_SECONDS * 1_000 * 0.85), false, plan)).posted.length).toBe(1);
  });

  it("waits for an overlap to click a Retry, and holds the observer's own click until the hold runs out", async () => {
    const rec = record();
    expect((await step(rec, failed, 1_000, false)).retried).toEqual([]);
    expect(holdsRetry(rec, 600_000, 2_000)).toBe(true);
    expect(holdsRetry(rec, 600_000, 1_000 + 600_000)).toBe(false);
    expect((await step(rec, failed, 5_000, true)).retried).toEqual([5_000]);
    expect(rec.stagingMix!.retries).toEqual([{ at: 5_000, inOverlap: true }]);
    expect(retryDue(rec)).toBe(false);
    expect((await step(rec, failed, 6_000, true)).retried).toEqual([]);
    rec.lastFaultAt = 7_000;
    expect(retryDue(rec)).toBe(true);
  });

  it("asks the swap driver's probe instead of the fault flag once one is registered", async () => {
    const rec = record();
    setOverlapProbe(now => now >= 100_000);
    try {
      expect((await step(rec, running, 90_000, true)).posted).toEqual([]);
      expect((await step(rec, running, 100_000, false)).posted.length).toBe(1);
    } finally {
      setOverlapProbe(null);
    }
  });
});

describe("staging-mix resource guard", () => {
  const sample = (availableMb: number): ResourceSample => ({ at: 0, descendants: 3, rssMb: 900, cpuPercent: 40, availableMb, load1m: 2, inFlight: 0 });

  it("launches each task at its arrival time, holds launches while memory is low, and stops at the wave's end", () => {
    const options = wave(["--workload", "staging-mix", "--faults", "K0", "--mix-runs", "5", "--mix-queue", "1", "--mix-minutes", "15", "--mix-turn-minutes", "5", "--mix-tasks", "8"]);
    const plan = planStagingMixWave("w-20261112T000000-s1", options);
    let available = 8_000;
    const notes: string[] = [];
    const run = new StagingMixRun(options.stagingMix!, 0, kind => notes.push(kind), "/nonexistent", 3_072, () => sample(available));
    run.record();
    const late = plan.tasks.at(-1)!;
    expect(run.mayLaunch(0, plan.tasks[0]!)).toBe(true);
    expect(run.mayLaunch(late.stagingMix!.arriveAtMs - 1, late)).toBe(false);
    expect(run.mayLaunch(late.stagingMix!.arriveAtMs, late)).toBe(true);
    available = 1_000;
    run.record();
    expect(run.mayLaunch(late.stagingMix!.arriveAtMs, late)).toBe(false);
    expect(notes).toContain("staging_mix_launch_held");
    available = 8_000;
    run.record();
    expect(run.mayLaunch(late.stagingMix!.arriveAtMs, late)).toBe(true);
    expect(run.endIfDue(15 * 60_000 - 1)).toBe(false);
    expect(run.endIfDue(15 * 60_000)).toBe(true);
    expect(run.mayLaunch(15 * 60_000, late)).toBe(false);
    expect(run.summary()).toMatchObject({ peakRssMb: 900, minAvailableMb: 1_000 });
  });

  it("sums only the harness's own process tree and reads macOS available memory", () => {
    const rows = parsePs(" 10 1 100 1.5\n 11 10 200 2.0\n 12 11 300 0.5\n 13 1 999 9.0\nbad line\n");
    expect(descendantsOf(rows, 10).map(row => row.pid)).toEqual([11, 12]);
    const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  1000.\nPages inactive:  2000.\nPages speculative:  100.\nPages purgeable:  4.\n";
    expect(parseVmStat(vm)).toBe(Math.round((3104 * 16384) / 1_048_576));
    expect(parseVmStat("nothing")).toBeNull();
    expect(parseMemInfo("MemTotal:       65536000 kB\nMemFree:          512000 kB\nMemAvailable:   40960000 kB\n")).toBe(40_000);
    expect(parseMemInfo("MemFree: 1 kB\n")).toBeNull();
  });
});
