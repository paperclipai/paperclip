import { describe, expect, it, vi } from "vitest";

import type { AdapterRuntimeEvent } from "../../adapters/index.js";
import { getActiveStepContext } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import type { StartupTraceContextHandle } from "../../instrumentation.js";
import {
  buildNativeHeartbeatPreparationSpans,
  buildNativeWakeIngressSpan,
  createNativeRunTrace,
  nativeRunPreparationStarts,
  recordFailedSkillPreparation,
  recordNativeProviderPerformanceSpans,
  recordNativeRunnerStartupStep,
  resolveNativeTimeToFirstTokenStart,
  NATIVE_RUN_SPAN_EVENT_TYPE,
  NATIVE_RUN_TRACE_SCHEMA_VERSION,
} from "./native-run-trace.js";

type RecordedSpan = {
  name: string;
  parentName: string | null;
  attributes: Record<string, unknown>;
  endedAtMs: number | null;
};

function createRecordingTraceContext(): {
  traceContext: StartupTraceContextHandle;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const spanRecords = new WeakMap<object, RecordedSpan>();
  const traceContext: StartupTraceContextHandle = {
    tracer: {
      startSpan(name, options, context) {
        const parent = (context as { span?: RecordedSpan } | undefined)?.span;
        const record: RecordedSpan = {
          name,
          parentName: parent?.name ?? null,
          attributes:
            (options as { attributes?: Record<string, unknown> } | undefined)
              ?.attributes ?? {},
          endedAtMs: null,
        };
        spans.push(record);
        const span = {
          setAttribute(key: string, value: unknown) {
            record.attributes[key] = value;
          },
          setStatus() {},
          end(endTime?: unknown) {
            record.endedAtMs =
              typeof endTime === "number" ? endTime : Date.now();
          },
        };
        spanRecords.set(span, record);
        return span;
      },
    },
    contextWithSpan(span) {
      return {
        span:
          typeof span === "object" && span !== null
            ? spanRecords.get(span)
            : undefined,
      };
    },
  };
  return { traceContext, spans };
}

