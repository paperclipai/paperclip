import { expect, it, vi } from "vitest";
import type { AgentCommentaryDetail } from "../../packages/shared/src/validators/agent-commentary.js";
import type { RunnerApi } from "./api.js";
import { collectAttemptFeedback, emptyFeedbackSummary, feedbackReview, observeFeedbackInvocations, summarizeCampaignFeedback, FEEDBACK_COLLECTION_LIMITS, type FeedbackEvidence } from "./feedback.js";
import { runCleanupWithObservers } from "./cleanup-verification.js";
import { isHistoricalBundlePathAllowed } from "./history-publish.js";
import { canonicalProviderEventsFromOpenCodePart } from "../../packages/paperclip-runner/src/provider-events.js";

function entry(id: string, body = "Please preserve the original tool error."): AgentCommentaryDetail {
  return { id, kind: "complaint", preview: body.slice(0, 280), body,
    createdAt: "2026-10-20T00:00:00.000Z", agent: { id: "agent", name: "Fixture", icon: null }, runId: "run", task: null };
}
const api = (read: (path: string) => unknown | Promise<unknown>) => ({ get: async <T>(path: string) => await read(path) as T }) as Pick<RunnerApi, "get">;
const event = (seq: number, eventType: string, payload: unknown, runId = "run") => ({ seq, eventType,
  payload: { prpEvent: { runId, sourceKind: "runner", eventType, payload } } });

it("collects full paginated company feedback, including feedback outside the selected task, and checkpoints it", async () => {
  const entries = Array.from({ length: 101 }, (_, i) => ({ ...entry(String(i), "a".repeat(300)), runId: `child-${i}` }));
  const checkpoints: FeedbackEvidence[] = [];
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { checkpoints.push(structuredClone(value)); },
    api: api(path => {
      if (path.includes("agent-commentary?")) {
        const offset = Number(new URL(path, "http://fixture").searchParams.get("offset"));
        return { items: entries.slice(offset, offset + 100).map(({ body: _body, ...rest }) => rest), total: 101 };
      }
      if (path.includes("agent-commentary/")) return entries[Number(path.split("/").at(-1))];
      return [];
    }),
  });
  expect(summary).toMatchObject({ collection: "complete", complaints: 101, bodiesCollected: 101, toolAvailability: "unknown" });
  expect(summary.review).toEqual([{ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), occurrences: 101, kind: "complaint", disposition: "needs_investigation" }]);
  expect(checkpoints.at(-1)!.entries[100]!.body).toHaveLength(300);
  expect(checkpoints.some(value => value.entries.length === 10)).toBe(true);
  expect(JSON.stringify(summary)).not.toContain("aaa");
});

it("keeps saved-feedback absence separate from unavailable reads and unknown tool availability", async () => {
  const empty = await collectAttemptFeedback({ companyId: "company", persist: async () => {},
    api: api(path => path.includes("agent-commentary") ? { items: [], total: 0 } : []),
  });
  expect(empty).toMatchObject({ collection: "complete", complaints: 0, suggestions: 0, toolAvailability: "unknown" });
  const unavailable = await collectAttemptFeedback({ companyId: "company", persist: async () => {}, api: api(() => { throw new Error("unavailable"); }) });
  expect(unavailable).toMatchObject({ collection: "unavailable", invocationCollection: "unavailable", complaints: 0 });
});

it("retains partial bodies and failed submissions without inventing persistence from a completed tool", async () => {
  let retained: FeedbackEvidence | undefined;
  const events = [
    event(1, "tool.execution.started", { name: "submit_suggestion", executionId: "failed" }),
    event(2, "tool.execution.completed", { name: "submit_suggestion", executionId: "failed", status: "failed" }),
    event(3, "tool.execution.started", { name: "submit_complaint", executionId: "done" }),
    event(4, "tool.execution.completed", { name: "submit_complaint", executionId: "done", status: "completed" }),
    event(5, "tool.execution.started", { name: "submit_suggestion", executionId: "interrupted" }),
  ];
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { retained = structuredClone(value); },
    api: api(path => {
      if (path.includes("agent-commentary?")) return { items: [entry("1"), entry("2")], total: 2 };
      if (path.endsWith("agent-commentary/1")) return entry("1");
      if (path.endsWith("agent-commentary/2")) throw new Error("body unavailable");
      if (path.includes("/events?")) return events;
      if (path === "/api/heartbeat-runs/run") return { id: "run", runtimeMode: "native", status: "failed" };
      return [{ id: "run", status: "failed" }];
    }),
  });
  expect(summary).toMatchObject({ collection: "partial", complaints: 2, bodiesCollected: 1, invocationCollection: "complete",
    invocations: { completed: 1, failed: 1, unknown: 1 } });
  expect(retained!.diagnostics).toContain("feedback_detail_failed");
});

