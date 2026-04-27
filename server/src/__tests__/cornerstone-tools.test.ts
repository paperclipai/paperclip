import { describe, expect, it } from "vitest";
import {
  AI_OPS_WRITE_WORKSPACE,
  CORNERSTONE_TOOL_NAMES,
  createCornerstoneToolsCallback,
  type CornerstoneToolResult,
} from "../services/cornerstone-tools.js";

// -----------------------------------------------------------------------------
// B2-5 acceptance tests for cornerstone-tools.ts.
//
// The factory exposes an apiKeyResolver + fetchImpl test hook; we drive every
// dispatch path through a scripted fetch and assert on the exact (method, path,
// body) tuple the handler emits plus the CornerstoneToolResult it returns.
//
// Invariants locked in here (contract the handler holds for all callers):
//   - 11 tool names route to the correct endpoint (per-tool dispatch).
//   - steward_apply short-circuits with pending_approval WITHOUT issuing any
//     HTTP call (destructive tools gated pre-approval-queue-UI).
//   - API failure surfaces return status=error + structured errorCode; handler
//     never throws across the callback boundary.
//   - Read tools pass the agent's namespace straight through to the API.
//   - Write tools (add_fact / save_conversation / steward_preview) always
//     rewrite the namespace to `aiops` regardless of what the agent supplied.
//   - Unknown tool names and bad input return structured errors, not throws.
// -----------------------------------------------------------------------------

type FetchCall = { method: string; path: string; body: unknown; query: Record<string, string> };

