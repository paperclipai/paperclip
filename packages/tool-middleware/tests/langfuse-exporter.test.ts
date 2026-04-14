import { describe, it, expect, vi, afterEach } from "vitest";
import {
  emitToolSpan,
  logToStderr,
  generateTraceId,
  generateSpanId,
  type ToolSpanData,
  type LangfuseExporterConfig,
} from "../src/langfuse-exporter.js";

const makeSpan = (): ToolSpanData => ({
  traceId: "trace-1",
  spanId: "span-1",
  toolName: "Bash",
  inputTokenCount: 10,
  outputTokenCount: 50,
  rawOutputBytes: 1200,
  prunedOutputBytes: 300,
  executionDurationMs: 150,
  exitCode: 0,
  originatingTicketId: "ticket-abc",
  teamId: "team-xyz",
  artifactRefs: ["artifact://abc123"],
  status: "success",
  sessionId: "session-1",
});

describe("emitToolSpan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-op when Langfuse is not configured (empty baseUrl)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config: LangfuseExporterConfig = { baseUrl: "", publicKey: "", secretKey: "" };
    emitToolSpan(makeSpan(), config);
    // fetch should not be called when not configured
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-op fallback activates when Langfuse is unreachable", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Mock fetch to simulate network failure
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const config: LangfuseExporterConfig = {
      baseUrl: "http://localhost:19999", // unreachable
      publicKey: "pk-test",
      secretKey: "sk-test",
    };
    emitToolSpan(makeSpan(), config);

    // Wait for the async fetch to fail
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should log the error to stderr
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[tool-middleware]"));
  });

  it("does not block on fetch (fire-and-forget)", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise((resolve) => setTimeout(resolve, 10000)) as Promise<Response>);
    const config: LangfuseExporterConfig = {
      baseUrl: "http://localhost:19999",
      publicKey: "pk",
      secretKey: "sk",
    };
    const start = Date.now();
    emitToolSpan(makeSpan(), config);
    const elapsed = Date.now() - start;
    // Should return immediately (< 50ms), not wait for the fetch
    expect(elapsed).toBeLessThan(50);
  });
});

describe("logToStderr", () => {
  it("writes to stderr without throwing", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => logToStderr(makeSpan())).not.toThrow();
    expect(spy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("includes tool name and status in output", () => {
    const messages: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });
    logToStderr(makeSpan());
    const combined = messages.join("");
    expect(combined).toContain("Bash");
    expect(combined).toContain("success");
    vi.restoreAllMocks();
  });
});

describe("generateTraceId / generateSpanId", () => {
  it("generates non-empty unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTraceId());
      ids.add(generateSpanId());
    }
    expect(ids.size).toBe(200);
  });
});