it("binds native invocations to their run, ignores prose, and recognizes compatibility receipts", () => {
  const events = [
    event(1, "item.started", { kind: "tool_call", item: { type: "tool_call", id: "call", name: "paperclip.submit_complaint" } }),
    event(2, "item.completed", { kind: "tool_result", item: { type: "tool_result", id: "call", status: "completed", isError: true } }),
    event(3, "tool.execution.started", { name: "submit_suggestion", executionId: "foreign" }, "foreign-run"),
    event(4, "item.completed", { item: { type: "agentMessage", text: "I used submit_complaint" } }),
  ];
  expect(observeFeedbackInvocations("run", events)).toEqual([{ runId: "run", callId: "call", kind: "complaint", outcome: "failed" }]);
});

it.each(["paperclip_", "paperclip__", "mcp__paperclip__"])("maps namespaced feedback receipts through native events: %s", prefix => {
  const events = [
    event(1, "tool.execution.started", { executionId: "failed", name: `${prefix}submit_complaint` }),
    event(2, "tool.execution.completed", { executionId: "failed", name: `${prefix}submit_complaint`, status: "failed" }),
    event(3, "item.started", { kind: "tool_call", item: { id: "done", name: `${prefix}submit_suggestion` } }),
    event(4, "item.completed", { kind: "tool_result", item: { id: "done", status: "completed" } }),
    event(5, "tool.execution.started", { executionId: "interrupted", name: `${prefix}submit_suggestion` }),
    event(6, "tool.execution.started", { executionId: "unrelated", name: "other_submit_complaint" }),
  ];
  expect(observeFeedbackInvocations("run", events)).toEqual([
    { runId: "run", callId: "failed", kind: "complaint", outcome: "failed" },
    { runId: "run", callId: "done", kind: "suggestion", outcome: "completed" },
    { runId: "run", callId: "interrupted", kind: "suggestion", outcome: "unknown" },
  ]);
});

it.each([{ runtimeMode: "legacy", status: "succeeded" }, { runtimeMode: "native", status: "running" }])("does not claim complete invocation coverage for legacy helpers or still-active work: %o", async run => {
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async () => {}, api: api(path => {
    if (path.includes("agent-commentary")) return { items: [], total: 0 };
    if (path.includes("/events?")) return [];
    if (path === "/api/heartbeat-runs/run") return { id: "run", ...run };
    return [{ id: "run", status: run.status }];
  }) });
  expect(summary.invocationCollection).toBe("partial");
});

function workspaceDeferral(): Record<string, unknown> {
  return {
    id: "run", companyId: "company", agentId: "agent", issueId: "child", status: "cancelled", runtimeMode: "legacy",
    errorCode: "workspace_busy", startedAt: "2026-10-28T03:35:01.660Z", finishedAt: "2026-10-28T03:35:02.268Z",
    runtimeModeResolvedAt: null, processStartedAt: null, processPid: null, processStartTicks: null,
    runnerInstanceId: null, nativeSessionId: null, sessionIdAfter: null, lastOutputSeq: 0, costUsd: null,
    usageJson: { ledgerScope: { issueId: "child" } },
    runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
    resultJson: {
      executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
      cancellation: { source: "control_plane", expected: true, initiator: { type: "system" } },
      workspaceBusy: { holderRunId: "parent-run", holderIssueId: "parent", deferralAttempt: 0 },
    },
  };
}

async function collectWorkspaceDeferral(run: Record<string, unknown>, events: Record<string, unknown>[] = []) {
  let retained: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { retained = structuredClone(value); }, api: api(path => {
    if (path.includes("agent-commentary")) return { items: [], total: 0 };
    if (path.includes("/events?")) return events;
    if (path === "/api/heartbeat-runs/run") return run;
    return [{ id: "run", status: run.status }];
  }) });
  return { summary, retained: retained! };
}