function scriptedFetch(
  handler: (call: FetchCall) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    const url = new URL(urlStr);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;
    const call: FetchCall = { method, path: url.pathname, body, query };
    calls.push(call);
    const { status, body: responseBody } = handler(call);
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function makeCallback(
  handler: (call: FetchCall) => { status: number; body: unknown },
  overrides?: { apiKey?: string },
) {
  const { fetchImpl, calls } = scriptedFetch(handler);
  const dispatch = createCornerstoneToolsCallback({
    companyId: "test-company",
    fetchImpl,
    apiKeyResolver: async () => overrides?.apiKey ?? "test-api-key",
  });
  return { dispatch, calls };
}

function ok(body: unknown) {
  return { status: 200, body };
}

describe("cornerstone-tools handler — per-tool dispatch", () => {
  it("wires the 11 agent-facing tool names declared by the cornerstone-tools-delegation contract", () => {
    // Guard against silent additions/removals. If a 12th tool lands it MUST
    // have a dispatch branch + spec + delegation-test coverage; adding the name
    // here is the forcing function for the rest.
    expect(CORNERSTONE_TOOL_NAMES).toEqual([
      "get_context",
      "search",
      "list_facts",
      "recall",
      "add_fact",
      "save_conversation",
      "steward_inspect",
      "steward_advise",
      "steward_preview",
      "steward_apply",
      "steward_status",
    ]);
  });

  it("get_context → POST /context with agent-supplied namespace + default detail_level=standard", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ context: "stub" }));
    const res = await dispatch({ name: "get_context", input: { query: "recent sprints", namespace: "usefulmachines" } });
    expect(res.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/context",
      body: { query: "recent sprints", namespace: "usefulmachines", detail_level: "standard", max_tokens: 2000 },
    });
  });

  it("search → POST /context with detail_level=minimal and max_tokens=600 by default", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ hits: [] }));
    const res = await dispatch({ name: "search", input: { query: "paperclip" } });
    expect(res.status).toBe("ok");
    expect(calls[0].body).toMatchObject({ query: "paperclip", detail_level: "minimal", max_tokens: 600 });
  });

  it("list_facts → GET /memory/facts with namespace+key_prefix+limit passed through as query params", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ facts: [] }));
    const res = await dispatch({
      name: "list_facts",
      input: { namespace: "usefulmachines", key_prefix: "co_paperclip_", limit: 50 },
    });
    expect(res.status).toBe("ok");
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/memory/facts",
      query: { namespace: "usefulmachines", key_prefix: "co_paperclip_", limit: "50" },
    });
  });

  it("list_facts limit is clamped to [1,500]", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ facts: [] }));
    await dispatch({ name: "list_facts", input: { namespace: "aiops", limit: 9999 } });
    expect(calls[0].query.limit).toBe("500");
    await dispatch({ name: "list_facts", input: { namespace: "aiops", limit: -10 } });
    expect(calls[1].query.limit).toBe("1");
  });

  it("recall → POST /context with detail_level=comprehensive and max_tokens=4000", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ context: "deep" }));
    const res = await dispatch({ name: "recall", input: { query: "who is Kim Berkin" } });
    expect(res.status).toBe("ok");
    expect(calls[0].body).toMatchObject({ detail_level: "comprehensive", max_tokens: 4000 });
  });

  it("steward_status → GET /ops/maintenance/jobs/{job_id} with url-encoded id", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ job: "done" }));
    await dispatch({ name: "steward_status", input: { job_id: "abc 123" } });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/ops/maintenance/jobs/abc%20123" });
  });

  it("steward_inspect dispatches each operation to its /ops/steward/inspect/<op> endpoint via GET with query params", async () => {
    // Inspect endpoints are read-only and GET-only on the Cornerstone side
    // (POST → 405). The handler must use GET + query, NOT POST + body.
    const { dispatch, calls } = makeCallback(() => ok({ items: [] }));
    const ops = [
      "duplicates",
      "contradictions",
      "stale",
      "expired",
      "orphans",
      "key-taxonomy",
      "missing-dates",
      "stale-embeddings",
      "cross-workspace-duplicates",
      "retrieval-interference",
      "composite-health",
      "fact-quality",
    ];
    for (const op of ops) {
      await dispatch({ name: "steward_inspect", input: { operation: op, namespace: "aiops" } });
    }
    expect(calls.map((c) => c.path)).toEqual(ops.map((op) => `/ops/steward/inspect/${op}`));
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.body).toBeNull();
      expect(call.query.namespace).toBe("aiops");
    }
  });

  it("steward_advise dispatches each operation to its /ops/steward/advise/<op> endpoint", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ recommendations: [] }));
    const ops = ["merge", "consolidate", "stale-review", "key-taxonomy", "contradictions"];
    for (const op of ops) {
      await dispatch({ name: "steward_advise", input: { operation: op, namespace: "aiops" } });
    }
    expect(calls.map((c) => c.path)).toEqual(ops.map((op) => `/ops/steward/advise/${op}`));
  });

  it("steward_preview dispatches each operation to its /ops/steward/mutate/<op>/preview endpoint", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ preview: {} }));
    const ops = [
      "merge-duplicates",
      "merge-notes",
      "archive-stale",
      "delete-by-filter",
      "consolidate-facts",
      "reembed-stale",
      "rename-keys",
    ];
    for (const op of ops) {
      await dispatch({ name: "steward_preview", input: { operation: op } });
    }
    expect(calls.map((c) => c.path)).toEqual(ops.map((op) => `/ops/steward/mutate/${op}/preview`));
  });
});

