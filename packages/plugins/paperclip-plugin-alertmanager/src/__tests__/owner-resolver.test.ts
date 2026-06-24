import { describe, expect, it, vi } from "vitest";
import {
  resolveAssigneeUserId,
  resolveOwnerEmail,
  resolveOwnerUserId,
} from "../owner-resolver.js";
import { DEFAULT_OWNER_MAP, STATE_KEYS } from "../constants.js";
import type { AlertmanagerAlert, OwnerMap } from "../types.js";

const alert = (overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert => ({
  status: "firing",
  labels: {
    alertname: "CiliumPolicyDropsHigh",
    severity: "critical",
    team: "platform",
  },
  annotations: {},
  startsAt: "2026-04-29T08:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  fingerprint: "fp-1",
  ...overrides,
});

interface MockState {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

interface MockUsers {
  findByEmail: ReturnType<typeof vi.fn>;
}

const mkCtx = () => {
  const state: MockState = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
  };
  const users: MockUsers = {
    findByEmail: vi.fn(async () => null),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    ctx: { state, users, logger } as unknown as Parameters<typeof resolveOwnerUserId>[0],
    state,
    users,
    logger,
  };
};

describe("resolveOwnerEmail — pure resolution chain", () => {
  it("label override wins over everything else", () => {
    const a = alert({
      labels: {
        alertname: "X",
        severity: "info",
        team: "platform",
        paperclip_assignee_email: "  Bob@Example.COM  ",
      },
      annotations: { paperclip_assignee_email: "carol@example.com" },
    });
    const ownerMap: OwnerMap = { team: { platform: "alice@example.com" } };
    expect(resolveOwnerEmail(a, ownerMap)).toEqual({
      email: "bob@example.com",
      agentId: null,
      source: "label-override",
    });
  });

  it("falls back to the owner map when no label override is present", () => {
    const a = alert({
      labels: { alertname: "X", severity: "info", team: "platform" },
    });
    const ownerMap: OwnerMap = {
      team: { platform: "alice@example.com", networking: "ned@example.com" },
    };
    expect(resolveOwnerEmail(a, ownerMap)).toEqual({
      email: "alice@example.com",
      agentId: null,
      source: "owner-map",
    });
  });

  it("ships a durable default route for paperclip claude_k8s alert class", () => {
    const a = alert({
      labels: {
        alertname: "ClaudeK8sConcurrentRunBlockedRate",
        severity: "warning",
        class: "paperclip_claude_k8s",
      },
    });

    expect(resolveOwnerEmail(a, DEFAULT_OWNER_MAP)).toEqual({
      email: "support@blockcast.net",
      agentId: null,
      source: "owner-map",
    });
  });

  it("ships a durable default route for paperclip data_volume alert class", () => {
    const a = alert({
      labels: {
        alertname: "PaperclipDataVolumeNearlyFull",
        severity: "warning",
        class: "paperclip_data_volume",
      },
    });

    expect(resolveOwnerEmail(a, DEFAULT_OWNER_MAP)).toEqual({
      email: "support@blockcast.net",
      agentId: null,
      source: "owner-map",
    });
  });

  it("falls back to annotation override when neither label nor owner-map matches", () => {
    const a = alert({
      labels: { alertname: "X", severity: "info" },
      annotations: { paperclip_assignee_email: "carol@example.com" },
    });
    expect(resolveOwnerEmail(a, undefined)).toEqual({
      email: "carol@example.com",
      agentId: null,
      source: "annotation-override",
    });
  });

  it("returns no-match when nothing resolves", () => {
    const a = alert({
      labels: { alertname: "X", severity: "info" },
    });
    expect(resolveOwnerEmail(a, { team: { platform: "alice@example.com" } })).toEqual({
      email: null,
      agentId: null,
      source: "no-match",
    });
  });

  it("ignores owner-map entries whose label key isn't on the alert", () => {
    const a = alert({ labels: { alertname: "X", severity: "info" } });
    const ownerMap: OwnerMap = { service: { foo: "bar@example.com" } };
    expect(resolveOwnerEmail(a, ownerMap)).toEqual({
      email: null,
      agentId: null,
      source: "no-match",
    });
  });

  describe("agent: prefix routing", () => {
    it("ownerMap value with agent:<id> routes to agentId, not email", () => {
      const a = alert({
        labels: { alertname: "HarborImagePullBackOff", severity: "warning" },
      });
      const ownerMap: OwnerMap = {
        alertname: {
          HarborImagePullBackOff: "agent:c0bccc75-a449-4ece-a789-ce40bdd8e785",
        },
      };
      expect(resolveOwnerEmail(a, ownerMap)).toEqual({
        email: null,
        agentId: "c0bccc75-a449-4ece-a789-ce40bdd8e785",
        source: "owner-map",
      });
    });

    it("agent: prefix is case-insensitive in the prefix only, id preserved as-is", () => {
      const a = alert({
        labels: { alertname: "X", severity: "info", team: "platform" },
      });
      const ownerMap: OwnerMap = {
        team: { platform: "AGENT:UUID-Mixed-Case" },
      };
      expect(resolveOwnerEmail(a, ownerMap)).toEqual({
        email: null,
        agentId: "UUID-Mixed-Case",
        source: "owner-map",
      });
    });

    it("label override accepts agent:<id>", () => {
      const a = alert({
        labels: {
          alertname: "X",
          severity: "info",
          paperclip_assignee_email: "agent:abc-123",
        },
      });
      expect(resolveOwnerEmail(a, undefined)).toEqual({
        email: null,
        agentId: "abc-123",
        source: "label-override",
      });
    });

    it("annotation override accepts agent:<id>", () => {
      const a = alert({
        labels: { alertname: "X", severity: "info" },
        annotations: { paperclip_assignee_email: "agent:abc-123" },
      });
      expect(resolveOwnerEmail(a, undefined)).toEqual({
        email: null,
        agentId: "abc-123",
        source: "annotation-override",
      });
    });

    it("bare 'agent:' with no id after it is treated as a blank value", () => {
      const a = alert({
        labels: { alertname: "X", severity: "info", team: "platform" },
      });
      const ownerMap: OwnerMap = { team: { platform: "agent:   " } };
      // Skipping the blank value, no other map entries → no-match.
      expect(resolveOwnerEmail(a, ownerMap)).toEqual({
        email: null,
        agentId: null,
        source: "no-match",
      });
    });

    it("mixed map: email values still work alongside agent values", () => {
      const a = alert({
        labels: { alertname: "PaperclipPgBackupStale", severity: "warning" },
      });
      const ownerMap: OwnerMap = {
        alertname: {
          HarborImagePullBackOff: "agent:c0bccc75-a449-4ece-a789-ce40bdd8e785",
          PaperclipPgBackupStale: "release-engineer@blockcast.net",
        },
      };
      expect(resolveOwnerEmail(a, ownerMap)).toEqual({
        email: "release-engineer@blockcast.net",
        agentId: null,
        source: "owner-map",
      });
    });
  });

  it("first matching owner-map entry wins (label-key iteration order)", () => {
    const a = alert({
      labels: {
        alertname: "X",
        severity: "info",
        team: "platform",
        service: "registry",
      },
    });
    const ownerMap: OwnerMap = {
      team: { platform: "alice@example.com" },
      service: { registry: "bob@example.com" },
    };
    expect(resolveOwnerEmail(a, ownerMap).email).toBe("alice@example.com");
  });
});

describe("resolveOwnerUserId — caching behaviour", () => {
  it("returns the cached user id and skips the lookup", async () => {
    const { ctx, state, users } = mkCtx();
    state.get.mockResolvedValueOnce("user-cached");

    const result = await resolveOwnerUserId(ctx, "Alice@Example.COM");

    expect(result).toBe("user-cached");
    expect(state.get).toHaveBeenCalledWith({
      scopeKind: "instance",
      stateKey: STATE_KEYS.ownerByEmail("alice@example.com"),
    });
    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });

  it("returns undefined for a negative cache entry without re-querying", async () => {
    const { ctx, state, users } = mkCtx();
    state.get.mockResolvedValueOnce("");

    const result = await resolveOwnerUserId(ctx, "missing@example.com");

    expect(result).toBeUndefined();
    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });

  it("looks up via ctx.users on cache miss, caches the positive result", async () => {
    const { ctx, state, users } = mkCtx();
    state.get.mockResolvedValueOnce(null);
    users.findByEmail.mockResolvedValueOnce({
      id: "user-9",
      email: "alice@example.com",
      name: "Alice",
    });

    const result = await resolveOwnerUserId(ctx, "alice@example.com");

    expect(result).toBe("user-9");
    expect(users.findByEmail).toHaveBeenCalledWith("alice@example.com");
    expect(state.set).toHaveBeenCalledWith(
      {
        scopeKind: "instance",
        stateKey: STATE_KEYS.ownerByEmail("alice@example.com"),
      },
      "user-9",
    );
  });

  it("writes a negative cache entry when no user is found", async () => {
    const { ctx, state, users } = mkCtx();
    state.get.mockResolvedValueOnce(null);
    users.findByEmail.mockResolvedValueOnce(null);

    const result = await resolveOwnerUserId(ctx, "nobody@example.com");

    expect(result).toBeUndefined();
    expect(state.set).toHaveBeenCalledWith(
      {
        scopeKind: "instance",
        stateKey: STATE_KEYS.ownerByEmail("nobody@example.com"),
      },
      "",
    );
  });

  it("logs and returns undefined when the lookup throws", async () => {
    const { ctx, state, users, logger } = mkCtx();
    state.get.mockResolvedValueOnce(null);
    users.findByEmail.mockRejectedValueOnce(new Error("boom"));

    const result = await resolveOwnerUserId(ctx, "alice@example.com");

    expect(result).toBeUndefined();
    expect(state.set).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns undefined for empty / undefined emails without touching state", async () => {
    const { ctx, state, users } = mkCtx();

    expect(await resolveOwnerUserId(ctx, undefined)).toBeUndefined();
    expect(await resolveOwnerUserId(ctx, "")).toBeUndefined();
    expect(await resolveOwnerUserId(ctx, "   ")).toBeUndefined();
    expect(state.get).not.toHaveBeenCalled();
    expect(users.findByEmail).not.toHaveBeenCalled();
  });
});

describe("resolveAssigneeUserId — full chain", () => {
  it("returns no assignee when nothing in the chain matches", async () => {
    const { ctx, state, users } = mkCtx();
    const a = alert({
      labels: { alertname: "X", severity: "info" },
      annotations: {},
    });
    const result = await resolveAssigneeUserId(ctx, a, undefined);
    expect(result.assigneeUserId).toBeUndefined();
    expect(result.resolution.source).toBe("no-match");
    expect(state.get).not.toHaveBeenCalled();
    expect(users.findByEmail).not.toHaveBeenCalled();
  });

  it("resolves all the way through to a Paperclip user id", async () => {
    const { ctx, state, users } = mkCtx();
    state.get.mockResolvedValueOnce(null);
    users.findByEmail.mockResolvedValueOnce({
      id: "user-42",
      email: "alice@example.com",
      name: "Alice",
    });
    const a = alert({
      labels: { alertname: "X", severity: "info", team: "platform" },
    });
    const ownerMap: OwnerMap = { team: { platform: "alice@example.com" } };
    const result = await resolveAssigneeUserId(ctx, a, ownerMap);
    expect(result.assigneeUserId).toBe("user-42");
    expect(result.assigneeAgentId).toBeUndefined();
    expect(result.resolution.source).toBe("owner-map");
  });

  it("agent:<id> in ownerMap routes to assigneeAgentId, bypassing the email lookup", async () => {
    const { ctx, state, users } = mkCtx();
    const a = alert({
      labels: { alertname: "HarborImagePullBackOff", severity: "warning" },
    });
    const ownerMap: OwnerMap = {
      alertname: {
        HarborImagePullBackOff: "agent:c0bccc75-a449-4ece-a789-ce40bdd8e785",
      },
    };
    const result = await resolveAssigneeUserId(ctx, a, ownerMap);
    expect(result.assigneeUserId).toBeUndefined();
    expect(result.assigneeAgentId).toBe(
      "c0bccc75-a449-4ece-a789-ce40bdd8e785",
    );
    expect(result.resolution.source).toBe("owner-map");
    expect(result.resolution.agentId).toBe(
      "c0bccc75-a449-4ece-a789-ce40bdd8e785",
    );
    // Critical: the cache lookup must NOT fire for agent targets.
    expect(state.get).not.toHaveBeenCalled();
    expect(users.findByEmail).not.toHaveBeenCalled();
  });

  it("plain email ownerMap value still routes to assigneeUserId (no regression)", async () => {
    const { ctx, state, users } = mkCtx();
    state.get.mockResolvedValueOnce(null);
    users.findByEmail.mockResolvedValueOnce({
      id: "user-7",
      email: "release-engineer@blockcast.net",
      name: "RE",
    });
    const a = alert({
      labels: { alertname: "PaperclipPgBackupStale", severity: "warning" },
    });
    const ownerMap: OwnerMap = {
      alertname: {
        PaperclipPgBackupStale: "release-engineer@blockcast.net",
      },
    };
    const result = await resolveAssigneeUserId(ctx, a, ownerMap);
    expect(result.assigneeUserId).toBe("user-7");
    expect(result.assigneeAgentId).toBeUndefined();
  });
});