it("records complete no-provider coverage for a proven workspace deferral without claiming native execution", async () => {
  const { summary, retained } = await collectWorkspaceDeferral(workspaceDeferral(), [
    { seq: 1, eventType: "lifecycle", stream: "system", payload: { retryScheduled: true } },
  ]);
  expect(summary).toMatchObject({ collection: "complete", invocationCollection: "complete", runsInspected: 1,
    invocations: { completed: 0, failed: 0, unknown: 0 }, toolAvailability: "unknown" });
  expect(retained.runCoverage).toEqual([{ runId: "run", classification: "provider_not_started" }]);
});

it.each([
  ["pending successor", { status: "scheduled_retry", startedAt: null, finishedAt: null }],
  ["actual legacy work", { status: "succeeded", errorCode: null, resultJson: {} }],
  ["provider work", { resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: true } } }],
  ["native process", { runnerInstanceId: "runner" }],
  ["native selection", { runtimeMode: "native", runtimeModeResolvedAt: "2026-10-28T03:35:01.700Z" }],
  ["local process", { processPid: 123 }],
  ["usage", { usageJson: { inputTokens: 1 } }],
  ["charge", { costUsd: "0.01" }],
] as const)("keeps invocation coverage partial for %s despite a workspace marker", async (_label, overrides) => {
  const { summary, retained } = await collectWorkspaceDeferral({ ...workspaceDeferral(), ...overrides });
  expect(summary.invocationCollection).toBe("partial");
  expect(retained.runCoverage).toEqual([{ runId: "run", classification: "incomplete" }]);
});

it.each([
  event(1, "tool.execution.started", { name: "submit_complaint", executionId: "call" }),
  event(1, "turn.started", {}),
  { seq: 1, eventType: "adapter.invoke", stream: "system", payload: {} },
  { seq: 1, eventType: "stdout", stream: "stdout", payload: {} },
  { seq: 1, eventType: "lifecycle", stream: "system", sourceEventId: "native-event", payload: {} },
  { seq: 1, eventType: "lifecycle", stream: "system", runId: "foreign-run", payload: {} },
  { seq: 1, eventType: "unknown", stream: "system", payload: {} },
])("rejects contradictory or unknown events when classifying a workspace deferral: %o", async contradictory => {
  const { summary, retained } = await collectWorkspaceDeferral(workspaceDeferral(), [contradictory]);
  expect(summary.invocationCollection).toBe("partial");
  expect(retained.runCoverage).toEqual([{ runId: "run", classification: "incomplete" }]);
});

it("requires an exhaustive event scan before recording no-provider coverage", async () => {
  let retained: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { retained = structuredClone(value); }, api: api(path => {
    if (path.includes("agent-commentary")) return { items: [], total: 0 };
    if (path.includes("/events?")) throw new Error("unavailable");
    if (path === "/api/heartbeat-runs/run") return workspaceDeferral();
    return [{ id: "run", status: "cancelled" }];
  }) });
  expect(summary).toMatchObject({ invocationCollection: "partial", runsInspected: 0 });
  expect(retained!.runCoverage).toEqual([{ runId: "run", classification: "incomplete" }]);
  expect(retained!.diagnostics).toContain("events_read_failed");
});

it("examines all event pages before accepting no-provider coverage", async () => {
  let pages = 0, retained: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { retained = structuredClone(value); }, api: api(path => {
    if (path.includes("agent-commentary")) return { items: [], total: 0 };
    if (path.includes("/events?")) {
      pages++;
      return pages === 1 ? Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, eventType: "lifecycle", stream: "system" }))
        : [event(101, "tool.execution.started", { name: "submit_suggestion", executionId: "call" })];
    }
    if (path === "/api/heartbeat-runs/run") return workspaceDeferral();
    return [{ id: "run", status: "cancelled" }];
  }) });
  expect(pages).toBe(2);
  expect(summary).toMatchObject({ invocationCollection: "partial", invocations: { unknown: 1 } });
  expect(retained!.runCoverage).toEqual([{ runId: "run", classification: "incomplete" }]);
});