describe("cornerstone-tools handler — namespace scoping (security invariant)", () => {
  it("add_fact FORCES body.namespace=aiops even when the agent supplies a different namespace", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ status: "ok", key: "donald_audit_thing" }));
    const res = await dispatch({
      name: "add_fact",
      input: { key: "donald_audit_thing", value: "verified 2026-04-24", namespace: "default" },
    });
    expect(res.status).toBe("ok");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/memory/fact",
      body: { key: "donald_audit_thing", value: "verified 2026-04-24", namespace: AI_OPS_WRITE_WORKSPACE },
    });
  });

  it("save_conversation FORCES body.namespace=aiops even when the agent supplies a different namespace", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ saved: true }));
    const res = await dispatch({
      name: "save_conversation",
      input: {
        topic: "Cornerstone audit: duplicates for key-taxonomy",
        messages: [{ role: "assistant", content: "Donald found 3 duplicates." }],
        namespace: "usefulmachines",
      },
    });
    expect(res.status).toBe("ok");
    expect(calls[0]).toMatchObject({
      path: "/ingest",
      body: { namespace: AI_OPS_WRITE_WORKSPACE, topic: "Cornerstone audit: duplicates for key-taxonomy" },
    });
  });

  it("steward_preview FORCES body.namespace=aiops even when the agent supplies a different namespace", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ preview: [] }));
    await dispatch({
      name: "steward_preview",
      input: { operation: "merge-duplicates", namespace: "default", threshold: 0.9 },
    });
    expect(calls[0].body).toMatchObject({ namespace: AI_OPS_WRITE_WORKSPACE, threshold: 0.9 });
  });

  it("read tools pass the agent-supplied namespace through UNCHANGED (cross-workspace read is explicit)", async () => {
    const { dispatch, calls } = makeCallback(() => ok({}));
    await dispatch({ name: "get_context", input: { query: "x", namespace: "usefulmachines" } });
    await dispatch({ name: "search", input: { query: "x", namespace: "default" } });
    await dispatch({ name: "recall", input: { query: "x", namespace: "aiops" } });
    expect((calls[0].body as { namespace: string }).namespace).toBe("usefulmachines");
    expect((calls[1].body as { namespace: string }).namespace).toBe("default");
    expect((calls[2].body as { namespace: string }).namespace).toBe("aiops");
  });

  it("read tool with no namespace input defaults namespace to aiops (Workforce principals are aiops-scoped)", async () => {
    const { dispatch, calls } = makeCallback(() => ok({}));
    await dispatch({ name: "get_context", input: { query: "x" } });
    await dispatch({ name: "search", input: { query: "x" } });
    await dispatch({ name: "list_facts", input: {} });
    await dispatch({ name: "recall", input: { query: "x" } });
    await dispatch({ name: "steward_inspect", input: { operation: "duplicates" } });
    expect((calls[0].body as { namespace: string }).namespace).toBe(AI_OPS_WRITE_WORKSPACE);
    expect((calls[1].body as { namespace: string }).namespace).toBe(AI_OPS_WRITE_WORKSPACE);
    // list_facts is GET — namespace lives in query string
    expect(calls[2].query?.namespace).toBe(AI_OPS_WRITE_WORKSPACE);
    expect((calls[3].body as { namespace: string }).namespace).toBe(AI_OPS_WRITE_WORKSPACE);
    // steward_inspect is GET — namespace lives in query string
    expect(calls[4].query?.namespace).toBe(AI_OPS_WRITE_WORKSPACE);
  });
});

