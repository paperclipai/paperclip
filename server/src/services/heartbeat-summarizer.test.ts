import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_INPUT_CHARS,
  SUMMARY_MARKER,
  summarizeHeartbeatTrail,
  type SummarizerOptions,
} from "./heartbeat-summarizer.js";

const SAMPLE_INPUT = {
  priorSummary: null,
  newTrailTail: [
    "Board: please ship X by Friday.",
    "Agent: filed THE-123 to track.",
    "Open question: which environment do we deploy to?",
  ].join("\n"),
};

function makeFetchReturning(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

const baseOptions: SummarizerOptions = {
  apiKey: "test-key",
  fetchImpl: makeFetchReturning({}),
};

describe("summarizeHeartbeatTrail", () => {
  it("returns the stripped summary on the happy path", async () => {
    const fetchImpl = makeFetchReturning({
      content: [
        {
          type: "text",
          text: `${SUMMARY_MARKER}\n## Decisions\n- Ship X by Friday (board, 2026-05-08).\n## Commitments\n(none)\n## Unresolved questions\n- Which environment?\n## Open blockers\n(none)\n## Context\nFiled THE-123.`,
        },
      ],
      usage: { input_tokens: 1234, output_tokens: 200 },
    });

    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      ...baseOptions,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.startsWith(SUMMARY_MARKER)).toBe(false);
    expect(result.summary).toContain("Ship X by Friday");
    expect(result.summary).toContain("Which environment?");
    expect(result.truncated).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 1234, outputTokens: 200 });
    expect(result.model).toBeTruthy();
  });

  it("sends prior summary into the user prompt when provided", async () => {
    const fetchImpl = vi.fn(async (_url, init: RequestInit | undefined) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const userMessage = body?.messages?.[0]?.content ?? "";
      expect(userMessage).toContain("PRIOR-DECISION-MARKER");
      expect(userMessage).toContain("NEW-TRAIL-MARKER");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: `${SUMMARY_MARKER}\nok` }],
        }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const result = await summarizeHeartbeatTrail(
      {
        priorSummary: "PRIOR-DECISION-MARKER body",
        newTrailTail: "NEW-TRAIL-MARKER body",
      },
      { ...baseOptions, fetchImpl },
    );
    expect(result.ok).toBe(true);
  });

  it("returns timeout fallback when the call exceeds the deadline", async () => {
    // Slow fetch that respects abort via the supplied signal.
    const slowFetch = vi.fn((_url, init: RequestInit | undefined) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return;
        if (sig.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        sig.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as unknown as typeof fetch;

    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      apiKey: "test-key",
      fetchImpl: slowFetch,
      timeoutMs: 25,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("timeout");
    expect(result.detail).toMatch(/25ms/);
  });

  it("returns malformed fallback when output lacks the SUMMARY-V1 marker", async () => {
    const fetchImpl = makeFetchReturning({
      content: [{ type: "text", text: "Sure! Here's the summary you asked for: ..." }],
    });

    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      ...baseOptions,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
    expect(result.detail).toContain(SUMMARY_MARKER);
  });

  it("returns malformed fallback when the response body has no text block", async () => {
    const fetchImpl = makeFetchReturning({
      content: [{ type: "tool_use", id: "x" }],
    });

    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      ...baseOptions,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("returns malformed fallback when schema validation fails", async () => {
    const fetchImpl = makeFetchReturning({ unexpected: "shape" });
    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      ...baseOptions,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("returns api_error fallback on non-2xx response", async () => {
    const fetchImpl = makeFetchReturning("upstream rate limit", { ok: false, status: 429 });
    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      ...baseOptions,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("api_error");
    expect(result.detail).toContain("429");
  });

  it("returns api_error fallback when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENETDOWN");
    }) as unknown as typeof fetch;
    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      ...baseOptions,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("api_error");
    expect(result.detail).toContain("ENETDOWN");
  });

  it("returns oversize_input fallback when combined input exceeds the char cap", async () => {
    const big = "x".repeat(DEFAULT_MAX_INPUT_CHARS + 1);
    const fetchImpl = vi.fn();
    const result = await summarizeHeartbeatTrail(
      { priorSummary: null, newTrailTail: big },
      { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("oversize_input");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns missing_api_key fallback when api key is empty", async () => {
    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      apiKey: "",
      fetchImpl: makeFetchReturning({}),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_api_key");
  });

  it("does not throw when called repeatedly with failures (stable on the heartbeat path)", async () => {
    const fetchImpl = makeFetchReturning("server crashed", { ok: false, status: 500 });
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await summarizeHeartbeatTrail(SAMPLE_INPUT, { ...baseOptions, fetchImpl });
      expect(r.ok).toBe(false);
    }
  });

  it("defensively truncates pathologically long output bodies", async () => {
    const huge = "y".repeat(20_000);
    const fetchImpl = makeFetchReturning({
      content: [{ type: "text", text: `${SUMMARY_MARKER}\n${huge}` }],
    });
    const result = await summarizeHeartbeatTrail(SAMPLE_INPUT, { ...baseOptions, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.summary.length).toBeLessThan(huge.length);
  });

  it("forwards model + max_tokens overrides into the request body", async () => {
    let captured: any = null;
    const fetchImpl = vi.fn(async (_url, init: RequestInit | undefined) => {
      captured = init?.body ? JSON.parse(String(init.body)) : null;
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: `${SUMMARY_MARKER}\nok` }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    await summarizeHeartbeatTrail(SAMPLE_INPUT, {
      apiKey: "test-key",
      fetchImpl,
      model: "claude-haiku-4-6",
      maxOutputTokens: 1500,
    });

    expect(captured.model).toBe("claude-haiku-4-6");
    expect(captured.max_tokens).toBe(1500);
    expect(captured.system).toContain("PRESERVE VERBATIM");
  });

  it("respects caller-supplied AbortSignal even before fetch resolves", async () => {
    const controller = new AbortController();
    const slowFetch = vi.fn((_url, init: RequestInit | undefined) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as unknown as typeof fetch;
    const promise = summarizeHeartbeatTrail(SAMPLE_INPUT, {
      apiKey: "test-key",
      fetchImpl: slowFetch,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // External abort returns api_error (not timeout — the timeout did not fire).
    expect(result.reason).toBe("api_error");
  });
});
