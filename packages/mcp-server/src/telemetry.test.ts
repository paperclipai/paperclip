import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";
import { createStderrTelemetrySink, type ToolCallTelemetryEvent } from "./telemetry.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: null,
  });
}

function toolsWithSink(events: ToolCallTelemetryEvent[]) {
  return createToolDefinitions(makeClient(), { sink: (event) => events.push(event) });
}

function getTool(name: string, events: ToolCallTelemetryEvent[]) {
  const tool = toolsWithSink(events).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("per-tool telemetry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits an ok event with actor/company/tool/duration for a successful call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJsonResponse([{ id: "issue-1" }])));
    const events: ToolCallTelemetryEvent[] = [];

    await getTool("paperclipListIssues", events).execute({});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "paperclipListIssues",
      actor: "22222222-2222-2222-2222-222222222222",
      company: "11111111-1111-1111-1111-111111111111",
      status: "ok",
    });
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]?.errorName).toBeUndefined();
  });

  it("emits an error event with the error name when the tool fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJsonResponse({ error: "boom" }, 500)));
    const events: ToolCallTelemetryEvent[] = [];

    await getTool("paperclipGetIssue", events).execute({ issueId: "PAP-1" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "paperclipGetIssue", status: "error" });
    expect(events[0]?.errorName).toBe("PaperclipApiError");
  });

  it("emits an error event for a schema validation failure", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const events: ToolCallTelemetryEvent[] = [];

    // issueId is required; omitting it trips schema validation before any fetch.
    await getTool("paperclipGetIssue", events).execute({});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "paperclipGetIssue", status: "error" });
    expect(events[0]?.errorName).toBe("ZodError");
  });

  it("stderr sink writes one timestamped JSON line per event", () => {
    const lines: string[] = [];
    const sink = createStderrTelemetrySink((line) => lines.push(line));

    sink({
      tool: "paperclipMe",
      actor: "a1",
      company: "c1",
      status: "ok",
      durationMs: 12,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[paperclip-mcp\]\[telemetry\] /);
    const payload = JSON.parse(lines[0]!.replace("[paperclip-mcp][telemetry] ", ""));
    expect(payload).toMatchObject({ tool: "paperclipMe", actor: "a1", company: "c1", status: "ok", durationMs: 12 });
    expect(typeof payload.at).toBe("string");
    expect(Number.isNaN(Date.parse(payload.at))).toBe(false);
  });
});