describe("cornerstone-tools handler — targetWorkspace routing (per-task workspace plumbing)", () => {
  // Helper that mirrors makeCallback() but lets the test pin a per-task
  // targetWorkspace. The factory closure-captures this once, so a single
  // dispatch instance models a single task's run.
  function makeCallbackWithWorkspace(
    handler: (call: FetchCall) => { status: number; body: unknown },
    targetWorkspace: string | null,
  ) {
    const { fetchImpl, calls } = scriptedFetch(handler);
    const dispatch = createCornerstoneToolsCallback({
      companyId: "test-company",
      fetchImpl,
      apiKeyResolver: async () => "test-api-key",
      targetWorkspace,
    });
    return { dispatch, calls };
  }

  it("writes route to targetWorkspace when the task sets it, ignoring agent-supplied namespace input", async () => {
    const { dispatch, calls } = makeCallbackWithWorkspace(
      () => ok({ ok: true }),
      "usefulmachines",
    );
    await dispatch({
      name: "add_fact",
      input: { key: "client_thing", value: "x", namespace: "default" },
    });
    await dispatch({
      name: "save_conversation",
      input: { topic: "client review", messages: [{ role: "assistant", content: "y" }], namespace: "default" },
    });
    await dispatch({
      name: "steward_preview",
      input: { operation: "merge-duplicates", namespace: "default" },
    });
    expect((calls[0].body as { namespace: string }).namespace).toBe("usefulmachines");
    expect((calls[1].body as { namespace: string }).namespace).toBe("usefulmachines");
    expect((calls[2].body as { namespace: string }).namespace).toBe("usefulmachines");
  });

  it("reads route to targetWorkspace when the task sets it, ignoring agent-supplied namespace input (delegation safety)", async () => {
    const { dispatch, calls } = makeCallbackWithWorkspace(() => ok({}), "usefulmachines");
    await dispatch({ name: "get_context", input: { query: "x", namespace: "default" } });
    await dispatch({ name: "search", input: { query: "x", namespace: "default" } });
    await dispatch({ name: "list_facts", input: { namespace: "default" } });
    await dispatch({ name: "recall", input: { query: "x", namespace: "default" } });
    await dispatch({ name: "steward_inspect", input: { operation: "duplicates", namespace: "default" } });
    expect((calls[0].body as { namespace: string }).namespace).toBe("usefulmachines");
    expect((calls[1].body as { namespace: string }).namespace).toBe("usefulmachines");
    expect(calls[2].query?.namespace).toBe("usefulmachines");
    expect((calls[3].body as { namespace: string }).namespace).toBe("usefulmachines");
    expect(calls[4].query?.namespace).toBe("usefulmachines");
  });

  it("reads honour agent-supplied namespace when the task has no targetWorkspace pinned", async () => {
    const { dispatch, calls } = makeCallbackWithWorkspace(() => ok({}), null);
    await dispatch({ name: "get_context", input: { query: "x", namespace: "default" } });
    expect((calls[0].body as { namespace: string }).namespace).toBe("default");
  });

  it("writes fall through to AI_OPS_WRITE_WORKSPACE when the task has no targetWorkspace and no agent input", async () => {
    const { dispatch, calls } = makeCallbackWithWorkspace(() => ok({ ok: true }), null);
    await dispatch({ name: "add_fact", input: { key: "x", value: "y" } });
    expect((calls[0].body as { namespace: string }).namespace).toBe(AI_OPS_WRITE_WORKSPACE);
  });

  it("maps 403 namespace_not_granted to structured target_workspace_grant_missing error code", async () => {
    const { dispatch } = makeCallbackWithWorkspace(
      () => ({ status: 403, body: { detail: "namespace_not_granted" } }),
      "usefulmachines",
    );
    const res = await dispatch({ name: "add_fact", input: { key: "x", value: "y" } });
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("target_workspace_grant_missing");
    expect(res.errorMessage).toContain("usefulmachines");
  });

  it("maps the multiple-grants 403 (namespace required) to target_workspace_grant_missing", async () => {
    // The Cornerstone API also returns 403 with "Namespace is required. This
    // principal has multiple workspace grants" — same root cause (resolved
    // namespace is empty/unauthorised), same structured code expected.
    const { dispatch } = makeCallbackWithWorkspace(
      () =>
        ({ status: 403, body: { detail: "Namespace is required. This principal has multiple workspace grants" } }),
      null,
    );
    const res = await dispatch({ name: "get_context", input: { query: "x" } });
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("target_workspace_grant_missing");
  });

  it("does not misclassify 403s that are NOT namespace-grant failures", async () => {
    const { dispatch } = makeCallbackWithWorkspace(
      () => ({ status: 403, body: { detail: "rate_limited" } }),
      "usefulmachines",
    );
    const res = await dispatch({ name: "add_fact", input: { key: "x", value: "y" } });
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("cornerstone_api_error");
  });
});

describe("cornerstone-tools handler — steward_apply is blocked for dogfood", () => {
  it("steward_apply returns status=pending_approval and DOES NOT hit the API", async () => {
    const { dispatch, calls } = makeCallback(() => ok({ applied: true }));
    const res = await dispatch({
      name: "steward_apply",
      input: { operation: "merge-duplicates", job_id: "jobs_123" },
    });
    expect(res.status).toBe("pending_approval");
    expect(res.errorCode).toBe("approval_queue_not_available");
    expect(calls).toHaveLength(0);
  });
});