it("does not complete feedback while a workspace deferral's replacement remains scheduled", async () => {
  let retained: FeedbackEvidence | undefined;
  const runs = [
    { id: "parent-opening", status: "succeeded", runtimeMode: "native" },
    { id: "parent-resumed", status: "succeeded", runtimeMode: "native" },
    workspaceDeferral(),
    { id: "replacement", status: "scheduled_retry", runtimeMode: "legacy", retryOfRunId: "run", startedAt: null },
  ];
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { retained = structuredClone(value); }, api: api(path => {
    if (path.includes("agent-commentary")) return { items: [], total: 0 };
    if (path.includes("/events?")) return [];
    if (path.startsWith("/api/heartbeat-runs/")) return runs.find(run => run.id === path.split("/").at(-1));
    return runs;
  }) });
  expect(summary).toMatchObject({ collection: "partial", invocationCollection: "partial", runsInspected: 4 });
  expect(retained!.runCoverage).toEqual([
    { runId: "parent-opening", classification: "native_events" },
    { runId: "parent-resumed", classification: "native_events" },
    { runId: "run", classification: "provider_not_started" },
    { runId: "replacement", classification: "incomplete" },
  ]);
});

it("captures feedback after cancellation failure but before destructive teardown, and still tears down if persistence fails", async () => {
  const calls: string[] = [];
  const result = await runCleanupWithObservers({
    retireRuns: async () => { throw new Error("cancel failed"); }, assertions: [],
    teardown: async () => {
      try {
        await collectAttemptFeedback({ companyId: "company", api: api(() => []), persist: async () => { calls.push("capture"); throw new Error("disk full"); } });
      } finally { calls.push("teardown"); }
    },
  });
  expect(calls).toEqual(["capture", "teardown"]);
  expect(result.errors).toHaveLength(2);
});

it("bounds collection by a deadline and retains content-free diagnostics", async () => {
  let requests = 0, last: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company", deadlineAt: 0,
    persist: async value => { last = structuredClone(value); }, api: api(() => { requests++; throw new Error("secret response"); }),
  });
  expect(requests).toBe(0);
  expect(summary.collection).toBe("unavailable");
  expect(last).toBeUndefined();
});

it("preserves the read prefix when slow detail requests exhaust the read budget mid-page", async () => {
  let now = 0, detailReads = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const checkpoints: FeedbackEvidence[] = [];
  const slowApi = { get: async (url: string, options: { timeout: number }) => {
    if (url.includes("agent-commentary?")) return { items: Array.from({ length: 100 }, (_, index) => entry(String(index))), total: 100 };
    if (!url.includes("agent-commentary/")) throw new Error("No read should start after the reserved cutoff");
    detailReads++;
    now += Math.min(400, options.timeout);
    if (options.timeout < 400) throw new Error("request timeout");
    return entry(url.split("/").at(-1)!);
  } } as Pick<RunnerApi, "get">;
  try {
    const summary = await collectAttemptFeedback({ companyId: "company", deadlineAt: 30_000, api: slowApi,
      persist: async evidence => { checkpoints.push(structuredClone(evidence)); now += 20; },
    });
    expect(summary).toMatchObject({ collection: "partial", invocationCollection: "unavailable" });
    expect(summary.bodiesCollected).toBeGreaterThan(10);
    expect(summary.bodiesCollected).toBeLessThan(100);
    expect(checkpoints[1].entries).toHaveLength(10);
    expect(checkpoints.at(-1)!.entries).toHaveLength(summary.bodiesCollected);
    expect(checkpoints.at(-1)!.entries.every(value => value.body === entry("fixture").body)).toBe(true);
    expect(checkpoints.at(-1)!.diagnostics).toContain("deadline_reached");
    expect(detailReads).toBe(summary.bodiesCollected + 1);
    expect(now).toBeLessThan(30_000);
  } finally { clock.mockRestore(); }
});

it("groups identical feedback for one review without conflating kinds", () => {
  expect(feedbackReview([entry("1", " slow  request "), entry("2", "slow request"), { ...entry("3", "slow request"), kind: "suggestion" }]))
    .toMatchObject([{ kind: "complaint", occurrences: 2 }, { kind: "suggestion", occurrences: 1 }]);
});

