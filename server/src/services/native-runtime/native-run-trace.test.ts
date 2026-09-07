import { describe, expect, it, vi } from "vitest";

import type { AdapterRuntimeEvent } from "../../adapters/index.js";
import { getActiveStepContext } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import type { StartupTraceContextHandle } from "../../instrumentation.js";
import {
  createNativeRunTrace,
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