describe("native runner performance trace", () => {
  it("projects a full durable diagnostic batch without waiting on duplicate run-log writes", async () => {
    const {traceContext, spans}=createRecordingTraceContext();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release=resolve; });
    const write=vi.fn(async()=>barrier);
    const trace=createNativeRunTrace({runId:"provider-perf-blocked-log",startedAtMs:1000,traceContext,onEvent:write});
    const names=["provider.model.stream","provider.context.environment","provider.tools.resolve","provider.model.resolve",
      "provider.workspace.snapshot.track","provider.workspace.snapshot.patch","provider.workspace.snapshot.diff","provider.skills.discovery"];
    let completed=false;
    const work=recordNativeProviderPerformanceSpans(trace,Array.from({length:128},(_,index)=>({
      name:names[index%names.length],startedAtMs:1100+index,endedAtMs:1200+index,
    }))).then(()=>{completed=true;});
    try {
      await new Promise<void>(resolve=>setImmediate(resolve));
      expect(completed).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(spans.filter(span=>span.parentName==="provider.runtime")).toHaveLength(128);
    } finally {release();await work;await trace.finish("ok");}
  });
  it("groups normalized provider phases under their real native execution parent", async () => {
    const {traceContext, spans}=createRecordingTraceContext();
    const trace=createNativeRunTrace({runId:"provider-perf",startedAtMs:1000,traceContext});
    const execute=trace.start("native.session.execute",{startedAtMs:1000});
    await recordNativeProviderPerformanceSpans(trace,[
      {name:"provider.context.environment",startedAtMs:1100,endedAtMs:1200},
      {name:"provider.model.stream",startedAtMs:1200,endedAtMs:1700},
    ]);
    await trace.end(execute,{endedAtMs:1800});
    await trace.finish("ok");
    expect(spans.find(s=>s.name==="provider.runtime")).toMatchObject({parentName:"native.session.execute",endedAtMs:1700});
    expect(spans.filter(s=>s.name==="provider.model.stream"||s.name==="provider.context.environment").map(s=>s.parentName))
      .toEqual(["provider.runtime","provider.runtime"]);
  });
  it.each([7_200_000, 10_800_000])(
    "times the current answer after %i ms without charging prior questions or human wait",
    async (answeredAtMs) => {
      const original = {
        id: "original-comment",
        createdAt: new Date(1_000).toISOString(),
      };
      const ingress = buildNativeWakeIngressSpan({
        runCreatedAtMs: answeredAtMs + 10,
        wakeComments: [original],
        attestedQuestionResponseAtMs: answeredAtMs,
      });
      expect(ingress).toEqual({
        name: "question_response.to_run_created",
        parentName: "task.provider_session",
        startedAtMs: answeredAtMs,
        endedAtMs: answeredAtMs + 10,
      });
      const starts = nativeRunPreparationStarts(
        [
          ingress!,
          ...buildNativeHeartbeatPreparationSpans({
            runCreatedAtMs: answeredAtMs + 10,
            runStartedAtMs: answeredAtMs + 20,
            attemptStartedAtMs: answeredAtMs + 30,
            environmentAcquireStartedAtMs: answeredAtMs + 40,
            environmentRealizeEndedAtMs: answeredAtMs + 50,
            nativeDispatchAtMs: answeredAtMs + 60,
          }),
        ],
        answeredAtMs + 60,
      );
      expect(starts).toEqual({
        runStartedAtMs: answeredAtMs,
        preparationStartedAtMs: answeredAtMs + 30,
      });
      const events: AdapterRuntimeEvent[] = [];
      const trace = createNativeRunTrace({
        runId: "answer-run",
        startedAtMs: starts.runStartedAtMs,
        traceContext: createRecordingTraceContext().traceContext,
        onEvent: async (event) => {
          events.push(event);
        },
      });
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(answeredAtMs + 19_000);
      try {
        await trace.finish("ok");
      } finally {
        clock.mockRestore();
      }
      expect(
        events.find((event) => event.payload?.span === "task.provider_session.measured")
          ?.payload,
      ).toMatchObject({ durationMs: 19_000 });
      expect(original.createdAt).toBe(new Date(1_000).toISOString());
    },
  );

  it("preserves ordinary and retry comment ingress and ignores caller answer timestamps", () => {
    const wakeComments = [
      { createdAt: new Date(2_000).toISOString(), answeredAtMs: 50_000 },
      { createdAt: "invalid", answeredAtMs: 60_000 },
      {
        createdAt: new Date(1_000).toISOString(),
        externalChatQuestionResponse: { answeredAtMs: 70_000 },
      },
    ];
    expect(
      buildNativeWakeIngressSpan({
        runCreatedAtMs: 3_000,
        wakeComments,
        attestedQuestionResponseAtMs: null,
      }),
    ).toEqual({
      name: "comment.to_run_created",
      parentName: "task.provider_session",
      startedAtMs: 1_000,
      endedAtMs: 3_000,
    });
    expect(
      buildNativeWakeIngressSpan({
        runCreatedAtMs: 3_000,
        wakeComments: [{ answeredAtMs: 1 }],
        attestedQuestionResponseAtMs: null,
      }),
    ).toBeNull();
  });

  it.each([
    { label: "initial", attemptStartedAtMs: 2_000 },
    { label: "same-run resume after host sleep", attemptStartedAtMs: 985_000 },
  ])(
    "keeps $label preparation attempt-local while retaining run wall time",
    async ({ attemptStartedAtMs }) => {
      const events: AdapterRuntimeEvent[] = [];
      const { traceContext, spans: recordedSpans } =
        createRecordingTraceContext();
      const historicalSpans = [
        {
          name: "comment.to_run_created",
          startedAtMs: 900,
          endedAtMs: 1_000,
        },
        ...buildNativeHeartbeatPreparationSpans({
          runCreatedAtMs: 1_000,
          runStartedAtMs: 2_000,
          attemptStartedAtMs,
          environmentAcquireStartedAtMs: attemptStartedAtMs + 20,
          environmentRealizeEndedAtMs: attemptStartedAtMs + 30,
          nativeDispatchAtMs: attemptStartedAtMs + 40,
        }),
      ];
      const beforeEnvironment = historicalSpans.find(
        (span) => span.name === "heartbeat.prepare_before_environment",
      )!;
      expect(beforeEnvironment.endedAtMs - beforeEnvironment.startedAtMs).toBe(
        20,
      );
      expect(
        historicalSpans.find((span) => span.name === "heartbeat.queue"),
      ).toMatchObject({
        startedAtMs: 1_000,
        endedAtMs: 2_000,
      });
      const starts = nativeRunPreparationStarts(
        historicalSpans,
        attemptStartedAtMs + 40,
      );
      expect(starts).toEqual({
        runStartedAtMs: 900,
        preparationStartedAtMs: attemptStartedAtMs,
      });
      const trace = createNativeRunTrace({
        runId: "same-run",
        startedAtMs: starts.runStartedAtMs,
        traceContext,
        onEvent: async (event) => {
          events.push(event);
        },
      });
      const prepare = trace.start("task.prepare", {
        parentName: "task.provider_session",
        startedAtMs: starts.preparationStartedAtMs,
      });
      await trace.end(prepare, { endedAtMs: attemptStartedAtMs + 50 });
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(attemptStartedAtMs + 100);
      try {
        await trace.finish("ok");
      } finally {
        clock.mockRestore();
      }
      expect(
        events.find((event) => event.payload?.span === "task.prepare")?.payload,
      ).toMatchObject({
        durationMs: 50,
        startOffsetMs: attemptStartedAtMs - 900,
      });
      expect(recordedSpans[0]?.attributes["paperclip.task.run.wall_ms"]).toBe(
        attemptStartedAtMs + 100 - 900,
      );
    },
  );

  it("persists measured spans with bounded run-relative timing", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const trace = createNativeRunTrace({
      runId: "run-secret-id",
      startedAtMs: 1_000,
      onEvent: async (event) => {
        events.push(event);
      },
    });

    await trace.record({
      name: "runner.transport.selected",
      parentName: "runner.session.bootstrap",
      startedAtMs: 1_125,
      endedAtMs: 1_125,
      attributes: {
        mode: "direct_loopback",
        credential: "must-not-export",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: NATIVE_RUN_SPAN_EVENT_TYPE,
      stream: "system",
      payload: {
        schema: "paperclip.run-performance-span.v1",
        traceSchemaVersion: NATIVE_RUN_TRACE_SCHEMA_VERSION,
        span: "runner.transport.selected",
        parentSpan: "task.provider_session",
        startOffsetMs: 125,
        durationMs: 0,
        outcome: "ok",
        mode: "direct_loopback",
      },
    });
    expect(events[0]?.payload).not.toHaveProperty("credential");
  });

  it("records failed measurements without changing the original error", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const trace = createNativeRunTrace({
      runId: "run-1",
      onEvent: async (event) => {
        events.push(event);
      },
    });
    const failure = new Error("boom");

    await expect(
      trace.measure("runner.runtime.stage", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: NATIVE_RUN_SPAN_EVENT_TYPE,
      level: "warn",
      payload: {
        span: "runner.runtime.stage",
        outcome: "failed",
      },
    });
  });

  it("records skills.prepare beneath preparation with no attributes and tolerates a failed log sink", async () => {
    const { traceContext, spans } = createRecordingTraceContext();
    const trace = createNativeRunTrace({ runId: "skills-run", startedAtMs: 100,
      traceContext, onEvent: async () => { throw new Error("run log unavailable"); } });
    const preparation = trace.start("task.prepare", { parentName: "task.provider_session", startedAtMs: 100 });
    await expect(trace.record({ name: "skills.prepare", parentName: "task.prepare", startedAtMs: 120, endedAtMs: 170 })).resolves.toBeUndefined();
    await trace.end(preparation, { endedAtMs: 200 });
    expect(spans.find((span) => span.name === "skills.prepare")).toMatchObject({ name: "skills.prepare", parentName: "task.prepare", endedAtMs: 170 });
    await expect(trace.finish("ok")).resolves.toBeUndefined();
  });

  it("emits failed skill preparation without starting execution, even when the log sink fails", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const { traceContext, spans } = createRecordingTraceContext();
    await recordFailedSkillPreparation({ runId: "failed-skills", startedAtMs: Date.now() - 10,
      traceContext, onEvent: async (event) => { events.push(event); throw new Error("log unavailable"); } });
    expect(events.find((event) => event.payload?.span === "skills.prepare")?.payload).toMatchObject({
      span: "skills.prepare", parentSpan: "task.prepare", outcome: "failed",
    });
    expect(spans.find((span) => span.name === "skills.prepare")?.parentName).toBe("task.prepare");
    expect(spans.some((span) => span.name === "native.session.execute")).toBe(false);
  });

  it("never fails runner control flow when its event sink fails", async () => {
    const trace = createNativeRunTrace({
      runId: "run-1",
      onEvent: vi.fn(async () => {
        throw new Error("telemetry unavailable");
      }),
    });

    await expect(
      trace.measure("runner.turn.submit", async () => "ok"),
    ).resolves.toBe("ok");
    await expect(trace.finish("ok")).resolves.toBeUndefined();
  });

  it("creates a foldable canonical hierarchy with real parent contexts", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const { traceContext, spans } = createRecordingTraceContext();
    const trace = createNativeRunTrace({
      runId: "run-1",
      startedAtMs: 1_000,
      traceContext,
      onEvent: async (event) => {
        events.push(event);
      },
    });

    const prepare = trace.start("task.prepare", {
      parentName: "task.provider_session",
      startedAtMs: 1_010,
    });
    const environment = trace.start("environment.startup", {
      parentName: "task.prepare",
      startedAtMs: 1_020,
    });
    await trace.record({
      name: "environment.acquire",
      parentName: "environment.startup",
      startedAtMs: 1_025,
      endedAtMs: 1_030,
    });
    await trace.end(environment, { endedAtMs: 1_035 });
    await trace.end(prepare, { endedAtMs: 1_040 });

    const execute = trace.start("native.session.execute", {
      parentName: "task.provider_session",
      startedAtMs: 1_050,
    });
    const startup = trace.start("runner.session.startup", {
      parentName: "native.session.execute",
      startedAtMs: 1_055,
    });
    await trace.run(startup, async () => {
      await trace.measure("runner.artifact.prepare", () =>
        trace.measure("runner.artifact.discover", async () => undefined),
      );
      await trace.measure("runner.runtime.stage", () =>
        trace.measure("stage.sync", async () => {
          await trace.measure("stage.asset.home", () =>
            trace.measure("session.checkpoint.restore", async () => undefined),
          );
          await trace.measure(
            "stage.asset.runtime_context",
            async () => undefined,
          );
          await trace.measure("stage.asset.ca_bundle", async () => undefined);
        }),
      );
      await trace.end(startup, { endedAtMs: 1_080 });

      const agentTurn = trace.start("agent.turn", {
        parentName: "native.session.execute",
        startedAtMs: 1_085,
      });
      trace.activate(agentTurn);
      expect(
        (
          getActiveStepContext()?.parentContext as
            { span?: RecordedSpan } | undefined
        )?.span?.name,
      ).toBe("agent.turn");
      await trace.measure("provider.dynamic", async () => undefined);
      await trace.record({
        name: "runner.turn.submitted_to_started",
        parentName: "agent.turn",
        startedAtMs: 1_085,
        endedAtMs: 1_090,
      });
      await trace.end(agentTurn, { endedAtMs: 1_100 });
    });
    await trace.end(execute, { endedAtMs: 1_105 });
    await trace.finish("ok");

    const parentOf = (name: string) =>
      spans.find((span) => span.name === name)?.parentName;
    expect(parentOf("task.provider_session")).toBeNull();
    expect(parentOf("task.prepare")).toBe("task.provider_session");
    expect(parentOf("environment.startup")).toBe("task.prepare");
    expect(parentOf("environment.acquire")).toBe("environment.startup");
    expect(parentOf("native.session.execute")).toBe("task.provider_session");
    expect(parentOf("runner.session.startup")).toBe("native.session.execute");
    expect(parentOf("runner.artifact.prepare")).toBe("runner.session.startup");
    expect(parentOf("runner.artifact.discover")).toBe(
      "runner.artifact.prepare",
    );
    expect(parentOf("runner.runtime.stage")).toBe("runner.session.startup");
    expect(parentOf("stage.sync")).toBe("runner.runtime.stage");
    expect(parentOf("stage.asset.home")).toBe("stage.sync");
    expect(parentOf("session.checkpoint.restore")).toBe("stage.asset.home");
    expect(parentOf("stage.asset.runtime_context")).toBe("stage.sync");
    expect(parentOf("stage.asset.ca_bundle")).toBe("stage.sync");
    expect(parentOf("agent.turn")).toBe("native.session.execute");
    expect(parentOf("provider.dynamic")).toBe("agent.turn");
    expect(parentOf("runner.turn.submitted_to_started")).toBe("agent.turn");

    expect(spans.filter((span) => span.name === "task.provider_session")).toHaveLength(1);
    expect(spans.some((span) => span.name === "task.provider_session.measured")).toBe(false);
    expect(
      events.some((event) => event.payload?.span === "task.provider_session.measured"),
    ).toBe(true);
  });
});

