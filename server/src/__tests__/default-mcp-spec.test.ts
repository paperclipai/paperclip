import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  resolveCommsBoardProvisionerConfig,
  composeCommsBoardIdentity,
  mintCommsBoardCredential,
  mintCommsBoardTemplateCredential,
  composeTemplateSub,
  registerCommsBoardAgent,
  COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS,
  COMMS_BOARD_TOKEN_SCOPES,
  COMMS_BOARD_TEMPLATE_TOKEN_SCOPES,
  RH_MCP_SERVICE_TOKEN_SCOPES_VERSION,
} from "../services/comms-board-provisioner-client.js";
import {
  AGENT_MEMORY_TOOL_TIMEOUT_MS,
  ARGUS_REVIEW_TOOL_TIMEOUT_MS,
  RH_MCP_SERVICE_TOOLS_BY_SCOPE,
  COMPS_TOOL_TIMEOUT_MS,
  VOICE_APPLY_TOOL_TIMEOUT_MS,
  DECISIONS_GRID_TOOL_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_MS,
  defaultToolTimeoutMs,
  ARGUS_REVIEW_REVIEWED_TOOLS,
  ARGUS_REVIEW_REVIEWED_TOOLS_VERSION,
  COMMS_BOARD_REVIEWED_TOOLS,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_TEMPLATE_UID,
  agentMayUseConnectionTool,
  agentReadCeilingForConnection,
  assertPersonalDefaultMcpTemplateUpdateValid,
  isManagedDedicated,
  isManagedTemplate,
  isDefaultMcpSeed,
  isPersonalDefaultMcpInstance,
  isPersonalDefaultMcpTemplate,
  isProtectedPersonalDefaultMcpMarker,
  isValidDefaultMcpTemplate,
  readTemplateClaim,
  stripDefaultMcpProtectedConfigKeys,
  managedConnectionMatch,
  managedConnectionRole,
  readCommsBoardBindingReference,
  installAppliesToAgent,
  stripReservedDefaultMcpMetadata,
} from "../services/default-mcp-spec.js";
import { defaultMcpBackoffMs } from "../services/default-mcp-setup.js";
import {
  DEFAULT_MCP_SPEC as GOOGLE_DEFAULT_SPEC,
  RH_GOOGLE_MCP_INITIAL_ACTIVE_TOOLS,
  RH_GOOGLE_MCP_SAFE_WRITE_TOOLS,
  initialActiveToolsForPersonalInstance,
  installsOnExistingAgentsOnConnect,
} from "../services/default-mcp-spec.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_AGENT_ID,
  BOARD_TOKEN,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  boardResponse,
  clientConfig,
  downstreamFetch,
  ownershipResponse,
} from "./helpers/comms-board-downstream.js";

describe("comms board identity recipe", () => {
  it("composes a '::'-free token base and bare board sub with null agentKey", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(composeCommsBoardIdentity(id)).toEqual({
      baseSub: `paperclip-agent-${id}`,
      agentKey: null,
      boardSub: `paperclip-agent-${id}`,
    });
    expect(composeCommsBoardIdentity(id)!.baseSub).not.toContain("::");
  });
});

describe("registerCommsBoardAgent (comms_admin_register over JSON-RPC)", () => {
  const request = { boardSub: "paperclip-agent-1::key", displayName: "Agent (1)", ownerEmail: "owner@redesignhealth.com" };

  it("calls tools/call with the admin bearer and captures the returned board agent UUID", async () => {
    const fetchImpl = downstreamFetch();
    const out = await registerCommsBoardAgent(clientConfig, request, fetchImpl);
    expect(out).toEqual({ ok: true, boardAgentId: BOARD_AGENT_ID, boardSub: request.boardSub });
    const toolCall = fetchImpl.mock.calls.find(([, init]) => {
      try {
        return JSON.parse(String(init.body))?.method === "tools/call";
      } catch {
        return false;
      }
    });
    expect(toolCall).toBeDefined();
    const [url, init] = toolCall as unknown as [string, RequestInit];
    expect(url).toBe(BOARD_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${BOARD_ADMIN_TOKEN}`);
    expect((init.headers as Record<string, string>).accept).toBe("application/json, text/event-stream");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comms_admin_register" } });
    expect(body.params.arguments).toEqual({
      sub: "paperclip-agent-1::key",
      owner_sub: "owner@redesignhealth.com",
      owner_email: "owner@redesignhealth.com",
      display_name: "Agent (1)",
      is_shared: false,
    });
  });

  it("parses an SSE-framed response", async () => {
    const out = await registerCommsBoardAgent(clientConfig, request, downstreamFetch({ register: () => boardResponse(request.boardSub, { sse: true }) }));
    expect(out).toMatchObject({ ok: true, boardAgentId: BOARD_AGENT_ID });
  });

  it.each([
    ["already_registered", () => boardResponse("s", { isError: true, payload: { error_code: "already_registered" } }), "board_conflict"],
    ["access_denied", () => boardResponse("s", { isError: true, payload: { error_code: "access_denied" } }), "board_rejected"],
    ["identity_fork_detected", () => boardResponse("s", { isError: true, payload: { error_code: "identity_fork_detected" } }), "board_conflict"],
    ["HTTP 403", () => boardResponse("s", { status: 403 }), "board_rejected"],
    ["HTTP 500", () => boardResponse("s", { status: 500 }), "board_unknown"],
    ["HTTP 404 (client error before the tool ran)", () => boardResponse("s", { status: 404 }), "board_failed"],
    ["missing agent_id", () => boardResponse(request.boardSub, { payload: { sub: request.boardSub } }), "board_unknown"],
    ["non-UUID agent_id", () => boardResponse(request.boardSub, { payload: { agent_id: "nope", sub: request.boardSub } }), "board_unknown"],
    ["sub mismatch", () => boardResponse("other", { payload: { agent_id: BOARD_AGENT_ID, sub: "other" } }), "board_unknown"],
    ["response id mismatch", () => boardResponse(request.boardSub, { id: 7 }), "board_unknown"],
    ["JSON-RPC error (tool never ran)", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }), { status: 200 }), "board_unknown"],
  ])("fails visibly on %s", async (_label, respond, reason) => {
    const fetchImpl = downstreamFetch({ register: () => respond() });
    expect(await registerCommsBoardAgent(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason });
  });

  it("reports unavailable on timeout without retrying", async () => {
    const fetchImpl = downstreamFetch({
      register: () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    expect(await registerCommsBoardAgent(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "board_unknown" });
  });
});

describe("registerCommsBoardAgent SSE framing (reply matched by request id)", () => {
  const request = { boardSub: "paperclip-agent-1::key", displayName: "Agent (1)", ownerEmail: "owner@redesignhealth.com" };
  const reply = (id = 1, extra: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0", id,
    result: { content: [{ type: "text", text: JSON.stringify({ agent_id: BOARD_AGENT_ID, sub: request.boardSub }) }], isError: false },
    ...extra,
  });
  const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  const run = (body: string) => registerCommsBoardAgent(clientConfig, request, downstreamFetch({ register: () => sse(body) }));

  it("skips a comment preamble, keep-alives and notifications before the id-1 reply", async () => {
    const body = [
      ": connected",
      "",
      "event: ping",
      "data:",
      "",
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}`,
      "",
      `data: ${JSON.stringify(reply(99))}`, // a reply to some other request
      "",
      `event: message\ndata: ${JSON.stringify(reply(1))}`,
      "",
    ].join("\n");
    expect(await run(body)).toEqual({ ok: true, boardAgentId: BOARD_AGENT_ID, boardSub: request.boardSub });
  });

  it("handles CRLF and CR line endings and joins several data lines with a newline (one leading space removed)", async () => {
    const json = JSON.stringify(reply(1), null, 1); // multi-line JSON
    const lines = json.split("\n").map((line, i) => `data:${i % 2 === 0 ? " " : ""}${line}`);
    expect(await run(`${lines.join("\r\n")}\r\n\r\n`)).toMatchObject({ ok: true });
    expect(await run(`${lines.join("\r")}\r\r`)).toMatchObject({ ok: true });
  });

  it("preserves a matching JSON-RPC error as board_failed, even after notifications", async () => {
    const notification = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`;
    const error = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid" } })}\n\n`;
    expect(await run(notification + error)).toEqual({ ok: false, reason: "board_unknown" });
  });

  it.each([
    ["only a notification", `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n\n`],
    ["only another id", `data: ${JSON.stringify(reply(2))}\n\n`],
    ["only comments / keep-alives", ": keep-alive\n\n: keep-alive\n\n"],
    ["non-JSON data", "data: not-json\n\n"],
    ["an empty stream", ""],
  ])("fails closed as an UNKNOWN outcome on %s (never guessing the id, never retrying)", async (_label, body) => {
    const fetchImpl = downstreamFetch({ register: () => sse(body) });
    expect(await registerCommsBoardAgent(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "board_unknown" });
  });

  it("an oversized body is not scanned and is an unknown outcome", async () => {
    const huge = `: ${"x".repeat(1_100_000)}\n\ndata: ${JSON.stringify(reply(1))}\n\n`;
    expect(await run(huge)).toEqual({ ok: false, reason: "board_unknown" });
  });

  it("a plain JSON reply for another id is still an unknown outcome", async () => {
    const fetchImpl = downstreamFetch({ register: () => new Response(JSON.stringify(reply(5)), { status: 200, headers: { "content-type": "application/json" } }) });
    expect(await registerCommsBoardAgent(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "board_unknown" });
  });
});

