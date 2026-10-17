import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatRun } from "../commands/heartbeat-run.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const API_BASE = "http://localhost:3100";

const AGENT = {
  id: AGENT_ID,
  name: "Builder",
  companyId: COMPANY_ID,
  adapterType: "claude_local",
};

interface RouteOptions {
  run?: Record<string, unknown>;
  runStatus?: number;
}

/**
 * Routes by URL rather than by call order: the poll loop issues several
 * requests per iteration, so a sequential mock would silently answer the wrong
 * one if the order ever changed.
 */
function createFetchMock(opts: RouteOptions = {}) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === `${API_BASE}/api/agents/${AGENT_ID}`) {
      return new Response(JSON.stringify(AGENT), { status: 200 });
    }
    if (url === `${API_BASE}/api/agents/${AGENT_ID}/wakeup`) {
      return new Response(
        JSON.stringify({ id: RUN_ID, companyId: COMPANY_ID, agentId: AGENT_ID, status: "running" }),
        { status: 200 },
      );
    }
    if (url.startsWith(`${API_BASE}/api/heartbeat-runs/${RUN_ID}/events`)) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.startsWith(`${API_BASE}/api/heartbeat-runs/${RUN_ID}/log`)) {
      return new Response(JSON.stringify({ content: "" }), { status: 200 });
    }
    if (url === `${API_BASE}/api/heartbeat-runs/${RUN_ID}`) {
      const status = opts.runStatus ?? 200;
      if (status === 404) {
        return new Response(JSON.stringify({ error: "Heartbeat run not found" }), { status: 404 });
      }
      return new Response(
        JSON.stringify(opts.run ?? { id: RUN_ID, companyId: COMPANY_ID, status: "succeeded" }),
        { status: 200 },
      );
    }
    // Anything else — including the company run list — is an unexpected call.
    // Answer it so the command can proceed, and let the assertions name it.
    return new Response(JSON.stringify([]), { status: 200 });
  });
}

async function invoke(): Promise<void> {
  await heartbeatRun({
    agentId: AGENT_ID,
    apiBase: API_BASE,
    apiKey: "board-token",
    source: "on_demand",
    trigger: "manual",
    timeoutMs: "5000",
  });
}

describe("heartbeat-run polling", () => {
  let fetchMock: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    process.exitCode = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  function urls(): string[] {
    return fetchMock.mock.calls.map((call) => String(call[0]));
  }

  it("reads the followed run by id and never scans the company run list", async () => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await invoke();

    const requested = urls();
    // Positive control: the run really was read, so the negative assertion
    // below cannot pass by the loop having made no requests at all.
    expect(requested).toContain(`${API_BASE}/api/heartbeat-runs/${RUN_ID}`);
    // The regression this guards: `GET /companies/:companyId/heartbeat-runs`
    // applies no LIMIT when none is sent, so polling it serves the agent's
    // whole run history on every iteration.
    expect(requested.filter((url) => url.includes("/heartbeat-runs?"))).toEqual([]);
    expect(requested.filter((url) => url.includes(`/companies/${COMPANY_ID}/heartbeat-runs`))).toEqual([]);
  });

  it("reports a vanished run instead of failing the command on a 404", async () => {
    fetchMock = createFetchMock({ runStatus: 404 });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await invoke();

    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Heartbeat run disappeared");
  });

  it("prints the failure excerpts the by-id projection carries", async () => {
    // The list projection hard-codes `stdoutExcerpt`/`stderrExcerpt` to NULL
    // and reduces `resultJson` to summary fields only, so none of this output
    // was reachable while the loop read the run off a list row.
    fetchMock = createFetchMock({
      run: {
        id: RUN_ID,
        companyId: COMPANY_ID,
        status: "failed",
        error: "adapter exited 1",
        stderrExcerpt: "boom: adapter crashed",
        resultJson: { subtype: "error_during_execution", is_error: true },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await invoke();

    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("boom: adapter crashed");
    expect(printed).toContain("error_during_execution");
    expect(printed).toContain("is_error: true");
    expect(process.exitCode).toBe(1);
  });
});