it.each(["start", "context", "attribute", "status", "end"])("keeps execution and cleanup independent of a throwing %s tracer method", async broken => {
  const failure = new Error("original private execution failure");
  const spans: Array<{ end: ReturnType<typeof vi.fn> }> = [];
  const traceContext: StartupTraceContextHandle = {
    tracer: { startSpan() {
      if (broken === "start") throw new Error("tracer failed");
      const span = {
        setAttribute() { if (broken === "attribute") throw new Error("attribute failed"); },
        setStatus() { if (broken === "status") throw new Error("status failed"); },
        end: vi.fn(() => { if (broken === "end") throw new Error("end failed"); }),
      };
      spans.push(span);
      return span;
    } },
    contextWithSpan() { if (broken === "context") throw new Error("context failed"); return undefined; },
  };
  const native = createNativeRunTrace({ runId: "throwing-tracer", traceContext });
  const result = {}, work = vi.fn(async () => result), failedWork = vi.fn(async () => { throw failure; });
  await expect(native.measure("runner.turn.submit", work)).resolves.toBe(result);
  await expect(native.measure("agent.turn", failedWork)).rejects.toBe(failure);
  await expect(native.finish("failed")).resolves.toBeUndefined();
  expect(work).toHaveBeenCalledOnce();
  expect(failedWork).toHaveBeenCalledOnce();
  for (const span of spans) expect(span.end).toHaveBeenCalledOnce();
});

