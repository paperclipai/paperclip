import type {
  AppendedEventReceipt,
  CompleteControlPlaneRunInput,
  ControlPlanePort,
  OpenControlPlaneRunInput,
  ReplayControlPlaneEventsInput,
  ReplayedControlPlaneEvents,
} from "../contracts/control-plane-port.js";
import type { NativeRunEvent, NativeRunResult } from "../contracts/types.js";
import {
  validatePrpEvent,
  validatePrpStructuredRunResult,
  type PrpEvent,
} from "../protocol/replay-contract.js";

export interface MockControlPlaneSnapshot {
  lifecycle: "stopped" | "running";
  openedRun: OpenControlPlaneRunInput | null;
  events: Array<NativeRunEvent | PrpEvent>;
  result: NativeRunResult | CompleteControlPlaneRunInput | null;
}

/** In-memory control-plane shell used by standalone tests and tutorials. */
export class MockControlPlaneAdapter implements ControlPlanePort {
  #lifecycle: "stopped" | "running" = "stopped";
  #openedRun: OpenControlPlaneRunInput | null = null;
  #events: Array<NativeRunEvent | PrpEvent> = [];
  #result: NativeRunResult | CompleteControlPlaneRunInput | null = null;

  async start(): Promise<void> {
    if (this.#lifecycle === "running") {
      throw new Error("mock control plane is already running");
    }
    this.#lifecycle = "running";
  }

  async stop(): Promise<void> {
    this.#lifecycle = "stopped";
  }

  async openRun(input: OpenControlPlaneRunInput): Promise<void> {
    this.#assertRunning();
    if (this.#openedRun !== null) {
      throw new Error("mock control plane accepts one Conformance run");
    }
    this.#openedRun = structuredClone(input);
  }

  async appendEvent(event: NativeRunEvent | PrpEvent): Promise<AppendedEventReceipt> {
    const runId = this.#requireRunId();
    if (event.runId !== runId) {
      throw new Error("event runId does not match the opened run");
    }
    if ("sourceEventId" in event) {
      const validation = validatePrpEvent(event);
      if (!validation.ok) {
        throw new Error(`event failed validation: ${validation.issues[0]?.message ?? "invalid event"}`);
      }
      const sameId = this.#events.find(
        (candidate): candidate is PrpEvent =>
          "sourceEventId" in candidate && candidate.sourceEventId === event.sourceEventId,
      );
      const sameSequence = this.#events.find(
        (candidate): candidate is PrpEvent =>
          "sourceSeq" in candidate &&
          candidate.sourceInstanceId === event.sourceInstanceId &&
          candidate.sourceSeq === event.sourceSeq,
      );
      for (const candidate of [sameId, sameSequence]) {
        if (candidate !== undefined) {
          if (canonicalJson(candidate) !== canonicalJson(event)) {
            throw new Error("native_event_replay_conflict");
          }
          return {
            cursor: event.sourceSeq,
            highestContiguousSourceSeq: this.#highestContiguous(event.sourceInstanceId),
            disposition: "duplicate",
          };
        }
      }
      this.#events.push(structuredClone(event));
      return {
        cursor: event.sourceSeq,
        highestContiguousSourceSeq: this.#highestContiguous(event.sourceInstanceId),
        disposition: "committed",
      };
    }

    const expectedSequence = this.#events.length + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(`event sequence must be ${expectedSequence}`);
    }
    this.#events.push(structuredClone(event));
    return {
      cursor: event.sequence,
      highestContiguousSourceSeq: event.sequence,
      disposition: "committed",
    };
  }

  async replayEvents(
    input: ReplayControlPlaneEventsInput,
  ): Promise<ReplayedControlPlaneEvents> {
    const runId = this.#requireRunId();
    if (input.runId !== runId) {
      throw new Error("replay runId does not match the opened run");
    }
    const events = this.#events
      .filter(
        (event): event is PrpEvent =>
          "sourceSeq" in event &&
          event.sourceInstanceId === input.sourceInstanceId &&
          event.sourceSeq > input.afterSourceSeq,
      )
      .sort((left, right) => left.sourceSeq - right.sourceSeq)
      .slice(0, input.limit)
      .map((event) => structuredClone(event));
    return {
      events,
      highestContiguousSourceSeq: this.#highestContiguous(input.sourceInstanceId),
    };
  }

  async completeRun(result: NativeRunResult | CompleteControlPlaneRunInput): Promise<void> {
    const runId = this.#requireRunId();
    const resultRunId = "runId" in result ? result.runId : runId;
    if (resultRunId !== runId) {
      throw new Error("result runId does not match the opened run");
    }
    if ("terminal" in result) {
      const validation = validatePrpStructuredRunResult(result.result);
      if (!validation.ok) {
        throw new Error("native_result_invalid");
      }
      const terminalEvent = this.#events.find(
        (event) => "eventType" in event && event.eventType === "run.terminal",
      );
      if (terminalEvent === undefined) {
        throw new Error("run.terminal must be ingested before the result");
      }
    } else if (this.#events.at(-1)?.type !== "run.completed") {
      throw new Error("run.completed must be ingested before the result");
    }
    if (this.#result !== null) {
      if (canonicalJson(this.#result) === canonicalJson(result)) return;
      throw new Error("native_result_replay_conflict");
    }
    this.#result = structuredClone(result);
  }

  snapshot(): MockControlPlaneSnapshot {
    return {
      lifecycle: this.#lifecycle,
      openedRun: this.#openedRun === null ? null : structuredClone(this.#openedRun),
      events: structuredClone(this.#events),
      result: this.#result === null ? null : structuredClone(this.#result),
    };
  }

  #assertRunning(): void {
    if (this.#lifecycle !== "running") {
      throw new Error("mock control plane must be started first");
    }
  }

  #requireRunId(): string {
    this.#assertRunning();
    if (this.#openedRun === null) {
      throw new Error("a run must be opened first");
    }
    return this.#openedRun.identity.runId;
  }

  #highestContiguous(sourceInstanceId: string): number {
    const sequences = new Set(
      this.#events
        .filter(
          (event): event is PrpEvent =>
            "sourceSeq" in event && event.sourceInstanceId === sourceInstanceId,
        )
        .map((event) => event.sourceSeq),
    );
    let cursor = 0;
    while (sequences.has(cursor + 1)) cursor += 1;
    return cursor;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export * from "./capability-control-plane-types.js";
export * from "./capability-mock-control-plane-adapter.js";