it("groups feedback across retries without omitting incomplete collection and keeps bodies out of public history", () => {
  const feedback = { ...emptyFeedbackSummary(), complaints: 1, review: feedbackReview([entry("1")]) };
  const aggregate = summarizeCampaignFeedback([{ feedback }, { feedback }, {}]);
  expect(aggregate).toMatchObject({ complaints: 2, incomplete: 3, review: [{ occurrences: 2 }] });
  expect(feedback.review[0]!.occurrences).toBe(1);
  expect(JSON.stringify(aggregate)).not.toContain(entry("1").body);
  expect(isHistoricalBundlePathAllowed("evidence/case/attempt-1/snapshots/agent-feedback.json")).toBe(false);
});

it("uses run details for native coverage when the real list projection omits runtimeMode", async () => {
  const reads: string[] = [];
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async () => {}, api: api(path => {
    reads.push(path);
    if (path.includes("agent-commentary")) return { items: [], total: 0 };
    if (path.includes("/events?")) return [];
    if (path === "/api/heartbeat-runs/run") return { id: "run", status: "succeeded", runtimeMode: "native" };
    return [{ id: "run", status: "succeeded" }];
  }) });
  expect(reads).toContain("/api/heartbeat-runs/run");
  expect(summary).toMatchObject({ collection: "complete", invocationCollection: "complete", runsInspected: 1 });
});
it("retains partial evidence if the run-detail lookup fails", async () => {
  let retained: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { retained = structuredClone(value); }, api: api(path => {
    if (path.includes("agent-commentary")) return { items: [], total: 0 };
    if (path.includes("/events?")) return [event(1, "tool.execution.started", { name: "submit_complaint", executionId: "call" })];
    if (path === "/api/heartbeat-runs/run") throw new Error("unavailable");
    return [{ id: "run", status: "succeeded" }];
  }) });
  expect(summary).toMatchObject({ collection: "partial", invocationCollection: "partial", invocations: { unknown: 1 }, runsInspected: 1 });
  expect(retained!.diagnostics).toContain("run_detail_failed");
});

it("retains OpenCode feedback whose first observed update is running or terminal", () => {
  const updates = [
    { id: "running", status: "running", tool: "paperclip_submit_suggestion" },
    { id: "failed", status: "error", tool: "paperclip_submit_complaint" },
    { id: "completed", status: "completed", tool: "paperclip_submit_suggestion" },
  ].flatMap(update => canonicalProviderEventsFromOpenCodePart({
    id: update.id, messageID: "message", type: "tool", callID: update.id, tool: update.tool,
    state: { status: update.status, input: {}, output: "fixture result", error: "fixture failure", time: { start: 1, end: 2 } },
  }));
  expect(updates.map(update => update.eventType)).toEqual(["tool.execution.progressed", "tool.execution.completed", "tool.execution.completed"]);
  expect(observeFeedbackInvocations("run", updates.map((update, index) => event(index, update.eventType, update.payload)))).toEqual([
    { runId: "run", callId: "running", kind: "suggestion", outcome: "unknown" },
    { runId: "run", callId: "failed", kind: "complaint", outcome: "failed" },
    { runId: "run", callId: "completed", kind: "suggestion", outcome: "completed" },
  ]);
});

it("bounds retained bytes and checkpoint writes for maximum-size feedback bodies", async () => {
  const body = "x".repeat(524_288);
  let detailReads = 0, writtenBytes = 0, writes = 0, retained: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company",
    persist: async evidence => { writes++; writtenBytes += Buffer.byteLength(JSON.stringify(evidence, null, 2)); retained = structuredClone(evidence); },
    api: api(url => {
      if (url.includes("agent-commentary?")) return { items: Array.from({ length: 100 }, (_, index) => entry(String(index), "preview")), total: 10_000 };
      if (url.includes("agent-commentary/")) { detailReads++; return entry(url.split("/").at(-1)!, body); }
      return [];
    }),
  });
  expect(detailReads).toBeLessThanOrEqual(16);
  expect(writes).toBeLessThanOrEqual(4);
  expect(writtenBytes).toBeLessThan(3 * FEEDBACK_COLLECTION_LIMITS.retainedBytes);
  expect(Buffer.byteLength(JSON.stringify(retained!.entries))).toBeLessThanOrEqual(FEEDBACK_COLLECTION_LIMITS.retainedBytes);
  expect(summary.collection).toBe("partial");
  expect(retained!.diagnostics).toContain("evidence_limit_reached");
  expect(retained!.entries.every(item => item.body === body)).toBe(true);
});