describe("time to first token anchor", () => {
  const prep = (name: string, startedAtMs: number) => ({
    name, parentName: "task.provider_session", startedAtMs, endedAtMs: startedAtMs + 5,
  });

  it("falls back to run creation when no earlier accepted input is known", () => {
    expect(resolveNativeTimeToFirstTokenStart({
      traceStartedAtMs: 1_000, preparationSpans: [prep("heartbeat.queue", 1_000)], wakeRequestedAtMs: null,
    })).toEqual({ startedAtMs: 1_000, anchor: "run_created" });
  });

  it("names the comment or answered question that already anchors the trace", () => {
    expect(resolveNativeTimeToFirstTokenStart({
      traceStartedAtMs: 900, preparationSpans: [prep("comment.to_run_created", 900)], wakeRequestedAtMs: 950,
    })).toEqual({ startedAtMs: 900, anchor: "comment" });
    expect(resolveNativeTimeToFirstTokenStart({
      traceStartedAtMs: 800, preparationSpans: [prep("question_response.to_run_created", 800)], wakeRequestedAtMs: null,
    })).toEqual({ startedAtMs: 800, anchor: "question_response" });
  });

  it("names run creation when a comment was coalesced into an already-queued run", () => {
    expect(resolveNativeTimeToFirstTokenStart({
      traceStartedAtMs: 1_000,
      preparationSpans: [prep("heartbeat.queue", 1_000), prep("comment.to_run_created", 1_400)],
      wakeRequestedAtMs: null,
    })).toEqual({ startedAtMs: 1_000, anchor: "run_created" });
  });

  it("moves back to an earlier accepted wake request (deferred or coalesced wakes)", () => {
    expect(resolveNativeTimeToFirstTokenStart({
      traceStartedAtMs: 5_000, preparationSpans: [prep("heartbeat.queue", 5_000)], wakeRequestedAtMs: 2_000,
    })).toEqual({ startedAtMs: 2_000, anchor: "wake_request" });
  });

  it("ignores invalid wake request times", () => {
    for (const wakeRequestedAtMs of [Number.NaN, -1, 6_000]) {
      expect(resolveNativeTimeToFirstTokenStart({
        traceStartedAtMs: 5_000, preparationSpans: [], wakeRequestedAtMs,
      })).toEqual({ startedAtMs: 5_000, anchor: "run_created" });
    }
  });

  it("persists the anchor on the run-log span", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const trace = createNativeRunTrace({
      runId: "ttft-run", startedAtMs: 5_000,
      traceContext: createRecordingTraceContext().traceContext,
      onEvent: async (event) => { events.push(event); },
    });
    const start = resolveNativeTimeToFirstTokenStart({
      traceStartedAtMs: trace.traceStartedAtMs, preparationSpans: [], wakeRequestedAtMs: 4_000,
    });
    await trace.record({
      name: "task.time_to_first_token", parentName: "task.provider_session",
      startedAtMs: start.startedAtMs, endedAtMs: 7_000, attributes: { eventKind: "agentMessage", anchor: start.anchor },
    });
    const span = events.find((event) => (event.payload as Record<string, unknown>)?.span === "task.time_to_first_token");
    expect(span?.payload).toMatchObject({ durationMs: 3_000, startOffsetMs: -1_000, anchor: "wake_request", eventKind: "agentMessage" });
  });
});

