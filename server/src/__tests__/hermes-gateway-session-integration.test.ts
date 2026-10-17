import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AdapterExecutionContext,
  AdapterSessionCodec,
} from "@paperclipai/adapter-utils";
import {
  execute,
  sessionCodec as gatewaySessionCodec,
} from "@paperclipai/hermes-paperclip-adapter/gateway/server";

import { resolveNextSessionState } from "../services/heartbeat.js";

// Integration scope (E2 phase, variant B): the REAL hermes_gateway adapter
// execute() looped through the REAL server-side session-state transition
// (resolveNextSessionState + the gateway sessionCodec) across consecutive
// runs. The Hermes API is an in-process fake on 127.0.0.1 (ephemeral port)
// that implements only the contract confirmed by the earlier E2 phases:
// POST /v1/runs acceptance is NOT tip confirmation, and the terminal
// run/event payload carries the Hermes-confirmed session id. Per the E2
// lineage contract, Hermes resolves a canonical (possibly rotated) session
// id to the current tip; the fake models that by filing every run created
// with the canonical id under the current tip's lineage history.
//
// Strategy under test (agreed): canonical-always. Every run sends the
// canonical id from config; the confirmed tip is tracked separately in
// sessionParams and must follow Hermes-reported rotations.

const CANONICAL_PARENT = "20261012_888888_e2par";
const TIP_CHILD = "20261012_888889_e2kid";
const TIP_GRANDCHILD = "20261012_888890_e2gk";
const AGENT_ID = "agent-1";
const COMPANY_ID = "company-1";
const ISSUE_ID = "ISSUE-1";
const PAPERCLIP_SESSION_KEY = `paperclip:company:${COMPANY_ID}:agent:${AGENT_ID}:issue:${ISSUE_ID}`;

type FakeHermesState = {
  /** Hermes-reported current tip of the canonical conversation. */
  tip: string;
  /** Run bodies received by POST /v1/runs, in order. */
  runBodies: Array<Record<string, unknown>>;
  /** Inputs filed under each actual session id (Hermes lineage resolution). */
  lineageHistory: Map<string, string[]>;
  /** Status the fake returns for the next POST /v1/runs, then resets to 202. */
  nextCreateStatus: number;
};

type FakeHermes = {
  url: string;
  state: FakeHermesState;
  close(): Promise<void>;
};