describe("mintCommsBoardCredential (ownership_api POST /agents)", () => {
  const request = { baseSub: "paperclip-agent-abc-123", ownerEmail: "owner@redesignhealth.com" };

  it("POSTs the token base with comms:read/write/proposals:write only, 365 days, and returns the token", async () => {
    const fetchImpl = downstreamFetch();
    const out = await mintCommsBoardCredential(clientConfig, request, fetchImpl);
    expect(out).toEqual({ ok: true, boardToken: BOARD_TOKEN, tokenExpiresAt: "2027-03-01T00:00:00+00:00" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${OWNERSHIP_URL}/agents`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${OWNERSHIP_TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      sub: "paperclip-agent-abc-123",
      owner_email: "owner@redesignhealth.com",
      scopes: ["comms:read", "comms:write", "comms:proposals:write"],
      expires_in_days: 365,
    });
  });

  it("enforces 365-day token TTL constant within issuer bounds and exact mint contract (TECH-7268)", async () => {
    expect(COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS).toBe(365);
    expect(Number.isInteger(COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS)).toBe(true);
    expect(COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS).toBeGreaterThanOrEqual(1);
    expect(COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS).toBeLessThanOrEqual(3650);

    expect(COMMS_BOARD_TOKEN_SCOPES).toEqual(["comms:read", "comms:write", "comms:proposals:write"]);

    const fetchImpl = downstreamFetch();
    const registerOut = await registerCommsBoardAgent(
      clientConfig,
      { boardSub: "paperclip-agent-abc-123", displayName: "Bot", ownerEmail: "owner@redesignhealth.com" },
      fetchImpl,
    );
    expect(registerOut.ok).toBe(true);

    const mintOut = await mintCommsBoardCredential(clientConfig, request, fetchImpl);
    expect(mintOut.ok).toBe(true);
    // Downstream fixed issuer date passed through untouched without client recomputation
    expect(mintOut.tokenExpiresAt).toBe("2027-03-01T00:00:00+00:00");

    const toolCall = fetchImpl.mock.calls.find(([, init]) => {
      try {
        return JSON.parse(String(init.body))?.method === "tools/call";
      } catch {
        return false;
      }
    });
    const registerBody = JSON.parse(toolCall![1].body as string);
    const registerArgs = registerBody.params.arguments;
    // admin register payload has NO expiry field
    expect(registerArgs).not.toHaveProperty("expires_in_days");
    expect(registerArgs).not.toHaveProperty("expires");
    expect(registerArgs).not.toHaveProperty("token_expires_at");

    const mintCall = fetchImpl.mock.calls.find(([url]) => url === `${OWNERSHIP_URL}/agents`);
    const mintBody = JSON.parse(mintCall![1].body as string);
    // EXACT mint body keys {sub, owner_email, scopes, expires_in_days}
    expect(Object.keys(mintBody).sort()).toEqual(["expires_in_days", "owner_email", "scopes", "sub"].sort());
    expect(mintBody.scopes).toEqual(["comms:read", "comms:write", "comms:proposals:write"]);
    expect(mintBody.expires_in_days).toBe(365);

    // Control bearer JWT strings NEVER in request body of either call
    const allBodies = fetchImpl.mock.calls.map(([, init]) => String(init.body ?? ""));
    for (const bodyStr of allBodies) {
      expect(bodyStr).not.toContain(BOARD_ADMIN_TOKEN);
      expect(bodyStr).not.toContain(OWNERSHIP_TOKEN);
    }
  });

  it("refuses a token base containing '::' without calling the API", async () => {
    const fetchImpl = vi.fn();
    expect(await mintCommsBoardCredential(clientConfig, { ...request, baseSub: "base::key" }, fetchImpl)).toEqual({ ok: false, reason: "invalid_subject" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["null token", () => ownershipResponse("paperclip-agent-abc-123", { token: null }), "mint_unknown"],
    ["empty token", () => ownershipResponse("paperclip-agent-abc-123", { token: "" }), "mint_unknown"],
    ["sub mismatch", () => ownershipResponse("paperclip-agent-abc-123", { sub: "other" }), "mint_unknown"],
    ["409", () => ownershipResponse("s", {}, 409), "ownership_conflict"],
    ["403", () => ownershipResponse("s", {}, 403), "ownership_rejected"],
    ["500", () => ownershipResponse("s", {}, 500), "mint_unknown"],
    ["422", () => ownershipResponse("s", {}, 422), "ownership_failed"],
    ["502 gateway", () => ownershipResponse("s", {}, 502), "mint_unknown"],
    ["non-JSON 201", () => new Response("<html>", { status: 201 }), "mint_unknown"],
  ])("fails visibly on %s", async (_label, respond, reason) => {
    const fetchImpl = vi.fn(async () => respond());
    expect(await mintCommsBoardCredential(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable on timeout without retrying", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await mintCommsBoardCredential(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "mint_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("agent metadata reserved key", () => {
  const stored = { defaultMcp: { version: 1, entries: { a: 1 } }, other: true };
  it("discards caller-supplied defaultMcp and keeps the stored value", () => {
    expect(stripReservedDefaultMcpMetadata({ defaultMcp: { forged: true }, x: 1 }, stored)).toEqual({
      x: 1,
      defaultMcp: stored.defaultMcp,
    });
  });
  it("does not let a null patch wipe the stored value", () => {
    expect(stripReservedDefaultMcpMetadata(null, stored)).toEqual({ defaultMcp: stored.defaultMcp });
    expect(stripReservedDefaultMcpMetadata(null, { other: true })).toBeNull();
  });
  it("drops a forged key when nothing is stored", () => {
    expect(stripReservedDefaultMcpMetadata({ defaultMcp: { forged: true } })).toEqual({});
    expect(stripReservedDefaultMcpMetadata(undefined, stored)).toBeUndefined();
  });
});


describe("effective install rule for default-MCP agents", () => {
  const entry = (over: Record<string, unknown>) => ({
    key: "k", templateKey: null, dedicated: false, enabled: false, templateConnectionId: null, connectionId: null, ownerUserId: null, ...over,
  });
  const state = (entries: Record<string, ReturnType<typeof entry>>) => ({ version: 1 as const, entries }) as never;
  const CO = "company-1";
  const conn = (over: Partial<{ id: string; companyId: string; name: string }> = {}) => ({ id: "c-any", companyId: CO, name: "other", ...over });

  const managed = state({
    comms: entry({ key: "comms", templateKey: "rh-comms-board", dedicated: true, templateConnectionId: "t1", connectionId: "d1" }),
    google: entry({ key: "google", templateKey: "rh-google-mcp", dedicated: false, templateConnectionId: "g1", connectionId: "g1" }),
    late: entry({ key: "late", templateKey: "rh-late-mcp", dedicated: false }), // template did not exist at creation
  });

  it("classifies by recorded id, the FROZEN template name (late-created templates) and dedicated name prefixes", () => {
    expect(managedConnectionRole(managed, CO, conn({ id: "d1" }))).toBe("managed"); // own, by STORED id
    expect(managedConnectionRole(managed, CO, conn({ id: "t1" }))).toBe("forbidden"); // dedicated entry's template
    expect(managedConnectionRole(managed, CO, conn({ id: "late-id", name: "rh-late-mcp" }))).toBe("managed"); // ordinary, template created later
    expect(managedConnectionRole(managed, CO, conn({ id: "x", name: "rh-comms-board:11111111-1111-1111-1111-111111111111" }))).toBe("forbidden"); // prefix never authorizes
    // A prefix only counts for a dedicated entry, and only with the ':' separator.
    expect(managedConnectionRole(managed, CO, conn({ id: "x", name: "rh-google-mcp:abc" }))).toBeNull();
    expect(managedConnectionRole(managed, CO, conn({ id: "x", name: "rh-comms-boardX" }))).toBeNull();
    expect(managedConnectionRole(managed, CO, conn())).toBeNull();
    expect(managedConnectionMatch(managed, CO, conn({ id: "t1" }))).toBe(true);
  });

  it("never matches another company's connection, no state, or a forged/empty state", () => {
    expect(managedConnectionMatch(managed, CO, conn({ id: "d1", companyId: "company-2" }))).toBe(false);
    expect(managedConnectionMatch(managed, CO, conn({ name: "rh-comms-board", companyId: "company-2" }))).toBe(false);
    expect(managedConnectionMatch(null, CO, conn({ id: "d1" }))).toBe(false);
    expect(managedConnectionMatch(state({ forged: entry({ key: "forged", templateKey: "", connectionId: null }) }), CO, conn({ name: "" }))).toBe(false);
  });

  it("a company-wide install never authorizes a managed connection; only an explicit agent install of the agent's OWN connection does", () => {
    const agent = { companyId: CO, state: managed };
    // Ordinary entry (Google) and a late-created ordinary template: explicit agent install works, company install does not.
    expect(installAppliesToAgent({ targetType: "company" }, agent, conn({ id: "g1" }))).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent" }, agent, conn({ id: "g1" }))).toBe(true);
    expect(installAppliesToAgent({ targetType: "company" }, agent, conn({ name: "rh-late-mcp" }))).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent" }, agent, conn({ name: "rh-late-mcp" }))).toBe(true);
    // Dedicated entry: the STORED own connection works with an explicit install...
    expect(installAppliesToAgent({ targetType: "agent" }, agent, conn({ id: "d1" }))).toBe(true);
    expect(installAppliesToAgent({ targetType: "company" }, agent, conn({ id: "d1" }))).toBe(false);
    // ...but the org template and any other agent's dedicated connection are never authorized, by any install.
    for (const forbidden of [conn({ id: "t1" }), conn({ name: "rh-comms-board" }), conn({ name: "rh-comms-board:another-agent" })]) {
      expect(managedConnectionRole(managed, CO, forbidden)).toBe("forbidden");
      expect(installAppliesToAgent({ targetType: "agent" }, agent, forbidden)).toBe(false);
      expect(installAppliesToAgent({ targetType: "company" }, agent, forbidden)).toBe(false);
    }
    // Unrelated connections and agents without default-MCP state are unchanged.
    expect(installAppliesToAgent({ targetType: "company" }, agent, conn())).toBe(true);
    expect(installAppliesToAgent({ targetType: "company" }, { companyId: CO, state: null }, conn({ id: "t1" }))).toBe(true);
    expect(installAppliesToAgent({ targetType: "agent" }, { companyId: CO, state: null }, conn({ id: "t1" }))).toBe(true);
  });
});

describe("retry backoff", () => {
  it("doubles from one minute and is capped at one hour", () => {
    expect([1, 2, 3, 4].map(defaultMcpBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(defaultMcpBackoffMs(7)).toBe(3_600_000);
    expect(defaultMcpBackoffMs(50)).toBe(3_600_000);
    expect(defaultMcpBackoffMs(0)).toBe(60_000);
  });
});

describe("read-only binding reference for the wake bridge", () => {
  const binding = (tokenExpiresAt: string | null) => ({
    boardAgentId: BOARD_AGENT_ID, baseSub: "paperclip-agent-1", agentKey: "k", boardSub: "paperclip-agent-1::k",
    secretId: "s1", secretVersion: "latest", connectionId: "c1", grantId: "g1", tokenExpiresAt,
  });
  const metadata = (state: string, tokenExpiresAt: string | null) => ({
    defaultMcp: { version: 1, entries: { "comms-board": { key: "comms-board", setup: { state }, binding: binding(tokenExpiresAt) } } },
  });

  it("is only available when ready, carries ids only, and stops advertising an expired token", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(readCommsBoardBindingReference(metadata("ready", future))).toEqual(binding(future));
    expect(readCommsBoardBindingReference(metadata("ready", null))).toEqual(binding(null));
    expect(readCommsBoardBindingReference(metadata("pending", future))).toBeNull();
    expect(readCommsBoardBindingReference(metadata("error", future))).toBeNull();
    expect(readCommsBoardBindingReference(metadata("ready", new Date(Date.now() - 1000).toISOString()))).toBeNull();
    expect(readCommsBoardBindingReference(null)).toBeNull();
    expect(JSON.stringify(readCommsBoardBindingReference(metadata("ready", future)))).not.toMatch(/token"|secret_ref|Bearer/i);
  });
});

describe("provisioner endpoint validation (resolveCommsBoardProvisionerConfig)", () => {
  const env = (over: Record<string, string | undefined> = {}) => ({
    [COMMS_BOARD_MCP_URL_ENV]: "https://board.example.test/team/mcp",
    [COMMS_BOARD_ADMIN_TOKEN_ENV]: "admin",
    [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: "https://ownership.tailnet.example/api/v1/",
    [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: "ownership",
    ...over,
  }) as NodeJS.ProcessEnv;

  it("accepts https on any host (private tailnets included) and keeps the full legitimate paths", () => {
    expect(resolveCommsBoardProvisionerConfig(env())).toEqual({
      ok: true,
      config: { boardMcpUrl: "https://board.example.test/team/mcp", boardAdminToken: "admin", ownershipApiUrl: "https://ownership.tailnet.example/api/v1", ownershipApiToken: "ownership" },
    });
  });

  it.each(["http://127.0.0.1:8080/mcp", "http://localhost/mcp", "http://[::1]:9000/mcp", "HTTP://LOCALHOST/mcp"])("allows plain HTTP only for the loopback host %s", (url) => {
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_MCP_URL_ENV]: url })).ok).toBe(true);
  });

  it.each([
    "http://board.example.test/mcp",
    "http://10.0.0.5/mcp",
    "http://127.0.0.1.evil.test/mcp",
    "https://user:pw@board.example.test/mcp",
    "https://user@board.example.test/mcp",
    "https://board.example.test/mcp?token=x",
    "https://board.example.test/mcp#frag",
    "ftp://board.example.test/mcp",
    "javascript:alert(1)",
    "not a url",
    "//board.example.test/mcp",
  ])("rejects %s as provisioner_config_invalid (either endpoint)", (url) => {
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_MCP_URL_ENV]: url }))).toEqual({ ok: false, reason: "provisioner_config_invalid" });
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: url }))).toEqual({ ok: false, reason: "provisioner_config_invalid" });
  });

  it("a missing setting is provisioner_not_configured (checked before validity)", () => {
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_ADMIN_TOKEN_ENV]: undefined }))).toEqual({ ok: false, reason: "provisioner_not_configured" });
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_MCP_URL_ENV]: "http://bad.test", [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: undefined }))).toEqual({ ok: false, reason: "provisioner_not_configured" });
  });
});

describe("redirects are never followed", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function redirectingServer() {
    const hits: Array<{ path: string; authorization: string | undefined }> = [];
    server = createServer((req, res) => {
      hits.push({ path: req.url ?? "", authorization: req.headers.authorization });
      if (req.url === "/start" || req.url === "/agents") {
        res.writeHead(302, { location: "/leaked-target" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, hits };
  }

  it("sets redirect:error on both calls", async () => {
    const fetchImpl = downstreamFetch();
    await registerCommsBoardAgent(clientConfig, { boardSub: "s::k", displayName: "d", ownerEmail: "o@x.test" }, fetchImpl);
    await mintCommsBoardCredential(clientConfig, { baseSub: "paperclip-agent-1", ownerEmail: "o@x.test" }, fetchImpl);
    for (const call of fetchImpl.mock.calls) expect((call[1] as RequestInit).redirect).toBe("error");
  });

  it("a real 3xx on the board call is a retryable provisioner_failed: exactly one request, the redirect target (and the admin bearer) never reached", async () => {
    const { base, hits } = await redirectingServer();
    const out = await registerCommsBoardAgent({ ...clientConfig, boardMcpUrl: `${base}/start` }, { boardSub: "s::k", displayName: "d", ownerEmail: "o@x.test" });
    expect(out).toEqual({ ok: false, reason: "provisioner_failed", retryable: true });
    expect(hits.map((h) => h.path)).toEqual(["/start"]);
  });

  it("a real 3xx on the mint call is an unknown outcome with a single POST (no re-POST, no follow)", async () => {
    const { base, hits } = await redirectingServer();
    const out = await mintCommsBoardCredential({ ...clientConfig, ownershipApiUrl: base }, { baseSub: "paperclip-agent-1", ownerEmail: "o@x.test" });
    expect(out).toEqual({ ok: false, reason: "mint_unknown" });
    expect(hits.map((h) => h.path)).toEqual(["/agents"]);
  });
});

describe("mint response contract (sub, active, owner_email, token)", () => {
  const request = { baseSub: "paperclip-agent-abc-123", ownerEmail: "Owner@RedesignHealth.com" };
  const reply = (over: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({
    sub: request.baseSub, owner_email: "owner@redesignhealth.com", active: true, token: "tok", token_expires_at: null, ...over,
  }), { status: 201, headers: { "content-type": "application/json" } }));

  it("accepts an exact-sub, active, case-insensitively owner-matched reply; a null expiry is legitimate", async () => {
    expect(await mintCommsBoardCredential(clientConfig, request, reply({}))).toEqual({ ok: true, boardToken: "tok", tokenExpiresAt: null });
  });

  it.each([
    ["missing sub", { sub: undefined }],
    ["wrong sub", { sub: "paperclip-agent-other" }],
    ["composed (::) sub", { sub: "paperclip-agent-abc-123::key" }],
    ["inactive", { active: false }],
    ["missing active", { active: undefined }],
    ["active as a string", { active: "true" }],
    ["missing owner_email", { owner_email: undefined }],
    ["different owner_email", { owner_email: "someone@redesignhealth.com" }],
    ["non-string owner_email", { owner_email: 7 }],
    ["empty token", { token: "" }],
    ["non-string token", { token: 5 }],
  ])("%s is an unknown outcome", async (_label, over) => {
    const fetchImpl = reply(over);
    expect(await mintCommsBoardCredential(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "mint_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("argus-review spec (TECH-7792)", () => {
  it("is an opt-in, non-dedicated shared-token entry limited to the three review verbs; the personal ceiling also lists them but never argus_get_proxy_token here", () => {
    const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "argus-review")!;
    expect(entry).toMatchObject({ connectionName: "rh-mcp-argus-review", authKind: "managed_token", defaultEnabled: false });
    expect(entry.setupHook).toBeUndefined();
    expect(entry.templateBootstrap).toBeUndefined();
    expect(entry.installByDefault).toBeUndefined();
    expect([...entry.reviewedTools!.allow].sort()).toEqual(["argus_cancel_review", "argus_get_review", "argus_start_review"]);
    expect(ARGUS_REVIEW_REVIEWED_TOOLS_VERSION).toBe(1);
    expect(Object.isFrozen(ARGUS_REVIEW_REVIEWED_TOOLS)).toBe(true);
    expect(entry.reviewedTools!.allow).toBe(ARGUS_REVIEW_REVIEWED_TOOLS);
    const personal = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-mcp")!;
    // Operator decision: the personal rh-mcp ceiling also offers the three review verbs to an agent given that connection.
    for (const tool of entry.reviewedTools!.allow) expect(personal.readCeiling).toContain(tool);
    // The credential-minting verb stays out of the shared-token entry.
    expect(entry.reviewedTools!.allow).not.toContain("argus_get_proxy_token");
  });
});

describe("per-tool timeout (argus-review)", () => {
  it("resolves the three argus tools to 30 s on the argus connection", () => {
    expect(ARGUS_REVIEW_TOOL_TIMEOUT_MS).toBe(30_000);
    for (const tool of ["argus_start_review", "argus_get_review", "argus_cancel_review"]) {
      expect(defaultToolTimeoutMs("rh-mcp-argus-review", tool)).toBe(30_000);
    }
  });

  it("resolves the three comps verbs to 30 s on the rh-mcp-service connection only (TECH-8433)", () => {
    expect(COMPS_TOOL_TIMEOUT_MS).toBe(ARGUS_REVIEW_TOOL_TIMEOUT_MS);
    for (const tool of ["comps__start", "comps__get", "comps__cancel"]) {
      expect(defaultToolTimeoutMs("rh-mcp-service", tool)).toBe(30_000);
      expect(defaultToolTimeoutMs("rh-mcp", tool)).toBeUndefined();
    }
    for (const tool of ["argus_start_review", "argus_get_review", "argus_cancel_review"]) {
      expect(defaultToolTimeoutMs("rh-mcp-service", tool)).toBe(30_000);
    }
    // The blocking one-call tool and unrelated tools keep the gateway default.
    expect(defaultToolTimeoutMs("rh-mcp-service", "comps__run_business_area_comps")).toBeUndefined();
    expect(defaultToolTimeoutMs("rh-mcp-service", "mdm_get_person")).toBeUndefined();
  });

  it("gives voice_apply the 60 s gateway ceiling on the service entry AND the personal OAuth entry, clones included", () => {
    const agentId = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    expect(VOICE_APPLY_TOOL_TIMEOUT_MS).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(defaultToolTimeoutMs("rh-mcp-service", "voice_apply")).toBe(60_000);
    expect(defaultToolTimeoutMs("rh-mcp-personal", "voice_apply")).toBe(60_000);
    expect(defaultToolTimeoutMs(`rh-mcp-personal:${agentId}`, "voice_apply")).toBe(60_000);
    // The checklist read and other personal tools keep the gateway default.
    expect(defaultToolTimeoutMs("rh-mcp-service", "voice_get_humanizer_checklist")).toBeUndefined();
    expect(defaultToolTimeoutMs("rh-mcp-personal", "mdm_get_granola_note")).toBeUndefined();
  });

  it("gives decisions_run_grid the 60 s gateway ceiling on the service entry (TECH-9109)", () => {
    expect(DECISIONS_GRID_TOOL_TIMEOUT_MS).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(defaultToolTimeoutMs("rh-mcp-service", "decisions_run_grid")).toBe(60_000);
    expect(defaultToolTimeoutMs("rh-mcp-personal", "decisions_run_grid")).toBeUndefined();
  });

  it("leaves every other tool and connection on the gateway default (undefined)", () => {
    expect(defaultToolTimeoutMs("rh-mcp-argus-review", "argus_get_proxy_token")).toBeUndefined();
    expect(defaultToolTimeoutMs("rh-mcp-argus-review", "toString")).toBeUndefined();
    expect(defaultToolTimeoutMs("rh-mcp", "argus_start_review")).toBeUndefined();
    expect(defaultToolTimeoutMs("some-other-connection", "argus_start_review")).toBeUndefined();
    for (const entry of DEFAULT_MCP_SPEC.filter((candidate) => !["argus-review", "rh-mcp-service", "agent-memory-tools", "rh-mcp"].includes(candidate.key))) {
      expect(entry.toolTimeoutMs).toBeUndefined();
    }
  });

  it("gives the memory tools budgets above a cold memory_add (TECH-8832)", () => {
    expect(AGENT_MEMORY_TOOL_TIMEOUT_MS).toEqual({ memory_add: 45_000, memory_delete: 20_000, memory_search: 15_000 });
    const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "agent-memory-tools")!;
    expect(Object.keys(entry.toolTimeoutMs ?? {}).sort()).toEqual([...entry.reviewedTools!.allow].sort());
    expect(defaultToolTimeoutMs("rh-agent-memory-tools", "memory_add")).toBe(45_000);
    expect(defaultToolTimeoutMs("rh-agent-memory-tools", "memory_delete")).toBe(20_000);
    expect(defaultToolTimeoutMs("rh-agent-memory-tools", "memory_search")).toBe(15_000);
    expect(defaultToolTimeoutMs("rh-agent-memory-tools", "memory_purge_agent")).toBeUndefined();
  });

  it("resolves the per-agent clone `<template>:<agent uuid>` to its entry's timeouts", () => {
    const agentId = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    expect(defaultToolTimeoutMs(`rh-agent-memory-tools:${agentId}`, "memory_add")).toBe(45_000);
    expect(defaultToolTimeoutMs(`rh-agent-memory-tools:${agentId.toUpperCase()}`, "memory_search")).toBe(15_000);
    // Only a uuid suffix maps back; anything else, and unrelated connections, keep the gateway default.
    expect(defaultToolTimeoutMs("rh-agent-memory-tools:not-a-uuid", "memory_add")).toBeUndefined();
    expect(defaultToolTimeoutMs(`some-other-connection:${agentId}`, "memory_add")).toBeUndefined();
    expect(defaultToolTimeoutMs(`rh-mcp-argus-review:${agentId}`, "argus_start_review")).toBe(30_000);
  });

  it("clamps values above 60 s, and ignores non-finite values", () => {
    const spec = [{ key: "x", displayName: "X", connectionName: "c", authKind: "managed_token", defaultEnabled: false, toolTimeoutMs: { big: 120_000, nan: Number.NaN, ok: 5_000 } }] as never;
    expect(MAX_TOOL_TIMEOUT_MS).toBe(60_000);
    expect(defaultToolTimeoutMs("c", "big", spec)).toBe(60_000);
    expect(defaultToolTimeoutMs("c", "ok", spec)).toBe(5_000);
    expect(defaultToolTimeoutMs("c", "nan", spec)).toBeUndefined();
  });
});

describe("rh-mcp-service reviewed tools: comps:run (TECH-8433) and decisions:run (TECH-9109)", () => {
  it("offers voice_apply under the existing voice:read scope (no new scope)", () => {
    const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-mcp-service")!;
    expect(RH_MCP_SERVICE_TOOLS_BY_SCOPE["voice:read"]).toEqual(["voice_get_humanizer_checklist", "voice_apply"]);
    expect(entry.reviewedTools!.allow).toContain("voice_apply");
  });

  it("offers exactly the async comps verbs under the comps:run scope", () => {
    const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-mcp-service")!;
    expect(RH_MCP_SERVICE_TOOLS_BY_SCOPE["comps:run"]).toEqual(["comps__start", "comps__get", "comps__cancel"]);
    for (const tool of ["comps__start", "comps__get", "comps__cancel"]) expect(entry.reviewedTools!.allow).toContain(tool);
    expect(entry.reviewedTools!.allow).not.toContain("comps__run_business_area_comps");
  });

  it("offers decisions_run_grid under the decisions:run scope at reviewed-tools version 4 (TECH-9109)", () => {
    const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-mcp-service")!;
    expect(entry.reviewedTools!.version).toBe(4);
    expect(RH_MCP_SERVICE_TOKEN_SCOPES_VERSION).toBe(2);
    expect(RH_MCP_SERVICE_TOOLS_BY_SCOPE["decisions:run"]).toEqual(["decisions_run_grid"]);
    expect(entry.reviewedTools!.allow).toContain("decisions_run_grid");
  });
});

describe("arcana-brain spec: default ON (TECH-7253)", () => {
  it("is the only default-ON entry, is dedicated, and keeps its reviewed five-verb allowlist", () => {
    const arcana = DEFAULT_MCP_SPEC.find((entry) => entry.key === "arcana-brain")!;
    expect(arcana.defaultEnabled).toBe(true);
    expect(arcana.setupHook).toBe("arcana_brain");
    expect(arcana.templateBootstrap).toBe("static");
    expect(arcana.reviewedTools?.allow).toEqual(["recall", "search_pages", "read_page", "coverage", "open_source"]);
    expect(DEFAULT_MCP_SPEC.filter((entry) => entry.defaultEnabled).map((entry) => entry.key)).toEqual(["arcana-brain", "rh-mcp-service"]);
  });
});

describe("comms board spec: template bootstrap + reviewed allowlist (TECH-7271)", () => {
  it("the comms entry bootstraps its template with exactly the 17 reviewed tools (version 2)", () => {
    const comms = DEFAULT_MCP_SPEC.find((entry) => entry.key === "comms-board")!;
    expect(comms.templateBootstrap).toBe(true);
    expect(comms.defaultEnabled).toBe(false);
    expect(comms.reviewedTools).toEqual({
      version: 2,
      allow: [
        "comms_whoami",
        "comms_list_agents",
        "comms_lookup_agent_by_email",
        "comms_list_conversations",
        "comms_get_conversation",
        "comms_inbox",
        "comms_get_hold_status",
        "comms_start_conversation",
        "comms_post_message",
        "comms_accept",
        "comms_decline_invite",
        "comms_invite",
        "comms_rename_conversation",
        "comms_leave",
        "comms_extend_conversation",
        "proposals_submit",
        "proposals_get",
      ],
    });
    expect(Object.isFrozen(COMMS_BOARD_REVIEWED_TOOLS)).toBe(true);
    for (const forbidden of [
      "comms_register",
      "comms_admin_register",
      "comms_deregister_agent",
      "comms_set_agent_shared",
      "comms_archive_conversation",
      "comms_reopen_conversation",
      "proposals_list_pending",
      "proposals_list_history",
      "proposals_withdraw",
    ]) {
      expect(comms.reviewedTools!.allow).not.toContain(forbidden);
    }
    // Only the comms entry bootstraps via discovery (`true`); the arcana-brain entry is `"static"` and the Google entry is untouched.
    expect(DEFAULT_MCP_SPEC.filter((entry) => entry.templateBootstrap === true).map((entry) => entry.key)).toEqual(["comms-board"]);
  });

  it("managed markers: only the exact server values classify, and public payloads are stripped of them", () => {
    expect(isManagedTemplate({ defaultMcpManaged: "template" })).toBe(true);
    expect(isManagedTemplate({ defaultMcpManaged: "dedicated" })).toBe(false);
    expect(isManagedDedicated({ defaultMcpManaged: "dedicated" })).toBe(true);
    for (const config of [null, undefined, [], "template", { defaultMcpManaged: true }, { defaultMcpManaged: "Template" }, {}]) {
      expect(isManagedTemplate(config)).toBe(false);
      expect(isManagedDedicated(config)).toBe(false);
    }
    const input = { url: "https://x", defaultMcpManaged: "template", defaultMcpTemplate: { state: "ready" }, quarantineNewEntries: true };
    expect(stripDefaultMcpProtectedConfigKeys(input)).toEqual({ url: "https://x", quarantineNewEntries: true });
    expect(input.defaultMcpManaged).toBe("template"); // pure: the input is never mutated
    expect(DEFAULT_MCP_TEMPLATE_UID).toBe("rh-comms-board/default-mcp-template");
  });

  it("the claim reader accepts only a structurally valid, versioned claim and fails closed otherwise", () => {
    const claim = {
      version: 1,
      entryKey: "comms-board",
      principalSub: "paperclip-company-template-0b2c7c1e-4f0a-4a4e-9b3e-0d6f0a3c9a11",
      ownerUserId: "user-1",
      ownerEmailNorm: "owner@redesignhealth.com",
      state: "ready",
      reason: null,
      attemptCount: 1,
      nextAttemptAt: null,
      leaseUntil: null,
      claimId: null,
      mintAttemptedAt: "2026-10-07T00:00:00.000Z",
      secretId: "s1",
      tokenExpiresAt: "2027-10-07T00:00:00+00:00",
      allowlistVersion: 1,
      readyAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    expect(readTemplateClaim({ defaultMcpTemplate: claim })).toEqual(claim);
    // Every legitimate state keeps validating (pending/retry carries nulls and a bounded attempt count).
    for (const state of ["pending", "in_progress", "error"]) expect(readTemplateClaim({ defaultMcpTemplate: { ...claim, state, secretId: null, mintAttemptedAt: null, tokenExpiresAt: null, allowlistVersion: null, readyAt: null } })).not.toBeNull();
    const broken = (patch: Record<string, unknown>) => readTemplateClaim({ defaultMcpTemplate: { ...claim, ...patch } });
    for (const bad of [null, undefined, [], { defaultMcpTemplate: null }, { defaultMcpTemplate: [] }, { defaultMcpTemplate: { version: 1, state: "ready", entryKey: "comms-board" } }]) {
      expect(readTemplateClaim(bad)).toBeNull();
    }
    expect(broken({ version: 2 })).toBeNull();
    expect(broken({ state: "bogus" })).toBeNull();
    for (const field of ["entryKey", "principalSub", "ownerUserId", "ownerEmailNorm"]) {
      expect(broken({ [field]: undefined }), field).toBeNull();
      expect(broken({ [field]: "" }), field).toBeNull();
      expect(broken({ [field]: 7 }), field).toBeNull();
    }
    expect(broken({ attemptCount: "1" })).toBeNull();
    expect(broken({ attemptCount: null })).toBeNull();
    for (const field of ["secretId", "claimId", "leaseUntil", "nextAttemptAt", "mintAttemptedAt", "tokenExpiresAt", "readyAt", "reason"]) {
      expect(broken({ [field]: 5 }), field).toBeNull();
    }
    expect(broken({ allowlistVersion: "1" })).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1.5]) {
      expect(broken({ allowlistVersion: bad }), `allowlistVersion ${bad}`).toBeNull();
    }
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null, undefined]) {
      expect(broken({ attemptCount: bad }), `attemptCount ${String(bad)}`).toBeNull();
    }
    expect(broken({ attemptCount: 0 })).not.toBeNull();
    for (const bad of [undefined, null, "", 5]) expect(broken({ updatedAt: bad }), `updatedAt ${String(bad)}`).toBeNull();
  });

  it("installAppliesToAgent is ALWAYS false for the managed template, whatever the agent state or install target", () => {
    const connection = { id: "c1", companyId: "co", name: "rh-comms-board", config: { defaultMcpManaged: "template" } };
    for (const targetType of ["company", "agent"]) {
      expect(installAppliesToAgent({ targetType }, { companyId: "co", state: null }, connection)).toBe(false);
      expect(installAppliesToAgent({ targetType }, { companyId: "co", state: { version: 1, entries: {} } }, connection)).toBe(false);
    }
    // Control: without the marker (or without config at all) the legacy rule is unchanged.
    expect(installAppliesToAgent({ targetType: "company" }, { companyId: "co", state: null }, { ...connection, config: {} })).toBe(true);
    expect(installAppliesToAgent({ targetType: "company" }, { companyId: "co", state: null }, { id: "c1", companyId: "co", name: "x" })).toBe(true);
  });
});

describe("company template credential mint (TECH-7271)", () => {
  const companyId = "0b2c7c1e-4f0a-4a4e-9b3e-0d6f0a3c9a11";
  const baseSub = `paperclip-company-template-${companyId}`;

  it("composes a 63-character '::'-free subject only from a canonical company UUID", () => {
    expect(composeTemplateSub(companyId)).toBe(baseSub);
    expect(composeTemplateSub(companyId.toUpperCase())).toBe(baseSub);
    expect(baseSub).toHaveLength(63);
    for (const bad of ["", "not-a-uuid", `${companyId}::x`, `${companyId} `, "../etc"]) expect(composeTemplateSub(bad)).toBeNull();
  });

  it("sends comms:read ONLY for 365 days with the ownership token, and never an admin or ownership scope", async () => {
    expect(COMMS_BOARD_TEMPLATE_TOKEN_SCOPES).toEqual(["comms:read"]);
    const fetchImpl = downstreamFetch();
    const out = await mintCommsBoardTemplateCredential(clientConfig, { companyId, ownerEmail: "owner@redesignhealth.com" }, fetchImpl);
    expect(out).toEqual({ ok: true, boardToken: BOARD_TOKEN, tokenExpiresAt: "2027-03-01T00:00:00+00:00" });
    expect(fetchImpl.calls.mint).toEqual([{ sub: baseSub, scopes: ["comms:read"], expires: 365 }]);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(["expires_in_days", "owner_email", "scopes", "sub"]);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${OWNERSHIP_TOKEN}`);
    expect(String(init.body)).not.toMatch(/comms:write|comms:admin|ownership:/);
    // The per-bot mint is unchanged: read + write.
    const bot = downstreamFetch();
    await mintCommsBoardCredential(clientConfig, { baseSub: "paperclip-agent-abc", ownerEmail: "owner@redesignhealth.com" }, bot);
    expect(bot.calls.mint[0]!.scopes).toEqual([...COMMS_BOARD_TOKEN_SCOPES]);
  });

  it("refuses a malformed company id locally with no call", async () => {
    const fetchImpl = vi.fn();
    expect(await mintCommsBoardTemplateCredential(clientConfig, { companyId: "nope", ownerEmail: "o@x.com" }, fetchImpl)).toEqual({ ok: false, reason: "invalid_subject" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["400", () => ownershipResponse("s", {}, 400), { ok: false, reason: "ownership_failed", noRowCreated: true }],
    ["401", () => ownershipResponse("s", {}, 401), { ok: false, reason: "ownership_rejected", noRowCreated: true }],
    ["403", () => ownershipResponse("s", {}, 403), { ok: false, reason: "ownership_rejected", noRowCreated: true }],
    ["422", () => ownershipResponse("s", {}, 422), { ok: false, reason: "ownership_failed", noRowCreated: true }],
    // Everything else may have created a row (or conflicts with one): never flagged as safe to retry.
    ["409", () => ownershipResponse("s", {}, 409), { ok: false, reason: "ownership_conflict" }],
    ["500", () => ownershipResponse("s", {}, 500), { ok: false, reason: "mint_unknown" }],
    ["502", () => ownershipResponse("s", {}, 502), { ok: false, reason: "mint_unknown" }],
    ["200", () => ownershipResponse("s", {}, 200), { ok: false, reason: "mint_unknown" }],
    ["non-JSON 201", () => new Response("<html>", { status: 201 }), { ok: false, reason: "mint_unknown" }],
    ["sub mismatch", () => ownershipResponse(baseSub, { sub: "other" }), { ok: false, reason: "mint_unknown" }],
    ["inactive", () => ownershipResponse(baseSub, { active: false }), { ok: false, reason: "mint_unknown" }],
    ["owner mismatch", () => ownershipResponse(baseSub, { owner_email: "someone-else@x.com" }), { ok: false, reason: "mint_unknown" }],
    ["empty token", () => ownershipResponse(baseSub, { token: "" }), { ok: false, reason: "mint_unknown" }],
  ])("%s -> %j", async (_label, respond, expected) => {
    const fetchImpl = vi.fn(async () => respond());
    const out = await mintCommsBoardTemplateCredential(clientConfig, { companyId, ownerEmail: "owner@redesignhealth.com" }, fetchImpl);
    expect(out).toEqual(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a network failure is an unknown outcome (never noRowCreated) and is not retried", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    expect(await mintCommsBoardTemplateCredential(clientConfig, { companyId, ownerEmail: "o@x.com" }, fetchImpl)).toEqual({ ok: false, reason: "mint_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the legacy per-bot mint never exposes the template-only flag", async () => {
    const fetchImpl = vi.fn(async () => ownershipResponse("s", {}, 401));
    expect(await mintCommsBoardCredential(clientConfig, { baseSub: "paperclip-agent-abc", ownerEmail: "o@x.com" }, fetchImpl)).toEqual({ ok: false, reason: "ownership_rejected" });
  });
});

describe("rh-mcp personal default entry and agent read ceiling (TECH-7276)", () => {
  const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-mcp")!;
  const CEILING = [
    "mdm_granola_status",
    "mdm_list_my_granola_notes",
    "mdm_list_shared_granola_notes",
    "mdm_get_granola_note",
    "mdm_get_granola_transcript",
    "argus_get_proxy_token",
    "argus_start_review",
    "argus_get_review",
    "argus_cancel_review",
    "zoom__get_transcript",
    "zoom__get_meeting_transcript",
    "zoom__get_meeting",
    "zoom__list_my_meetings",
    "voice_apply",
  ];
  const valid = {
    name: "rh-mcp-personal",
    transport: "mcp_remote",
    authKind: "oauth",
    credentialPolicy: "per_user",
    config: { url: "https://mcp.example.test/mcp", identityModel: "personal_only", paperclipDefaultMcpEntry: "rh-mcp" },
  };

  it("is one OFF, hook-less oauth entry with exactly the fourteen raw tools (read tools, the three Argus review verbs and voice_apply) as its ceiling", () => {
    expect(entry).toMatchObject({
      displayName: "RH MCP",
      connectionName: "rh-mcp-personal",
      authKind: "oauth",
      defaultEnabled: false,
      templateRequirements: { identityModel: "personal_only" },
    });
    expect(entry.setupHook).toBeUndefined();
    expect([...entry.readCeiling!].sort()).toEqual([...CEILING].sort());
    // No writer, disconnect, visibility, reassign, erase, annotation, meeting-mutating zoom, or voice action is ever reachable by an agent, except the read-scoped voice_apply.
    for (const name of entry.readCeiling!) {
      expect(name).toMatch(/^(mdm_(granola_status|list_my_granola_notes|list_shared_granola_notes|get_granola_note|get_granola_transcript)|argus_(get_proxy_token|start_review|get_review|cancel_review)|voice_apply|zoom__(get_transcript|get_meeting_transcript|get_meeting|list_my_meetings))$/);
      expect(name).not.toMatch(/disconnect|visibility|reassign|erase|annotation|write|set_|request_/);
      if (name.startsWith("voice")) expect(name).toBe("voice_apply");
      // Positive allowlist for zoom__, not just a negative ban on known mutators: a future
      // zoom__update_meeting or zoom__end_meeting must fail this too, not just create/delete.
      if (name.startsWith("zoom__")) {
        expect(name).toMatch(/^zoom__(get_transcript|get_meeting_transcript|get_meeting|list_my_meetings)$/);
      }
    }
  });

  it("only the personal entry declares a ceiling; the legacy Group A and Group B entries are unchanged", () => {
    expect(DEFAULT_MCP_SPEC.filter((candidate) => candidate.readCeiling).map((candidate) => candidate.key)).toEqual(["rh-mcp"]);
    expect(DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "comms-board")).toMatchObject({
      connectionName: "rh-comms-board",
      authKind: "managed_token",
      setupHook: "comms_board_identity",
    });
    expect(DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-google-mcp")).toMatchObject({ connectionName: "rh-google-mcp", authKind: "oauth" });
    expect(isValidDefaultMcpTemplate(DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-google-mcp")!, { ...valid, name: "rh-google-mcp", config: {} })).toBe(true);
  });

  it("accepts a template only when name, transport, auth, policy, identity model and tag ALL match", () => {
    expect(isValidDefaultMcpTemplate(entry, valid)).toBe(true);
    expect(isPersonalDefaultMcpTemplate(valid)).toBe(true);
    const variants: Array<[string, Record<string, unknown>]> = [
      ["wrong name", { name: "rh-mcp" }],
      ["rest transport", { transport: "rest_api" }],
      ["api_key auth", { authKind: "api_key" }],
      ["shared policy", { credentialPolicy: "shared" }],
      ["fallback policy", { credentialPolicy: "per_user_with_fallback" }],
      ["no identity model", { config: { paperclipDefaultMcpEntry: "rh-mcp" } }],
      ["company identity model", { config: { identityModel: "company_or_personal", paperclipDefaultMcpEntry: "rh-mcp" } }],
      ["no tag", { config: { identityModel: "personal_only" } }],
      ["another entry's tag", { config: { identityModel: "personal_only", paperclipDefaultMcpEntry: "rh-google-mcp" } }],
      ["null config", { config: null }],
      ["array config", { config: [] }],
    ];
    for (const [label, over] of variants) {
      const connection = { ...valid, ...over };
      expect(isValidDefaultMcpTemplate(entry, connection), label).toBe(false);
      expect(isPersonalDefaultMcpTemplate(connection), label).toBe(false);
      expect(agentReadCeilingForConnection(connection), label).toBeNull();
    }
  });

  it("caps a valid tagged template to the fourteen raw names and nothing else; the name alone never caps", () => {
    expect([...agentReadCeilingForConnection(valid)!].sort()).toEqual([...CEILING].sort());
    for (const name of CEILING) expect(agentMayUseConnectionTool(valid, name)).toBe(true);
    for (const name of [
      "mdm_disconnect_granola",
      "mdm_erase_granola_note",
      "mdm_set_granola_note_visibility",
      "mdm_set_granola_transcript_visibility",
      "mdm_reassign_granola_notes",
      "mdm_write_annotation",
      "zoom__create_meeting",
      "zoom__delete_meeting",
      "voice_save_style_guide",
      "mdm.rh-mcp-personal-abcd1234:mdm_get_granola_note",
      "",
      null,
      undefined,
    ]) {
      expect(agentMayUseConnectionTool(valid, name as never), String(name)).toBe(false);
    }
    // A same-named but untagged / non-personal connection is an ordinary one: nothing is capped.
    const untagged = { ...valid, config: { identityModel: "personal_only" } };
    expect(agentMayUseConnectionTool(untagged, "mdm_erase_granola_note")).toBe(true);
    expect(agentMayUseConnectionTool({ ...valid, name: "rh-comms-board", config: {}, credentialPolicy: "shared" }, "comms_post_message")).toBe(true);
    expect(agentMayUseConnectionTool({ ...valid, name: "service-rh-mcp" }, "mdm_erase_granola_note")).toBe(true);
  });

  it("TECH-7276: assertPersonalDefaultMcpTemplateUpdateValid rejects classification-breaking updates for valid templates, permits benign updates, and ignores non-templates", () => {
    // Benign updates pass without error
    expect(() => assertPersonalDefaultMcpTemplateUpdateValid(valid, valid)).not.toThrow();
    expect(() =>
      assertPersonalDefaultMcpTemplateUpdateValid(valid, {
        ...valid,
        config: { ...valid.config, url: "https://new-url.example/mcp" },
      }),
    ).not.toThrow();

    // Classification-breaking updates throw badRequest
    const breaking: Array<[string, Record<string, unknown>]> = [
      ["rename", { name: "rh-mcp-renamed" }],
      ["transport", { transport: "local_stdio" }],
      ["authKind", { authKind: "api_key" }],
      ["credentialPolicy", { credentialPolicy: "shared" }],
      ["credentialPolicy fallback", { credentialPolicy: "per_user_with_fallback" }],
      ["identityModel", { config: { ...valid.config, identityModel: "company_or_personal" } }],
      ["tag", { config: { ...valid.config, paperclipDefaultMcpEntry: "other" } }],
    ];
    for (const [label, over] of breaking) {
      expect(
        () => assertPersonalDefaultMcpTemplateUpdateValid(valid, { ...valid, ...over }),
        label,
      ).toThrow(/Personal default-MCP template.*immutable/i);
    }

    // Non-template connections (e.g. untagged or different name) pass without error even if fields change
    const nonTemplate = { ...valid, config: { url: "https://example.com" } }; // no tag
    expect(() =>
      assertPersonalDefaultMcpTemplateUpdateValid(nonTemplate, { ...nonTemplate, name: "renamed", credentialPolicy: "shared" }),
    ).not.toThrow();
  });
});

describe("discovery-only seeds and strict personal instances (TECH-7340)", () => {
  const CO = "11111111-1111-4111-8111-111111111111";
  const seedConfig = { defaultMcpManaged: "seed", paperclipDefaultMcpEntry: "rh-google-mcp" };
  const personalConfig = {
    defaultMcpManaged: "personal",
    paperclipDefaultMcpEntry: "rh-mcp",
    identityModel: "personal_only",
    url: "https://rh-mcp.drum-mackarel.ts.net/mcp",
  };
  const personalInstance = {
    name: "RH MCP",
    transport: "mcp_remote",
    authKind: "oauth",
    credentialPolicy: "per_user",
    config: personalConfig,
  };
  const entry = (over: Record<string, unknown>) => ({
    connectionId: null,
    templateConnectionId: null,
    templateKey: null,
    dedicated: false,
    ...over,
  });
  const state = (entries: Record<string, unknown>) => ({
    version: 1,
    entries: entries as never,
  });

  it("the spec seeds both OAuth entries and nothing else, with the authoritative URL env keys", () => {
    const seeded = DEFAULT_MCP_SPEC.filter((candidate) => candidate.oauthSeed);
    expect(seeded.map((candidate) => candidate.key)).toEqual(["rh-google-mcp", "rh-mcp"]);
    expect(DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-google-mcp")!.oauthSeed).toEqual({
      urlEnv: "PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL",
    });
    expect(DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-mcp")!.oauthSeed).toEqual({
      urlEnv: "PAPERCLIP_DEFAULT_MCP_RH_MCP_URL",
    });
  });

  it("isDefaultMcpSeed reads only the TOP-LEVEL marker: a forged nested config.config marker is not a seed", () => {
    expect(isDefaultMcpSeed(seedConfig)).toBe(true);
    // B3+S1: a nested-only marker is a forged shape, never a seed/template classification.
    expect(isDefaultMcpSeed({ config: { ...seedConfig } })).toBe(false);
    expect(isDefaultMcpSeed({ config: { defaultMcpManaged: "template" } })).toBe(false);
    expect(isDefaultMcpSeed({ config: { defaultMcpManaged: "personal" } })).toBe(false);
    expect(isDefaultMcpSeed({ defaultMcpManaged: "template" })).toBe(false);
    expect(isDefaultMcpSeed({ defaultMcpManaged: "dedicated" })).toBe(false);
    expect(isDefaultMcpSeed({ defaultMcpManaged: "personal" })).toBe(false);
    expect(isDefaultMcpSeed(personalConfig)).toBe(false);
    expect(isDefaultMcpSeed({})).toBe(false);
    expect(isDefaultMcpSeed(null)).toBe(false);
    expect(isDefaultMcpSeed([seedConfig])).toBe(false);
    expect(isDefaultMcpSeed("seed")).toBe(false);
  });

  it("isPersonalDefaultMcpInstance requires every strict fact; each violation alone disqualifies", () => {
    expect(isPersonalDefaultMcpInstance(personalInstance)).toBe(true);
    const variants: Array<[string, Record<string, unknown>]> = [
      ["managed marker not personal", { config: { ...personalConfig, defaultMcpManaged: "seed" } }],
      ["rest transport", { transport: "rest_api" }],
      ["api_key auth", { authKind: "api_key" }],
      ["shared policy", { credentialPolicy: "shared" }],
      ["company identity model", { config: { ...personalConfig, identityModel: "company_or_personal" } }],
      ["no tag", { config: { ...personalConfig, paperclipDefaultMcpEntry: undefined } }],
      ["empty tag", { config: { ...personalConfig, paperclipDefaultMcpEntry: "" } }],
      ["non-string tag", { config: { ...personalConfig, paperclipDefaultMcpEntry: 7 } }],
      ["tag outside the spec", { config: { ...personalConfig, paperclipDefaultMcpEntry: "rh-not-an-entry" } }],
      ["tag of a managed-token entry", { config: { ...personalConfig, paperclipDefaultMcpEntry: "comms-board" } }],
      ["null config", { config: null }],
      ["array config", { config: [] }],
    ];
    for (const [label, over] of variants) {
      expect(isPersonalDefaultMcpInstance({ ...personalInstance, ...over })).toBe(false);
    }
    expect(isPersonalDefaultMcpInstance(null)).toBe(false);
  });

  it("isProtectedPersonalDefaultMcpMarker: only a top-level personal managed marker plus a non-empty string entry tag classifies", () => {
    // Positive: the real stored personal config (tagged with a real spec entry key) and the
    // minimal partial-identity marker shape the managedConnectionRole path relies on —
    // a valid managed personal entry is the protected marker.
    expect(isProtectedPersonalDefaultMcpMarker(personalConfig)).toBe(true);
    expect(isProtectedPersonalDefaultMcpMarker({ defaultMcpManaged: "personal", paperclipDefaultMcpEntry: "rh-mcp" })).toBe(true);
    const negatives: Array<[string, unknown]> = [
      ["null config", null],
      ["undefined config", undefined],
      ["personal marker without a tag", { defaultMcpManaged: "personal" }],
      ["personal marker with an empty tag", { defaultMcpManaged: "personal", paperclipDefaultMcpEntry: "" }],
      ["personal marker with a non-string tag", { defaultMcpManaged: "personal", paperclipDefaultMcpEntry: 7 }],
      ["personal marker with a boolean tag", { defaultMcpManaged: "personal", paperclipDefaultMcpEntry: true }],
      ["personal marker with an array tag", { defaultMcpManaged: "personal", paperclipDefaultMcpEntry: ["rh-mcp"] }],
      ["seed marker (non-personal managed)", seedConfig],
      ["template marker (non-personal managed)", { defaultMcpManaged: "template", paperclipDefaultMcpEntry: "rh-mcp" }],
      ["dedicated marker (non-personal managed)", { defaultMcpManaged: "dedicated", paperclipDefaultMcpEntry: "rh-mcp" }],
      ["tag without any managed marker", { paperclipDefaultMcpEntry: "rh-mcp" }],
      ["nested-only personal marker forge", { config: { ...personalConfig } }],
      ["array config", [{ ...personalConfig }]],
      ["string config", "personal"],
      ["a full connection row (the marker lives on its config, not the row)", personalInstance],
    ];
    for (const [label, config] of negatives) {
      expect(isProtectedPersonalDefaultMcpMarker(config), label).toBe(false);
    }
  });

  it("isPersonalDefaultMcpTemplate includes a strict personal instance, and the read ceiling applies to it", () => {
    expect(isPersonalDefaultMcpTemplate(personalInstance)).toBe(true);
    // The rh-mcp ceiling is exactly the fourteen Granola/Argus/Zoom/voice_apply tools for a personal instance too.
    const ceiling = agentReadCeilingForConnection(personalInstance);
    expect(ceiling).not.toBeNull();
    expect([...ceiling!].sort()).toEqual([
      "argus_cancel_review",
      "argus_get_proxy_token",
      "argus_get_review",
      "argus_start_review",
      "mdm_get_granola_note",
      "mdm_get_granola_transcript",
      "mdm_granola_status",
      "mdm_list_my_granola_notes",
      "mdm_list_shared_granola_notes",
      "voice_apply",
      "zoom__get_meeting",
      "zoom__get_meeting_transcript",
      "zoom__get_transcript",
      "zoom__list_my_meetings",
    ]);
    // A personal instance of the GOOGLE entry (no read ceiling) gets no ceiling.
    const googleInstance = {
      ...personalInstance,
      config: { ...personalConfig, paperclipDefaultMcpEntry: "rh-google-mcp" },
    };
    expect(agentReadCeilingForConnection(googleInstance)).toBeNull();
    // The instance ceiling is matched by its strict facts, never its display name:
    // a renamed instance keeps it, and a same-shaped row that is NOT an instance
    // (no managed marker) gets nothing even with a template-like name.
    expect(agentReadCeilingForConnection({ ...personalInstance, name: "renamed-by-owner" })).not.toBeNull();
    // (A same-shaped row NAMED like the template is a valid TECH-7276 template and keeps
    // the ceiling through that path — covered by the TECH-7276 suite above.)
    expect(
      agentReadCeilingForConnection({
        name: "operator-mcp",
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "per_user",
        config: { url: personalConfig.url, identityModel: "personal_only", paperclipDefaultMcpEntry: "rh-mcp" },
      }),
    ).toBeNull();
  });

  it("managedConnectionRole: a seed is forbidden for every agent state; a tagged personal instance is managed by its entry", () => {
    const metadata = state({
      google: entry({ key: "rh-google-mcp", templateKey: "rh-google-mcp", connectionId: "manual-google" }),
      rh: entry({ key: "rh-mcp", templateKey: "rh-mcp-personal", connectionId: "manual-rh" }),
    });
    const seed = { id: "seed-1", companyId: CO, name: "RH Google MCP", config: seedConfig };
    expect(managedConnectionRole(metadata, CO, seed)).toBe("forbidden"); // whatever the entry state says
    // B3+S1: the seed check precedes the null-state return, so a LEGACY (no-state)
    // agent classifies a seed as forbidden too — and installAppliesToAgent (below)
    // plus the install gate refuse seeds outright, state or no state.
    expect(managedConnectionRole(null, CO, seed)).toBe("forbidden");
    expect(managedConnectionRole(metadata, CO, { id: "manual-google", companyId: CO, name: "rh-google-mcp", config: {} })).toBe("managed");
    // The tagged personal instance is managed by the entry whose KEY matches the tag
    // (classification by the strict instance facts, never the display name).
    const instance = { id: "pi-1", companyId: CO, name: "RH MCP", ...personalInstance };
    expect(managedConnectionRole(metadata, CO, instance)).toBe("managed");
    expect(managedConnectionRole(metadata, "22222222-2222-4222-8222-222222222222", instance)).toBeNull(); // cross-company
    // A personal instance whose tag matches NO state entry of this agent is not managed
    // by name matching either (its name is a display name, not the frozen template key).
    const googleOnlyState = state({
      google: entry({ key: "rh-google-mcp", templateKey: "rh-google-mcp", connectionId: "manual-google" }),
    });
    expect(managedConnectionRole(googleOnlyState, CO, instance)).toBeNull();
  });

  it("installAppliesToAgent: a seed is never installable, for legacy or snapshot agents, company or agent target", () => {
    const metadata = state({
      google: entry({ key: "rh-google-mcp", templateKey: "rh-google-mcp", connectionId: "manual-google" }),
      rh: entry({ key: "rh-mcp", templateKey: "rh-mcp-personal", connectionId: "manual-rh" }),
    });
    const seed = { id: "seed-1", companyId: CO, name: "RH Google MCP", config: seedConfig };
    for (const agent of [{ companyId: CO, state: metadata }, { companyId: CO, state: null }]) {
      for (const install of [
        { targetType: "company" as const, targetId: CO },
        { targetType: "agent" as const, targetId: "agent-1" },
      ]) {
        expect(installAppliesToAgent(install, agent, seed)).toBe(false);
      }
    }
    // A tagged personal instance applies to an agent ONLY via an explicit agent install:
    // a company-wide install never applies to an agent whose state manages it (and the
    // write path refuses company targets outright).
    const instance = { id: "pi-1", companyId: CO, name: "RH MCP", ...personalInstance };
    expect(installAppliesToAgent({ targetType: "company", targetId: CO }, { companyId: CO, state: metadata }, instance)).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent", targetId: "agent-1" }, { companyId: CO, state: metadata }, instance)).toBe(true);
    expect(installAppliesToAgent({ targetType: "agent", targetId: "agent-1" }, { companyId: CO, state: null }, instance)).toBe(true);
  });

  it("B3+S1: a PARTIAL connection identity with the protected personal marker is managed for installs, but the strict privilege predicate never relaxes", () => {
    // The role path accepts a minimal { id, companyId, name, config } shape: the protected
    // personal marker plus a non-empty entry tag is enough for install classification.
    const metadata = state({
      google: entry({ key: "rh-google-mcp", templateKey: "rh-google-mcp", connectionId: "manual-google" }),
      rh: entry({ key: "rh-mcp", templateKey: "rh-mcp-personal", connectionId: "manual-rh" }),
    });
    const partialIdentity = {
      id: "pi-min",
      companyId: CO,
      name: "RH MCP",
      config: { defaultMcpManaged: "personal", paperclipDefaultMcpEntry: "rh-mcp" },
    };
    expect(managedConnectionRole(metadata, CO, partialIdentity)).toBe("managed");
    // A company-wide install of it is still refused; only an explicit per-agent install applies.
    expect(installAppliesToAgent({ targetType: "company", targetId: CO }, { companyId: CO, state: metadata }, partialIdentity)).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent", targetId: "agent-1" }, { companyId: CO, state: metadata }, partialIdentity)).toBe(true);
    // The strict privilege predicate does NOT relax for the minimal shape: without the full
    // row facts (transport, auth kind, policy, identity model) there is no instance and no ceiling.
    expect(isPersonalDefaultMcpInstance(partialIdentity)).toBe(false);
    expect(agentReadCeilingForConnection(partialIdentity as never)).toBeNull();
    // A nested-only personal marker forge is neither an instance nor a role match by marker.
    const nestedForge = { id: "pi-nested", companyId: CO, name: "RH MCP", config: { config: { ...personalConfig } } };
    expect(isPersonalDefaultMcpInstance(nestedForge)).toBe(false);
    expect(managedConnectionRole(metadata, CO, nestedForge)).toBeNull();
    // The strict predicate still admits the full-fact instance (no relax in the other direction).
    expect(isPersonalDefaultMcpInstance(personalInstance)).toBe(true);
    expect(agentReadCeilingForConnection(personalInstance)?.size).toBe(14);
  });
});

describe("installByDefault", () => {
  it("is set only on the dedicated comms-board and agent-memory-tools entries", () => {
    const flagged = DEFAULT_MCP_SPEC.filter((entry) => entry.installByDefault).map((entry) => entry.key);
    expect(flagged).toEqual(["comms-board", "agent-memory-tools"]);
    expect(DEFAULT_MCP_SPEC.every((entry) => !entry.installByDefault || entry.setupHook)).toBe(true);
  });
});

describe("RH Google MCP first-consent defaults", () => {
  // Outside the reviewed safe writes, only names that read. The server's readOnlyHint is wrong for many tools
  // (manage_drive_access, modify_sheet_values, run_script_function ...), so this is a name-shape guard on the curated
  // list, not a trust in that flag.
  const READ_SHAPE = /^(get|list|search|read|query|check|inspect|render|svc_get|svc_list|svc_read)_/;
  // Dangerous tools must stay off by default; an owner enables them in Permissions.
  const DANGEROUS = [
    "send_gmail_message", "send_message", "manage_drive_access", "set_drive_file_permissions", "set_publish_settings",
    "get_drive_shareable_link", "manage_gmail_filter", "manage_event", "respond_to_event", "create_event_with_zoom",
    "run_script_function", "create_script_project", "update_script_content", "manage_deployment", "delete_script_project",
    "create_version", "delete_doc_tab", "manage_contact", "manage_contacts_batch", "manage_contact_group",
    // Multiplex a delete through an `action` argument, so enabling the tool name enables the delete.
    "manage_gmail_label", "manage_task", "manage_task_list",
    // Can move a file to the trash (`trashed`) and change who can share it.
    "update_drive_file",
    // Reviewed 2026-11-18 and kept off: calendar sharing (access control), Apps Script code change or execution,
    // and the approved-send tool (agents no longer send mail, TECH-8951).
    "manage_calendar", "manage_script_content", "manage_script_trigger", "manage_script_project", "send_approved_email",
  ];

  it("lists read-shaped names plus the reviewed safe writes, none duplicated, and none of the dangerous tools", () => {
    const names = [...RH_GOOGLE_MCP_INITIAL_ACTIVE_TOOLS];
    expect(names.length).toBeGreaterThan(40);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      if (!RH_GOOGLE_MCP_SAFE_WRITE_TOOLS.includes(name)) expect(name, name).toMatch(READ_SHAPE);
    }
    for (const name of DANGEROUS) expect(names).not.toContain(name);
    // May create an "anyone with the link" permission depending on the server, so it is not switched on by default.
    expect(names).not.toContain("get_drive_shareable_link");
  });

  it("applies to a personal rh-google-mcp instance only, and installs existing agents only for that entry", () => {
    const personal = (entry: string) => ({
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user",
      config: { defaultMcpManaged: "personal", identityModel: "personal_only", paperclipDefaultMcpEntry: entry },
    });
    const google = initialActiveToolsForPersonalInstance(personal("rh-google-mcp"));
    expect(google?.has("get_events")).toBe(true);
    expect(google?.has("manage_drive_access")).toBe(false);
    expect(google?.has("send_gmail_message")).toBe(false);
    expect(google?.has("modify_sheet_values")).toBe(true);
    expect(installsOnExistingAgentsOnConnect(personal("rh-google-mcp"))).toBe(true);
    // RH MCP keeps its own ceiling-based activation and does not auto-install.
    expect(initialActiveToolsForPersonalInstance(personal("rh-mcp"))?.has("mdm_get_granola_note")).toBe(true);
    expect(installsOnExistingAgentsOnConnect(personal("rh-mcp"))).toBe(false);
    // An ordinary connection, or one that is not a strict personal instance, gets neither.
    expect(initialActiveToolsForPersonalInstance({ transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", config: { paperclipDefaultMcpEntry: "rh-google-mcp" } })).toBeNull();
    expect(installsOnExistingAgentsOnConnect({ transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", config: {} })).toBe(false);
    expect(GOOGLE_DEFAULT_SPEC.find((entry) => entry.key === "rh-google-mcp")?.readCeiling).toBeUndefined();
  });
});
