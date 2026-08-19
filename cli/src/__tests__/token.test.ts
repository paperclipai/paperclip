import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_API_KEY_SCOPE_PRESETS } from "@paperclipai/shared";
import { registerTokenCommands } from "../commands/client/token.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerTokenCommands(program);
  return program;
}

function agentResponse() {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Worker",
    urlKey: "worker",
    role: "Engineer",
    status: "active",
  };
}

describe("token commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates an agent token through the generic token command", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(agentResponse()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "key-1",
        name: "external-worker",
        token: "pcp_plaintext",
        createdAt: "2026-05-23T00:00:00.000Z",
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token",
      "agent",
      "create",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
      "--company-id",
      COMPANY_ID,
      "--agent",
      "worker",
      "--name",
      "external-worker",
      "--json",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/agents/worker?companyId=${COMPANY_ID}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}/keys`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      name: "external-worker",
      scope: { kind: "standard" },
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      key: { id: "key-1", token: "pcp_plaintext" },
    });
  });

  it("lists and revokes agent tokens", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(agentResponse()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "key-1", name: "external-worker", createdAt: "2026-05-23T00:00:00.000Z", revokedAt: null }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(agentResponse()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, keyId: "key-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "agent", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--agent", "worker",
    ], { from: "user" });

    await createProgram().parseAsync([
      "token", "agent", "revoke", "key-1",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--agent", "worker",
    ], { from: "user" });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}/keys`);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}/keys/key-1`);
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
  });

  it("resolves agent token commands by agent id without the reference lookup query", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(agentResponse()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "key-1", name: "external-worker", createdAt: "2026-05-23T00:00:00.000Z", revokedAt: null }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "agent", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--agent", AGENT_ID,
      "--json",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}/keys`);
  });

  it("creates a board token with a ttl-derived expiration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T00:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "board-key-1",
        name: "external-admin",
        token: "pcp_board_plaintext",
        createdAt: "2026-05-23T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: "2026-06-06T00:00:00.000Z",
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--name", "external-admin",
      "--ttl-days", "14",
      "--json",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3100/api/board-api-keys");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: "external-admin",
      expiresAt: "2026-06-06T00:00:00.000Z",
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [COMPANY_ID],
        permissions: expect.any(Array),
        instanceCapabilities: [],
      },
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      key: {
        id: "board-key-1",
        name: "external-admin",
        token: "pcp_board_plaintext",
        expiresAt: "2026-06-06T00:00:00.000Z",
      },
    });
  });

  it("creates a non-expiring board token when requested", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "board-key-1",
        name: "external-admin",
        token: "pcp_board_plaintext",
        createdAt: "2026-05-23T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--name", "external-admin",
      "--never-expires",
      "--json",
    ], { from: "user" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: "external-admin",
      expiresAt: null,
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [COMPANY_ID],
        permissions: expect.any(Array),
        instanceCapabilities: [],
      },
    });
  });

  it("uses the finite 30-day default and the selected shared scope preset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T00:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: "board-key-1",
      name: "reader",
      token: "pcp_board_plaintext",
      createdAt: "2026-05-23T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: "2026-06-22T00:00:00.000Z",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--scope-company-id", SECOND_COMPANY_ID,
      "--scope-preset", "read_only",
      "--name", "reader",
      "--json",
    ], { from: "user" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: "reader",
      expiresAt: "2026-06-22T00:00:00.000Z",
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [COMPANY_ID, SECOND_COMPANY_ID],
        instanceCapabilities: [],
      },
    });
  });

  it("accepts a custom scope only through the shared strict validator", async () => {
    const customScope = {
      version: 1,
      kind: "scoped",
      companyIds: [COMPANY_ID],
      permissions: ["issues:read", "issues:write"],
      instanceCapabilities: [],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: "board-key-1",
      name: "issue-bot",
      token: "pcp_board_plaintext",
      createdAt: "2026-05-23T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: "2026-06-22T00:00:00.000Z",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--scope-config-json", JSON.stringify(customScope),
      "--name", "issue-bot",
      "--json",
    ], { from: "user" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).scopeConfig).toEqual(customScope);
  });

  it("lists and revokes board tokens", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: "board-key-1",
        name: "external-admin",
        createdAt: "2026-05-23T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, keyId: "board-key-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    await createProgram().parseAsync([
      "token", "board", "revoke", "board-key-1",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--json",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3100/api/board-api-keys");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3100/api/board-api-keys/board-key-1");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("recognizes a preset scope when its valid permissions use a different order", async () => {
    const permissions = [...BOARD_API_KEY_SCOPE_PRESETS.read_only.permissions].reverse();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{
      id: "board-key-1",
      name: "reader",
      tokenPrefix: "pcp_board_123456789abc",
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [COMPANY_ID],
        permissions,
        instanceCapabilities: [],
      },
      legacyUnrestricted: false,
      status: "active",
      createdAt: "2026-05-23T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: "2026-06-22T00:00:00.000Z",
      revokedAt: null,
    }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    expect(String(log.mock.calls[0]?.[0])).toContain("scope=read_only:1_companies");
  });
});
