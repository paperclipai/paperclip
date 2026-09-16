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
        parentName: "task.run",
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
        events.find((event) => event.payload?.span === "task.run.measured")
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
      parentName: "task.run",
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
        parentName: "task.run",
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
        parentSpan: "task.run",
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
    const preparation = trace.start("task.prepare", { parentName: "task.run", startedAtMs: 100 });
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
      parentName: "task.run",
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
      parentName: "task.run",
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
        name: "provider.turn.queue",
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
    expect(parentOf("task.run")).toBeNull();
    expect(parentOf("task.prepare")).toBe("task.run");
    expect(parentOf("environment.startup")).toBe("task.prepare");
    expect(parentOf("environment.acquire")).toBe("environment.startup");
    expect(parentOf("native.session.execute")).toBe("task.run");
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
    expect(parentOf("provider.turn.queue")).toBe("agent.turn");

    expect(spans.filter((span) => span.name === "task.run")).toHaveLength(1);
    expect(spans.some((span) => span.name === "task.run.measured")).toBe(false);
    expect(
      events.some((event) => event.payload?.span === "task.run.measured"),
    ).toBe(true);
  });
});
