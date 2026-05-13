import { describe, it, expect, vi } from "vitest";
import { createRunsEventsRoute, type RunsEventsDeps } from "./runs-events.js";

function deps(overrides?: Partial<RunsEventsDeps>): RunsEventsDeps {
  return {
    runJwt: {
      verify: vi.fn(() => ({
        ok: true as const,
        claims: {
          runId: "r-1",
          agentId: "a-1",
          companyId: "c-1",
          jobUid: "j-1",
          iss: "paperclip" as const,
          aud: "paperclip-run" as const,
          exp: 9_999_999_999,
        },
      })),
      mint: vi.fn(),
    },
    appendRunEvent: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("POST /api/runs/:runId/events", () => {
  it("appends an event when JWT runId matches URL runId", async () => {
    const d = deps();
    const handler = createRunsEventsRoute(d);
    const res = await handler({
      params: { runId: "r-1" },
      headers: { authorization: "Bearer fake.jwt" },
      body: { type: "assistant", ts: "2026-05-09T00:00:00Z", text: "hello" },
    });
    expect(res.status).toBe(204);
    expect(d.appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: "r-1",
      type: "assistant",
    }));
  });

  it("stores only the declared event payload fields", async () => {
    const d = deps();
    const handler = createRunsEventsRoute(d);
    const res = await handler({
      params: { runId: "r-1" },
      headers: { authorization: "Bearer fake.jwt" },
      body: {
        type: "assistant",
        ts: "2026-05-09T00:00:00Z",
        text: "hello",
        payload: { message: "nested", data: { ok: true } },
        unexpected: "drop-me",
      },
    });
    expect(res.status).toBe(204);
    expect(d.appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        message: "nested",
        data: { ok: true },
        text: "hello",
      },
    }));
  });

  it("rejects 401 when Authorization header missing", async () => {
    const handler = createRunsEventsRoute(deps());
    const res = await handler({ params: { runId: "r-1" }, headers: {}, body: {} });
    expect(res.status).toBe(401);
  });

  it("rejects 403 when JWT runId differs from URL runId", async () => {
    const handler = createRunsEventsRoute(deps());
    const res = await handler({
      params: { runId: "r-2" },
      headers: { authorization: "Bearer fake.jwt" },
      body: { type: "assistant", text: "x" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects 400 when body is missing 'type'", async () => {
    const handler = createRunsEventsRoute(deps());
    const res = await handler({
      params: { runId: "r-1" },
      headers: { authorization: "Bearer fake.jwt" },
      body: { text: "x" },
    });
    expect(res.status).toBe(400);
  });
});
