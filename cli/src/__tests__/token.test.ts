import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTokenCommands } from "../commands/client/token.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
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
  });

  afterEach(() => {
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
});
