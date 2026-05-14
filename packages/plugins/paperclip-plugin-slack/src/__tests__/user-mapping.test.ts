import { describe, it, expect, vi } from "vitest";
import { resolveSlackUserId } from "../user-mapping.js";
import { STATE_KEYS } from "../constants.js";

const SLACK_TOKEN = "xoxb-test";

interface MockState {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

interface MockUsers {
  get: ReturnType<typeof vi.fn>;
  findByEmail: ReturnType<typeof vi.fn>;
}

const mkCtx = () => {
  const fetch = vi.fn();
  const state: MockState = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
  };
  const users: MockUsers = {
    get: vi.fn(async () => null),
    findByEmail: vi.fn(async () => null),
  };
  const ctx: any = {
    http: { fetch },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    state,
    users,
  };
  return { ctx, fetch, state, users };
};

describe("resolveSlackUserId — cache hit", () => {
  it("returns cached slackUserId without calling ctx.users.get or Slack API", async () => {
    const { ctx, fetch, state, users } = mkCtx();
    state.get.mockResolvedValueOnce({ slackUserId: "U_CACHED" });

    const result = await resolveSlackUserId(ctx, SLACK_TOKEN, "user-123");

    expect(result).toEqual({ slackUserId: "U_CACHED", source: "cache" });
    expect(state.get).toHaveBeenCalledWith({
      scopeKind: "instance",
      stateKey: STATE_KEYS.slackUser("user-123"),
    });
    expect(users.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });
});

describe("resolveSlackUserId — happy path (cache miss → resolve)", () => {
  it("looks up paperclip user, calls Slack users.lookupByEmail, caches and returns the slack user id", async () => {
    const { ctx, fetch, state, users } = mkCtx();
    state.get.mockResolvedValueOnce(null);
    users.get.mockResolvedValueOnce({
      id: "user-123",
      email: "alice@example.com",
      name: "Alice",
    });
    fetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, user: { id: "U_NEW", name: "alice" } }),
    });

    const result = await resolveSlackUserId(ctx, SLACK_TOKEN, "user-123");

    expect(result).toEqual({ slackUserId: "U_NEW", source: "slack" });
    expect(users.get).toHaveBeenCalledWith("user-123");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toContain("/users.lookupByEmail");
    expect(url).toContain("email=alice%40example.com");
    expect(opts.headers.Authorization).toBe(`Bearer ${SLACK_TOKEN}`);
    expect(state.set).toHaveBeenCalledWith(
      {
        scopeKind: "instance",
        stateKey: STATE_KEYS.slackUser("user-123"),
      },
      { slackUserId: "U_NEW" },
    );
  });
});

describe("resolveSlackUserId — paperclip user not found", () => {
  it("returns missing-email source without calling Slack and without writing cache", async () => {
    const { ctx, fetch, state, users } = mkCtx();
    state.get.mockResolvedValueOnce(null);
    users.get.mockResolvedValueOnce(null);

    const result = await resolveSlackUserId(ctx, SLACK_TOKEN, "ghost-user");

    expect(result).toEqual({ slackUserId: null, source: "missing-email" });
    expect(users.get).toHaveBeenCalledWith("ghost-user");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });
});

describe("resolveSlackUserId — Slack rejects lookup", () => {
  it("returns slack-error with the Slack error code, does not cache", async () => {
    const { ctx, fetch, state, users } = mkCtx();
    state.get.mockResolvedValueOnce(null);
    users.get.mockResolvedValueOnce({
      id: "user-123",
      email: "alice@example.com",
      name: "Alice",
    });
    fetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: false, error: "users_not_found" }),
    });

    const result = await resolveSlackUserId(ctx, SLACK_TOKEN, "user-123");

    expect(result).toEqual({
      slackUserId: null,
      source: "slack-error",
      error: "users_not_found",
    });
    expect(state.set).not.toHaveBeenCalled();
  });
});