it("caps entry count and stops requesting further feedback pages", async () => {
  let pages = 0, retained: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async evidence => { retained = structuredClone(evidence); },
    api: api(url => {
      if (url.includes("agent-commentary?")) {
        const offset = Number(new URL(url, "http://fixture").searchParams.get("offset")); pages++;
        return { items: Array.from({ length: 100 }, (_, index) => entry(String(offset + index))), total: 2000 };
      }
      if (url.includes("agent-commentary/")) return entry(url.split("/").at(-1)!);
      return [];
    }),
  });
  expect(pages).toBe(10);
  expect(summary.bodiesCollected).toBe(FEEDBACK_COLLECTION_LIMITS.entries);
  expect(summary.collection).toBe("partial");
  expect(retained!.diagnostics).toContain("evidence_limit_reached");
});

it("aborts stalled evidence persistence at the collection deadline", async () => {
  let signal: AbortSignal | undefined, reads = 0;
  await expect(collectAttemptFeedback({ companyId: "company", deadlineAt: Date.now() + 50,
    persist: async (_evidence, currentSignal) => { signal = currentSignal; await new Promise<void>(() => {}); },
    api: api(() => { reads++; return []; }),
  })).rejects.toThrow("Feedback persistence deadline reached");
  expect(signal?.aborted).toBe(true);
  expect(reads).toBe(0);
});

it("acknowledges only successfully persisted feedback when a later checkpoint fails", async () => {
  let retained: FeedbackEvidence | undefined, acknowledged = emptyFeedbackSummary();
  const entries = Array.from({ length: 11 }, (_, index) => entry(String(index)));
  await expect(collectAttemptFeedback({ companyId: "company",
    onCheckpoint: summary => { acknowledged = summary; },
    persist: async evidence => {
      if (evidence.entries.length > 10) throw new Error("disk full");
      retained = structuredClone(evidence);
    },
    api: api(url => url.includes("agent-commentary?") ? { items: entries, total: entries.length }
      : entries[Number(url.split("/").at(-1))]),
  })).rejects.toThrow("disk full");
  expect(retained!.entries).toHaveLength(10);
  expect(acknowledged).toEqual(retained!.summary);
  expect(acknowledged.bodiesCollected).toBe(10);
  expect(acknowledged.review).toMatchObject([{ occurrences: 10 }]);
});

it("returns saved review counts when the deadline expires before a later checkpoint", async () => {
  let now = 0, retained: FeedbackEvidence | undefined;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const entries = Array.from({ length: 11 }, (_, index) => entry(String(index)));
  try {
    const summary = await collectAttemptFeedback({ companyId: "company", deadlineAt: 30_000,
      persist: async evidence => { retained = structuredClone(evidence); },
      api: api(url => {
        if (url.includes("agent-commentary?")) return { items: entries, total: entries.length };
        const index = Number(url.split("/").at(-1));
        if (index === 10) now = 30_001;
        return entries[index];
      }),
    });
    expect(retained!.entries).toHaveLength(10);
    expect(summary).toMatchObject({ bodiesCollected: 10, collection: "partial", invocationCollection: "unavailable" });
    expect(summary.review).toEqual(retained!.summary.review);
  } finally { clock.mockRestore(); }
});

it("bounds raw event inspection while retaining the observed feedback receipt prefix", async () => {
  let pages = 0, retained: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async evidence => { retained = structuredClone(evidence); },
    api: api(url => {
      if (url.includes("agent-commentary?")) return { items: [], total: 0 };
      if (url.includes("/events?")) {
        pages++;
        return Array.from({ length: 100 }, (_, index) => event(index + 1, "tool.execution.started", {
          executionId: `call-${index}`, name: "submit_complaint", input: "x".repeat(200_000),
        }));
      }
      if (url === "/api/heartbeat-runs/run") return { id: "run", status: "succeeded", runtimeMode: "native" };
      return [{ id: "run", status: "succeeded" }];
    }),
  });
  expect(pages).toBe(1);
  expect(summary.invocationCollection).toBe("partial");
  expect(summary.invocations.unknown).toBeGreaterThan(0);
  expect(summary.invocations.unknown).toBeLessThan(100);
  expect(retained!.diagnostics).toContain("evidence_limit_reached");
});


