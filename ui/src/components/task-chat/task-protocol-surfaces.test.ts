import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TASK_PROTOCOL_EVENT_SURFACE_REGISTRY,
  TASK_PROTOCOL_REQUEST_SURFACE_REGISTRY,
  TASK_PROTOCOL_RESULT_DISPOSITION_REGISTRY,
  TASK_PROTOCOL_RUN_TERMINAL_REGISTRY,
  TASK_PROTOCOL_TURN_TERMINAL_REGISTRY,
} from "./task-protocol-surfaces";

function schema(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`../../../../packages/paperclip-runner/protocol/schemas/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function enumStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

describe("Paperclip task protocol surface registry", () => {
  it("classifies every canonical event exactly once", () => {
    const eventSchema = schema("event.schema.json");
    const properties = record(eventSchema.properties);
    const eventType = record(properties.eventType);
    const canonical = enumStrings(eventType.enum).sort();
    const registered = Object.keys(TASK_PROTOCOL_EVENT_SURFACE_REGISTRY).sort();
    expect(registered).toEqual(canonical);
  });

  it("gives every inline event a Storybook verification surface", () => {
    for (const [eventType, registration] of Object.entries(TASK_PROTOCOL_EVENT_SURFACE_REGISTRY)) {
      if (registration.disposition !== "inline") continue;
      expect(registration.story, eventType).toMatch(/^Task Page\/Runner Protocol\//);
    }
  });

  it("classifies both runtime request types and all issue-thread request kinds", () => {
    const requestSchema = schema("request.schema.json");
    const alternatives = Array.isArray(requestSchema.oneOf) ? requestSchema.oneOf.map(record) : [];
    const runtimeProperties = alternatives
      .filter((candidate) => record(record(candidate.properties).requestKind).const === "runtime")
      .map((candidate) => record(candidate.properties));
    const issueProperties = record(alternatives.find((candidate) => record(record(candidate.properties).requestKind).const === "issue_thread")?.properties);
    const expected = [...new Set([
      ...runtimeProperties.flatMap((properties) => {
        const type = record(properties.type);
        const kinds = typeof type.const === "string" ? [type.const] : enumStrings(type.enum);
        return kinds.map((kind) => `runtime.${kind}`);
      }),
      ...enumStrings(record(issueProperties.kind).enum).map((kind) => `issue_thread.${kind}`),
    ])].sort();
    expect(Object.keys(TASK_PROTOCOL_REQUEST_SURFACE_REGISTRY).sort()).toEqual(expected);
  });

  it("covers result dispositions and both terminal state axes", () => {
    const resultSchema = schema("result.schema.json");
    const terminalSchema = schema("terminal.schema.json");
    const resultProperties = record(resultSchema.properties);
    const terminalProperties = record(terminalSchema.properties);
    expect(Object.keys(TASK_PROTOCOL_RESULT_DISPOSITION_REGISTRY).sort()).toEqual(
      enumStrings(record(resultProperties.reportedWorkDisposition).enum).sort(),
    );
    expect(Object.keys(TASK_PROTOCOL_TURN_TERMINAL_REGISTRY).sort()).toEqual(
      enumStrings(record(terminalProperties.turnTerminalState).enum).sort(),
    );
    expect(Object.keys(TASK_PROTOCOL_RUN_TERMINAL_REGISTRY).sort()).toEqual(
      enumStrings(record(terminalProperties.runTerminalState).enum).sort(),
    );
  });
});