describe("deferred diagnostics", () => {
  it("never blocks the caller and settles before the trace finishes", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const trace = createNativeRunTrace({
      runId: "deferred-run", startedAtMs: 1_000,
      traceContext: createRecordingTraceContext().traceContext,
      onEvent: async (event) => { events.push(event); },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    trace.defer(async () => {
      await gate;
      await trace.record({ name: "task.time_to_first_token", parentName: "task.provider_session", startedAtMs: 1_000, endedAtMs: 2_000 });
    });
    // Later work keeps flowing while the deferred read is pending.
    await trace.record({ name: "response.first_nonempty_text", startedAtMs: 2_000, endedAtMs: 2_000 });
    const span = (name: string) => events.some((event) => (event.payload as Record<string, unknown>)?.span === name);
    expect(span("response.first_nonempty_text")).toBe(true);
    expect(span("task.time_to_first_token")).toBe(false);
    const finished = trace.finish("ok");
    release();
    await finished;
    const names = events.map((event) => (event.payload as Record<string, unknown>)?.span);
    expect(names.indexOf("task.time_to_first_token")).toBeGreaterThan(-1);
    expect(names.indexOf("task.time_to_first_token")).toBeLessThan(names.indexOf("task.provider_session.measured"));
  });

  it("records spans without waiting on deferred run-log rows, then writes them in order before finish", async () => {
    const { traceContext, spans } = createRecordingTraceContext();
    const written: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.fn(async (event: AdapterRuntimeEvent) => {
      await gate;
      written.push((event.payload as Record<string, unknown>)?.span);
    });
    const trace = createNativeRunTrace({ runId: "deferred-rows", startedAtMs: 1_000, traceContext, onEvent: write });
    trace.start("task.prepare", { parentName: "task.provider_session", startedAtMs: 1_000 });
    const names = ["heartbeat.queue", "heartbeat.prepare_before_environment", "heartbeat.prepare_after_environment"];
    for (const [index, name] of names.entries()) {
      await trace.record({ name, parentName: "task.prepare", startedAtMs: 1_000 + index, endedAtMs: 1_100 + index }, { deferRunLog: true });
    }
    // The spans exist under their parent while every row write is still blocked.
    expect(spans.filter((span) => span.parentName === "task.prepare").map((span) => span.name)).toEqual(names);
    expect(spans.filter((span) => names.includes(span.name)).every((span) => span.endedAtMs !== null)).toBe(true);
    expect(written).toEqual([]);
    expect(write.mock.calls.length).toBeLessThanOrEqual(1);
    const finished = trace.finish("ok");
    release();
    await finished;
    // Rows keep the order their spans ended in and land before the root span closes.
    expect(written.slice(0, 3)).toEqual(names);
    expect(written.indexOf("task.provider_session.measured")).toBeGreaterThan(2);
  });

  it("drops deferred run-log rows requested after the trace finished", async () => {
    const write = vi.fn(async () => {});
    const trace = createNativeRunTrace({ runId: "deferred-rows-late", traceContext: createRecordingTraceContext().traceContext, onEvent: write });
    await trace.finish("ok");
    write.mockClear();
    await trace.record({ name: "heartbeat.queue", startedAtMs: 1_000, endedAtMs: 1_100 }, { deferRunLog: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(write).not.toHaveBeenCalled();
  });

  it("ignores a failed deferred diagnostic and work deferred after finish", async () => {
    const trace = createNativeRunTrace({ runId: "deferred-fail", traceContext: createRecordingTraceContext().traceContext });
    trace.defer(async () => { throw new Error("diagnostic failed"); });
    await expect(trace.finish("ok")).resolves.toBeUndefined();
    const late = vi.fn(async () => {});
    trace.defer(late);
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });
});

describe("local runner startup sub-steps", () => {
  it("records each step beneath runner.session.startup without blocking the caller", async () => {
    const events: AdapterRuntimeEvent[] = [];
    let releaseSink!: () => void;
    const sinkGate = new Promise<void>((resolve) => { releaseSink = resolve; });
    const { traceContext, spans } = createRecordingTraceContext();
    const trace = createNativeRunTrace({
      runId: "startup-steps", startedAtMs: 1_000, traceContext,
      onEvent: async (event) => { await sinkGate; events.push(event); },
    });
    const startup = trace.start("runner.session.startup", { parentName: "task.provider_session", startedAtMs: 1_000 });
    // Synchronous and detached: a stalled run-log sink cannot delay turn.start.
    recordNativeRunnerStartupStep(trace, { name: "runner.runtime.stage", mode: "bootstrap", startedAtMs: 1_000, endedAtMs: 1_200, outcome: "ok" });
    recordNativeRunnerStartupStep(trace, { name: "runner.process.launch", mode: "bootstrap", startedAtMs: 1_200, endedAtMs: 1_900, outcome: "ok" });
    recordNativeRunnerStartupStep(trace, { name: "provider.session.load", mode: "resume", startedAtMs: 1_900, endedAtMs: 4_000, outcome: "failed" });
    expect(events).toHaveLength(0);
    const ended = trace.end(startup, { endedAtMs: 4_000 });
    const finished = trace.finish("ok");
    releaseSink();
    await ended;
    await finished;
    const payloads = events.map((event) => event.payload as Record<string, unknown>);
    const step = (name: string) => payloads.find((payload) => payload.span === name);
    expect(step("runner.runtime.stage")).toMatchObject({ parentSpan: "runner.session.startup", startOffsetMs: 0, durationMs: 200, outcome: "ok", mode: "bootstrap", target: "local" });
    expect(step("runner.process.launch")).toMatchObject({ parentSpan: "runner.session.startup", startOffsetMs: 200, durationMs: 700, outcome: "ok" });
    expect(step("provider.session.load")).toMatchObject({ parentSpan: "runner.session.startup", durationMs: 2_100, outcome: "failed", mode: "resume" });
    expect(events.find((event) => (event.payload as Record<string, unknown>).span === "provider.session.load")?.level).toBe("warn");
    expect(spans.find((span) => span.name === "runner.process.launch")?.parentName).toBe("runner.session.startup");
    // Settled before the root measurement closes.
    const names = payloads.map((payload) => payload.span);
    expect(names.indexOf("provider.session.load")).toBeLessThan(names.indexOf("task.provider_session.measured"));
  });

  it("is a no-op without a trace", () => {
    expect(() => recordNativeRunnerStartupStep(undefined, { name: "runner.process.launch", mode: "bootstrap", startedAtMs: 1, endedAtMs: 2, outcome: "ok" })).not.toThrow();
  });
});