it("allows a slow event read to finish within the shared collection deadline", async () => {
  let now = 0, eventReads = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let retained: FeedbackEvidence | undefined;
  const slowApi = { get: async (url: string, options: { timeout: number }) => {
    if (url.includes("agent-commentary?")) return { items: [], total: 0 };
    if (url === "/api/companies/company/heartbeat-runs?limit=1000") return [{ id: "run", status: "succeeded" }];
    if (url === "/api/heartbeat-runs/run") return { id: "run", status: "succeeded", runtimeMode: "native" };
    if (url.includes("/events?")) {
      eventReads++;
      now += Math.min(8_000, options.timeout);
      if (options.timeout < 8_000) throw new Error("request timeout");
      return [event(1, "tool.execution.completed", { executionId: "call", name: "submit_suggestion", status: "completed" })];
    }
    throw new Error("Unexpected read");
  } } as Pick<RunnerApi, "get">;
  try {
    const summary = await collectAttemptFeedback({ companyId: "company", deadlineAt: 30_000, api: slowApi,
      persist: async evidence => { retained = structuredClone(evidence); },
    });
    expect(summary).toMatchObject({ collection: "complete", invocationCollection: "complete", runsInspected: 1,
      invocations: { completed: 1, failed: 0, unknown: 0 } });
    expect(retained!.runCoverage).toEqual([{ runId: "run", classification: "native_events" }]);
    expect(retained!.diagnostics).toEqual([]);
    expect(eventReads).toBe(1);
    expect(now).toBe(8_000);
  } finally { clock.mockRestore(); }
});

it("still times out a stalled event read and reserves time to persist saved feedback", async () => {
  let now = 0, eventReads = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let retained: FeedbackEvidence | undefined;
  const stalledApi = { get: async (url: string, options: { timeout: number }) => {
    if (url.includes("agent-commentary?")) return { items: [entry("saved")], total: 1 };
    if (url.includes("agent-commentary/")) return entry("saved");
    if (url === "/api/companies/company/heartbeat-runs?limit=1000") return [{ id: "run", status: "succeeded" }];
    if (url === "/api/heartbeat-runs/run") return { id: "run", status: "succeeded", runtimeMode: "native" };
    if (url.includes("/events?")) {
      eventReads++;
      now += options.timeout;
      throw new Error("request timeout: secret details");
    }
    throw new Error("Unexpected read");
  } } as Pick<RunnerApi, "get">;
  try {
    const summary = await collectAttemptFeedback({ companyId: "company", deadlineAt: 30_000, api: stalledApi,
      persist: async evidence => { retained = structuredClone(evidence); },
    });
    expect(now).toBe(25_000);
    expect(summary).toMatchObject({ collection: "complete", invocationCollection: "partial", bodiesCollected: 1, runsInspected: 0 });
    expect(retained!.entries).toEqual([entry("saved")]);
    expect(retained!.diagnostics).toEqual(["events_read_failed"]);
    expect(JSON.stringify(retained)).not.toContain("secret details");
    expect(eventReads).toBe(1);
  } finally { clock.mockRestore(); }
});


it("keeps time for event coverage after an earlier feedback endpoint stalls", async () => {
  let now = 0, eventReads = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let retained: FeedbackEvidence | undefined;
  const stalledListApi = { get: async (url: string, options: { timeout: number }) => {
    if (url.includes("agent-commentary?")) {
      now += options.timeout;
      throw new Error("request timeout");
    }
    if (url === "/api/companies/company/heartbeat-runs?limit=1000") return [{ id: "run", status: "succeeded" }];
    if (url === "/api/heartbeat-runs/run") return { id: "run", status: "succeeded", runtimeMode: "native" };
    if (url.includes("/events?")) {
      eventReads++;
      now += Math.min(8_000, options.timeout);
      if (options.timeout < 8_000) throw new Error("request timeout");
      return [];
    }
    throw new Error("Unexpected read");
  } } as Pick<RunnerApi, "get">;
  try {
    const summary = await collectAttemptFeedback({ companyId: "company", deadlineAt: 30_000, api: stalledListApi,
      persist: async evidence => { retained = structuredClone(evidence); },
    });
    expect(summary).toMatchObject({ collection: "unavailable", invocationCollection: "complete", runsInspected: 1 });
    expect(retained!.diagnostics).toEqual(["feedback_read_failed"]);
    expect(eventReads).toBe(1);
    expect(now).toBe(13_000);
  } finally { clock.mockRestore(); }
});