describe("cornerstone-tools handler — error paths never throw across the callback boundary", () => {
  it("API 403 → status=error, errorCode=cornerstone_api_error, response status+body exposed to caller", async () => {
    const { dispatch } = makeCallback(() => ({
      status: 403,
      body: { detail: "Access denied: namespace_access_insufficient (read)" },
    }));
    const res = await dispatch({
      name: "add_fact",
      input: { key: "k", value: "v" },
    });
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("cornerstone_api_error");
    expect(res.errorMessage).toContain("namespace_access_insufficient");
    const payload = res.output as { status: number; body: { detail: string } };
    expect(payload.status).toBe(403);
    expect(payload.body.detail).toContain("namespace_access_insufficient");
  });

  it("API 500 → status=error, errorCode=cornerstone_api_error (does not throw)", async () => {
    const { dispatch } = makeCallback(() => ({ status: 500, body: { detail: "internal server error" } }));
    const res = await dispatch({ name: "get_context", input: { query: "x" } });
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("cornerstone_api_error");
  });

  it("network-level fetch throw → status=error, errorCode=cornerstone_api_unreachable", async () => {
    const dispatch = createCornerstoneToolsCallback({
      companyId: "test-company",
      apiKeyResolver: async () => "test-api-key",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const res = await dispatch({ name: "get_context", input: { query: "x" } });
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("cornerstone_api_unreachable");
    expect(res.errorMessage).toContain("fetch failed");
  });

  it("apiKeyResolver throwing a plain Error → errorCode=cornerstone_api_unreachable (no throw)", async () => {
    // If secretService.resolveSecretValue rejects (bad master key, DB down,
    // missing company secret row), the handler's catch wraps the error as
    // cornerstone_api_unreachable. The only code that surfaces as
    // cornerstone_api_key_missing is the in-module CornerstoneToolConfigError
    // branch (see dispatch catch).
    const dispatch = createCornerstoneToolsCallback({
      companyId: "test-company",
      apiKeyResolver: async () => {
        throw new Error("resolver failure");
      },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const res = await dispatch({ name: "get_context", input: { query: "x" } });
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("cornerstone_api_unreachable");
    expect(res.errorMessage).toContain("resolver failure");
  });
});

describe("cornerstone-tools handler — input validation (no-throw contract)", () => {
  const noFetch = () => {
    throw new Error("should not reach fetch");
  };

  it("unknown tool name → status=error, errorCode=unknown_tool, no fetch", async () => {
    const { dispatch, calls } = makeCallback(noFetch);
    const res = (await dispatch({ name: "not_a_real_tool", input: {} })) as CornerstoneToolResult;
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("unknown_tool");
    expect(calls).toHaveLength(0);
  });

  it("get_context with empty query → errorCode=invalid_input, no fetch", async () => {
    const { dispatch, calls } = makeCallback(noFetch);
    const res = await dispatch({ name: "get_context", input: { query: "" } });
    expect(res.errorCode).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("add_fact missing key/value → errorCode=invalid_input, no fetch", async () => {
    const { dispatch, calls } = makeCallback(noFetch);
    const r1 = await dispatch({ name: "add_fact", input: { value: "v" } });
    const r2 = await dispatch({ name: "add_fact", input: { key: "k" } });
    expect(r1.errorCode).toBe("invalid_input");
    expect(r2.errorCode).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("save_conversation missing topic/messages → errorCode=invalid_input, no fetch", async () => {
    const { dispatch, calls } = makeCallback(noFetch);
    const r1 = await dispatch({ name: "save_conversation", input: { messages: [{ role: "u", content: "hi" }] } });
    const r2 = await dispatch({ name: "save_conversation", input: { topic: "x", messages: [] } });
    expect(r1.errorCode).toBe("invalid_input");
    expect(r2.errorCode).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("steward_inspect unsupported operation → errorCode=unsupported_operation, no fetch", async () => {
    const { dispatch, calls } = makeCallback(noFetch);
    const res = await dispatch({ name: "steward_inspect", input: { operation: "made-up-op" } });
    expect(res.errorCode).toBe("unsupported_operation");
    expect(res.errorMessage).toContain("duplicates");
    expect(calls).toHaveLength(0);
  });

  it("steward_preview unsupported operation → errorCode=unsupported_operation, no fetch", async () => {
    const { dispatch, calls } = makeCallback(noFetch);
    const res = await dispatch({ name: "steward_preview", input: { operation: "made-up-op" } });
    expect(res.errorCode).toBe("unsupported_operation");
    expect(calls).toHaveLength(0);
  });

  it("steward_status missing job_id → errorCode=invalid_input, no fetch", async () => {
    const { dispatch, calls } = makeCallback(noFetch);
    const res = await dispatch({ name: "steward_status", input: {} });
    expect(res.errorCode).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});