async function startFakeHermesApi(initialTip: string): Promise<FakeHermes> {
  const state: FakeHermesState = {
    tip: initialTip,
    runBodies: [],
    lineageHistory: new Map(),
    nextCreateStatus: 202,
  };
  let nextRunNumber = 0;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/v1/runs") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        state.runBodies.push(body);
        // Hermes-side lineage resolution: a run addressed to the canonical id
        // (even a rotated parent) continues the CURRENT tip's history.
        const target = typeof body.session_id === "string" ? body.session_id : "(none)";
        const history = state.lineageHistory.get(state.tip) ?? [];
        history.push(`${target}:${String(body.input ?? "")}`);
        state.lineageHistory.set(state.tip, history);
        const status = state.nextCreateStatus;
        state.nextCreateStatus = 202;
        res.writeHead(status, { "content-type": "application/json" });
        if (status < 400) {
          nextRunNumber += 1;
          res.end(JSON.stringify({ run_id: `run-${nextRunNumber}`, status: "started" }));
        } else {
          res.end(JSON.stringify({ error: "bad key" }));
        }
      });
      return;
    }
    if (req.method === "GET" && /\/v1\/runs\/[^/]+\/events$/.test(url)) {
      // Terminal event payload carries the Hermes-confirmed tip session id.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: run.completed\ndata: ${JSON.stringify({
          status: "completed",
          output: "done",
          session_id: state.tip,
        })}\n\n`,
      );
      res.end();
      return;
    }
    if (req.method === "GET" && /\/v1\/runs\/[^/]+$/.test(url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "completed", output: "done", session_id: state.tip }));
      return;
    }
    if (req.method === "POST" && /\/v1\/runs\/[^/]+\/stop$/.test(url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "stopping" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function makeGatewayCtx(
  config: Record<string, unknown>,
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
  },
): AdapterExecutionContext {
  return {
    runId: `pc-run-${Math.random().toString(36).slice(2, 8)}`,
    agent: {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: { ...runtime, taskKey: ISSUE_ID },
    config,
    context: {
      issueId: ISSUE_ID,
      wakeReason: "manual",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: async () => undefined,
    onMeta: async () => undefined,
  };
}

function baseConfig(hermesUrl: string): Record<string, unknown> {
  return {
    apiBaseUrl: hermesUrl,
    apiKey: "test-api-key",
    timeoutSec: 5,
  };
}

let fake: FakeHermes;

beforeAll(async () => {
  fake = await startFakeHermesApi(TIP_CHILD);
});

afterAll(async () => {
  await fake?.close();
});

describe("hermes_gateway session integration (adapter execute → resolveNextSessionState → next run)", () => {
  it("continues the canonical conversation across runs and tracks the Hermes-confirmed tip through rotation", async () => {
    const config = { ...baseConfig(fake.url), existingHermesSessionId: CANONICAL_PARENT };

    // ── Run 1: fresh Paperclip session state, canonical points at a rotated parent.
    const ctx1 = makeGatewayCtx(config, { sessionId: null, sessionParams: null, sessionDisplayId: null });
    const result1 = await execute(ctx1);
    expect(result1.exitCode).toBe(0);
    // canonical-always: the run body carries the canonical id, never the tip.
    expect(fake.state.runBodies[0]?.session_id).toBe(CANONICAL_PARENT);
    expect(result1.sessionParams).toEqual({
      hermesRunId: "run-1",
      hermesSessionId: TIP_CHILD,
      hermesCanonicalSessionId: CANONICAL_PARENT,
      strategy: "issue",
    });

    const state1 = resolveNextSessionState({
      adapterType: "hermes_gateway",
      codec: gatewaySessionCodec,
      adapterResult: result1,
      outcome: "succeeded",
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    });
    expect(state1.params).toEqual({
      hermesRunId: "run-1",
      hermesSessionId: TIP_CHILD,
      hermesCanonicalSessionId: CANONICAL_PARENT,
      strategy: "issue",
    });
    expect(state1.displayId).toBe(TIP_CHILD);

    // Codec round-trip must be lossless for the persisted shape.
    expect(gatewaySessionCodec.serialize(gatewaySessionCodec.deserialize(state1.params))).toEqual(state1.params);

    // ── Mid-flight Hermes rotation: the tip moves to a grandchild.
    fake.state.tip = TIP_GRANDCHILD;

    // ── Run 2: server hands the persisted params back to the adapter.
    const ctx2 = makeGatewayCtx(config, {
      sessionId: state1.legacySessionId,
      sessionParams: gatewaySessionCodec.deserialize(state1.params),
      sessionDisplayId: state1.displayId,
    });
    const result2 = await execute(ctx2);
    expect(result2.exitCode).toBe(0);
    // Still canonical-always after rotation: the stored tip is NOT substituted.
    expect(fake.state.runBodies[1]?.session_id).toBe(CANONICAL_PARENT);
    expect(result2.sessionParams).toEqual({
      hermesRunId: "run-2",
      hermesSessionId: TIP_GRANDCHILD,
      hermesCanonicalSessionId: CANONICAL_PARENT,
      strategy: "issue",
    });

    const state2 = resolveNextSessionState({
      adapterType: "hermes_gateway",
      codec: gatewaySessionCodec,
      adapterResult: result2,
      outcome: "succeeded",
      previousParams: state1.params,
      previousDisplayId: state1.displayId,
      previousLegacySessionId: state1.legacySessionId,
    });
    // The confirmed tip follows the newest Hermes-confirmed session id.
    expect(state2.params?.hermesSessionId).toBe(TIP_GRANDCHILD);
    expect(state2.params?.hermesCanonicalSessionId).toBe(CANONICAL_PARENT);

    // ── Integration contract: every run continued the SAME actual lineage.
    // The fake filed run inputs under the tip that was current at run time:
    // run 1 under the child, run 2 under the grandchild — one lineage,
    // addressed through the unchanged canonical id.
    const childHistory = fake.state.lineageHistory.get(TIP_CHILD) ?? [];
    const grandchildHistory = fake.state.lineageHistory.get(TIP_GRANDCHILD) ?? [];
    expect(childHistory).toHaveLength(1);
    expect(grandchildHistory).toHaveLength(1);
    expect(childHistory[0]).toContain(CANONICAL_PARENT);
    expect(grandchildHistory[0]).toContain(CANONICAL_PARENT);
    expect(fake.state.runBodies).toHaveLength(2);
    for (const body of fake.state.runBodies) {
      expect(body.session_id).toBe(CANONICAL_PARENT);
    }
  });

  it("keeps default isolated Paperclip addressing when existingHermesSessionId is empty", async () => {
    const config = baseConfig(fake.url);

    const ctx1 = makeGatewayCtx(config, { sessionId: null, sessionParams: null, sessionDisplayId: null });
    const result1 = await execute(ctx1);
    expect(result1.exitCode).toBe(0);
    expect(fake.state.runBodies.at(-1)?.session_id).toBe(PAPERCLIP_SESSION_KEY);

    const state1 = resolveNextSessionState({
      adapterType: "hermes_gateway",
      codec: gatewaySessionCodec,
      adapterResult: result1,
      outcome: "succeeded",
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    });
    // Standard mode: no canonical key, tip recorded from the confirmed payload.
    expect(state1.params).toEqual({
      hermesRunId: expect.any(String),
      hermesSessionId: TIP_GRANDCHILD,
      strategy: "issue",
    });
    expect(state1.params?.hermesCanonicalSessionId).toBeUndefined();

    // A second run on the same task key resumes the same Paperclip session.
    const ctx2 = makeGatewayCtx(config, {
      sessionId: state1.legacySessionId,
      sessionParams: gatewaySessionCodec.deserialize(state1.params),
      sessionDisplayId: state1.displayId,
    });
    const result2 = await execute(ctx2);
    expect(result2.exitCode).toBe(0);
    expect(fake.state.runBodies.at(-1)?.session_id).toBe(PAPERCLIP_SESSION_KEY);
  });

  it("rejects a Paperclip session key as existingHermesSessionId before any network request", async () => {
    const config = {
      ...baseConfig(fake.url),
      existingHermesSessionId: PAPERCLIP_SESSION_KEY,
    };
    const bodiesBefore = fake.state.runBodies.length;

    const result = await execute(
      makeGatewayCtx(config, { sessionId: null, sessionParams: null, sessionDisplayId: null }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_existing_session_invalid");
    expect(fake.state.runBodies).toHaveLength(bodiesBefore);
  });

  it("preserves the previously confirmed session params when the Hermes API fails", async () => {
    const config = { ...baseConfig(fake.url), existingHermesSessionId: CANONICAL_PARENT };
    const persistedParams = {
      hermesRunId: "run-1",
      hermesSessionId: TIP_GRANDCHILD,
      hermesCanonicalSessionId: CANONICAL_PARENT,
      strategy: "issue",
    };

    // HTTP 401 on run creation: the adapter returns an error result with no
    // session params, and the server-side transition must keep the previous
    // state instead of wiping the confirmed tip.
    fake.state.nextCreateStatus = 401;
    const result = await execute(
      makeGatewayCtx(config, {
        sessionId: TIP_GRANDCHILD,
        sessionParams: persistedParams,
        sessionDisplayId: TIP_GRANDCHILD,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.sessionParams).toBeUndefined();
    expect(result.sessionId).toBeUndefined();

    const state = resolveNextSessionState({
      adapterType: "hermes_gateway",
      codec: gatewaySessionCodec,
      adapterResult: result,
      outcome: "failed",
      previousParams: persistedParams,
      previousDisplayId: TIP_GRANDCHILD,
      previousLegacySessionId: TIP_GRANDCHILD,
    });
    expect(state.params).toEqual(persistedParams);
    expect(state.displayId).toBe(TIP_GRANDCHILD);
  });

  it("does not promote an unconfirmed id to the tip on timeout, preserving the prior tip", async () => {
    // A fake whose event stream never terminates and whose run status stays
    // non-terminal: the adapter hits its timeout with nothing confirmed.
    const hangServer = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ run_id: "run-hang", status: "started" }));
        });
        return;
      }
      if (url.endsWith("/events")) {
        // Keep the SSE stream open without a terminal event.
        res.writeHead(200, { "content-type": "text/event-stream" });
        return; // never ends; adapter aborts on timeout
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "running" }));
        return;
      }
      if (url.endsWith("/stop")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "stopping" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => hangServer.listen(0, "127.0.0.1", resolve));
    const hangUrl = `http://127.0.0.1:${(hangServer.address() as AddressInfo).port}`;

    try {
      const config = { ...baseConfig(hangUrl), existingHermesSessionId: CANONICAL_PARENT, timeoutSec: 0.3 };
      const persistedParams = {
        hermesRunId: "run-1",
        hermesSessionId: TIP_GRANDCHILD,
        hermesCanonicalSessionId: CANONICAL_PARENT,
        strategy: "issue",
      };
      const result = await execute(
        makeGatewayCtx(config, {
          sessionId: TIP_GRANDCHILD,
          sessionParams: persistedParams,
          sessionDisplayId: TIP_GRANDCHILD,
        }),
      );
      expect(result.timedOut).toBe(true);
      // Timeout is not a confirmation: the prior confirmed tip is preserved.
      expect(result.sessionParams).toEqual({
        hermesRunId: "run-hang",
        hermesSessionId: TIP_GRANDCHILD,
        hermesCanonicalSessionId: CANONICAL_PARENT,
        strategy: "issue",
      });

      const state = resolveNextSessionState({
        adapterType: "hermes_gateway",
        codec: gatewaySessionCodec,
        adapterResult: result,
        outcome: "timed_out",
        previousParams: persistedParams,
        previousDisplayId: TIP_GRANDCHILD,
        previousLegacySessionId: TIP_GRANDCHILD,
      });
      expect(state.params).toEqual({
        hermesRunId: "run-hang",
        hermesSessionId: TIP_GRANDCHILD,
        hermesCanonicalSessionId: CANONICAL_PARENT,
        strategy: "issue",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        hangServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe("hermes_gateway session integration: first failed run with empty previous state", () => {
  it("persists canonical params on a failed run when the terminal payload confirms the tip", async () => {
    // Real-contract fake: the terminal SSE frame carries NO session_id; the
    // authoritative GET /v1/runs/{id} does. The adapter's status-fill must
    // surface the confirmed tip even on failure, and resolveNextSessionState
    // must persist it with the canonical id on empty previous state.
    const fillServer = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          fake.state.runBodies.push(body);
          const history = fake.state.lineageHistory.get(fake.state.tip) ?? [];
          history.push(`${String(body.session_id)}:${String(body.input ?? "")}`);
          fake.state.lineageHistory.set(fake.state.tip, history);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ run_id: "run-fill", status: "started" }));
        });
        return;
      }
      if (req.method === "GET" && /\/v1\/runs\/run-fill\/events$/.test(url)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: run.failed\ndata: {"event":"run.failed","run_id":"run-fill","error":"Connection error."}\n\n');
        res.end();
        return;
      }
      if (req.method === "GET" && /\/v1\/runs\/run-fill$/.test(url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "failed", error: "Connection error.", session_id: fake.state.tip }));
        return;
      }
      if (req.method === "POST" && /\/v1\/runs\/[^/]+\/stop$/.test(url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "stopping" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => fillServer.listen(0, "127.0.0.1", resolve));
    const fillUrl = `http://127.0.0.1:${(fillServer.address() as AddressInfo).port}`;

    try {
      const config = { ...baseConfig(fillUrl), existingHermesSessionId: CANONICAL_PARENT, timeoutSec: 3 };
      const ctx = makeGatewayCtx(config, { sessionId: null, sessionParams: null, sessionDisplayId: null });
      const result = await execute(ctx);

      // The failed run still reports the Hermes-confirmed tip.
      expect(result.exitCode).toBe(1);
      expect(result.sessionParams).toEqual({
        hermesRunId: "run-fill",
        hermesSessionId: fake.state.tip,
        hermesCanonicalSessionId: CANONICAL_PARENT,
        strategy: "issue",
      });

      const state = resolveNextSessionState({
        adapterType: "hermes_gateway",
        codec: gatewaySessionCodec,
        adapterResult: result,
        outcome: "failed",
        previousParams: null,
        previousDisplayId: null,
        previousLegacySessionId: null,
      });
      // First-run failed with empty previous state must NOT lose the params.
      expect(state.params?.hermesCanonicalSessionId).toBe(CANONICAL_PARENT);
      expect(state.params?.hermesSessionId).toBe(fake.state.tip);
      expect(state.displayId).toBe(fake.state.tip);

      // Codec round-trip on the persisted shape.
      expect(gatewaySessionCodec.serialize(gatewaySessionCodec.deserialize(state.params))).toEqual(state.params);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fillServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("keeps previous-state behavior when a failed run has no confirmed tip in params", async () => {
    // Adapter result WITHOUT a confirmed tip (no hermesSessionId): the server
    // transition must fall back to the previous state, not fabricate params.
    const failedResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      provider: "hermes_gateway",
      sessionParams: {
        hermesRunId: "run-no-tip",
        hermesCanonicalSessionId: CANONICAL_PARENT,
        strategy: "issue",
      },
      resultJson: { run_id: "run-no-tip", status: "failed" },
    } as unknown as Awaited<ReturnType<typeof execute>>;

    const state = resolveNextSessionState({
      adapterType: "hermes_gateway",
      codec: gatewaySessionCodec,
      adapterResult: failedResult,
      outcome: "failed",
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    });
    expect(state.params).toBeNull();
    expect(state.displayId).toBeNull();
    expect(state.legacySessionId).toBeNull();

    // And with existing previous params: unchanged (401/timeout contract).
    const persistedParams = {
      hermesRunId: "run-1",
      hermesSessionId: TIP_GRANDCHILD,
      hermesCanonicalSessionId: CANONICAL_PARENT,
      strategy: "issue",
    };
    const state2 = resolveNextSessionState({
      adapterType: "hermes_gateway",
      codec: gatewaySessionCodec,
      adapterResult: failedResult,
      outcome: "failed",
      previousParams: persistedParams,
      previousDisplayId: TIP_GRANDCHILD,
      previousLegacySessionId: TIP_GRANDCHILD,
    });
    expect(state2.params).toEqual(persistedParams);
    expect(state2.displayId).toBe(TIP_GRANDCHILD);
  });
});
