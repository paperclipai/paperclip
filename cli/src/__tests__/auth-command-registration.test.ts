import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerClientAuthCommands } from "../commands/client/auth.js";

describe("registerClientAuthCommands", () => {
  it("registers auth commands without duplicate company-id flags", () => {
    const program = new Command();
    const auth = program.command("auth");

    expect(() => registerClientAuthCommands(auth)).not.toThrow();

    const login = auth.commands.find((command) => command.name() === "login");
    expect(login).toBeDefined();
    expect(login?.options.filter((option) => option.long === "--company-id")).toHaveLength(1);
  });
});

describe("client auth API commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_TEST_CHALLENGE_TOKEN;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps CLI auth challenge endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    async function run(args: string[]) {
      const program = new Command();
      const auth = program.command("auth");
      program.exitOverride();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      registerClientAuthCommands(auth);
      await program.parseAsync([
        "auth",
        ...args,
        "--api-base", "http://localhost:3100",
        "--api-key", "board-token",
      ], { from: "user" });
    }

    await run(["challenge", "create", "--payload-json", "{}"]);
    await run(["challenge", "get", "challenge-1", "--token", "secret"]);
    await run(["challenge", "approve", "challenge-1", "--token", "secret"]);
    process.env.PAPERCLIP_TEST_CHALLENGE_TOKEN = "env-secret";
    await run(["challenge", "approve", "challenge/2", "--token-env", "PAPERCLIP_TEST_CHALLENGE_TOKEN"]);
    await run(["challenge", "cancel", "challenge-1", "--token", "secret"]);
    await run(["revoke-current"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["POST", "http://localhost:3100/api/cli-auth/challenges"],
      ["GET", "http://localhost:3100/api/cli-auth/challenges/challenge-1?token=secret"],
      ["POST", "http://localhost:3100/api/cli-auth/challenges/challenge-1/approve"],
      ["POST", "http://localhost:3100/api/cli-auth/challenges/challenge%2F2/approve"],
      ["POST", "http://localhost:3100/api/cli-auth/challenges/challenge-1/cancel"],
      ["POST", "http://localhost:3100/api/cli-auth/revoke-current"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ token: "env-secret" });
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
