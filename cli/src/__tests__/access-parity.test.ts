import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAccessCommands } from "../commands/client/access.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const INVITE_ID = "44444444-4444-4444-8444-444444444444";
const JOIN_ID = "55555555-5555-4555-8555-555555555555";
const MEMBER_ID = "66666666-6666-4666-8666-666666666666";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAccessCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

describe("access parity commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps auth, invites, joins, members, and admin endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["health"]);
    await run(["whoami"]);
    await run(["access", "whoami"]);
    await run(["profile", "session"]);
    await run(["profile", "get"]);
    await run(["profile", "update", "--payload-json", "{}"]);
    await run(["invite", "list", "--company-id", COMPANY_ID]);
    await run(["invite", "create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["invite", "revoke", INVITE_ID]);
    await run(["invite", "show", "token-1"]);
    await run(["invite", "test-resolution", "token-1", "--url", "http://localhost:3100/invite/token-1"]);
    await run(["invite", "accept", "token-1"]);
    await run(["join", "list", "--company-id", COMPANY_ID, "--status", "pending"]);
    await run(["join", "approve", JOIN_ID, "--company-id", COMPANY_ID]);
    await run(["join", "reject", JOIN_ID, "--company-id", COMPANY_ID]);
    await run(["join", "claim-key", JOIN_ID, "--claim-secret", "secret"]);
    await run(["member", "list", "--company-id", COMPANY_ID]);
    await run(["member", "update", MEMBER_ID, "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["member", "archive", MEMBER_ID, "--company-id", COMPANY_ID]);
    await run(["admin", "user", "list"]);
    await run(["admin", "user", "promote", USER_ID]);
    await run(["admin", "user", "company-access:update", USER_ID, "--payload-json", "{}"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/health"],
      ["GET", "http://localhost:3100/api/cli-auth/me"],
      ["GET", "http://localhost:3100/api/cli-auth/me"],
      ["GET", "http://localhost:3100/api/auth/get-session"],
      ["GET", "http://localhost:3100/api/auth/profile"],
      ["PATCH", "http://localhost:3100/api/auth/profile"],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/invites`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/invites`],
      ["POST", `http://localhost:3100/api/invites/${INVITE_ID}/revoke`],
      ["GET", "http://localhost:3100/api/invites/token-1"],
      ["GET", "http://localhost:3100/api/invites/token-1/test-resolution?url=http%3A%2F%2Flocalhost%3A3100%2Finvite%2Ftoken-1"],
      ["POST", "http://localhost:3100/api/invites/token-1/accept"],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/join-requests?status=pending_approval`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/join-requests/${JOIN_ID}/approve`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/join-requests/${JOIN_ID}/reject`],
      ["POST", `http://localhost:3100/api/join-requests/${JOIN_ID}/claim-api-key`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/members`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/members/${MEMBER_ID}`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/members/${MEMBER_ID}/archive`],
      ["GET", "http://localhost:3100/api/admin/users"],
      ["POST", `http://localhost:3100/api/admin/users/${USER_ID}/promote-instance-admin`],
      ["PUT", `http://localhost:3100/api/admin/users/${USER_ID}/company-access`],
    ]);
  });

  it("wraps instance, sidebar, llm, and openapi endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["openapi"]);
    await run(["instance", "scheduler-heartbeats"]);
    await run(["instance", "settings:general"]);
    await run(["instance", "settings:general:update", "--payload-json", "{}"]);
    await run(["instance", "database-backup"]);
    await run(["sidebar", "preferences"]);
    await run(["sidebar", "preferences:update", "--payload-json", "{}"]);
    await run(["sidebar", "project-preferences", "--company-id", COMPANY_ID]);
    await run(["sidebar", "project-preferences:update", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["sidebar", "badges", "--company-id", COMPANY_ID]);
    await run(["inbox", "dismissals", "--company-id", COMPANY_ID]);
    await run(["inbox", "dismiss", "--company-id", COMPANY_ID, "--payload-json", "{\"itemKey\":\"run:1\"}"]);
    await run(["board-claim", "show", "claim-token"]);
    await run(["board-claim", "claim", "claim-token", "--payload-json", "{}"]);
    await run(["openclaw", "invite-prompt", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["available-skill", "list"]);
    await run(["available-skill", "index"]);
    await run(["available-skill", "get", "paperclip"]);
    await run(["llm", "agent-configuration"]);
    await run(["llm", "agent-configuration:adapter", "codex_local"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/openapi.json"],
      ["GET", "http://localhost:3100/api/instance/scheduler-heartbeats"],
      ["GET", "http://localhost:3100/api/instance/settings/general"],
      ["PATCH", "http://localhost:3100/api/instance/settings/general"],
      ["POST", "http://localhost:3100/api/instance/database-backups"],
      ["GET", "http://localhost:3100/api/sidebar-preferences/me"],
      ["PUT", "http://localhost:3100/api/sidebar-preferences/me"],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/sidebar-preferences/me`],
      ["PUT", `http://localhost:3100/api/companies/${COMPANY_ID}/sidebar-preferences/me`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/sidebar-badges`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/inbox-dismissals`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/inbox-dismissals`],
      ["GET", "http://localhost:3100/api/board-claim/claim-token"],
      ["POST", "http://localhost:3100/api/board-claim/claim-token/claim"],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/openclaw/invite-prompt`],
      ["GET", "http://localhost:3100/api/skills/available"],
      ["GET", "http://localhost:3100/api/skills/index"],
      ["GET", "http://localhost:3100/api/skills/paperclip"],
      ["GET", "http://localhost:3100/api/llms/agent-configuration.txt"],
      ["GET", "http://localhost:3100/api/llms/agent-configuration/codex_local.txt"],
    ]);
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
