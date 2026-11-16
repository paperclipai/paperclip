import { describe, expect, it, vi } from "vitest";
import { toolCatalogEntries, toolConnections, type Db } from "@paperclipai/db";
import { SLACK_TOOLS } from "@paperclipai/shared";
import { executeSlackTool, executeGovernedSlackTool } from "./slack.js";
import { executeSlackWrite } from "./slack-writes.js";
import { registerSlackTaskAuthority, type SlackTaskAuthority } from "./slack-authority.js";
import { slackEnabledToolsForSetup } from "./slack-opt-ins.js";
import { syncSlackBotTools } from "./slack-catalog.js";

/**
 * TECH-7988: a tool this agent did not enable must be rejected before any Slack
 * API call, not surfaced later as a Slack `missing_scope`. Gating is requested
 * AND installed, and dispatch must agree with the listing exactly.
 */
describe("Slack tool dispatch opt-in gating", () => {
  const binding = {
    companyId: "company",
    agentId: "agent",
    runId: "run",
    issueId: "issue",
  };

  function authority(setup: Record<string, unknown>) {
    return {
      endpoint: {
        id: "endpoint",
        companyId: "company",
        providerAccountId: "T1",
        botExternalId: "UBOT",
        allowDirectMessages: true,
        setup,
      },
      conversation: null,
      slackUserId: "U1",
      principalId: "principal",
      userId: "user",
      deliveryId: null,
      identityContextId: null,
      revision: "revision",
      workMode: "standard",
      botToken: "xoxb-test",
    } as unknown as SlackTaskAuthority;
  }

  function mockDbForWrites() {
    const actions: any[] = [];
    const makeTx = () => ({
      execute: vi.fn(async () => undefined),
      select: () => ({
        from: () => ({
          where: async () => [{ id: "inv-1", status: "executing", approvalState: "approved" }],
        }),
      }),
      insert: () => ({
        values: (val: any) => ({
          returning: () => [{ id: "act-1", ...val }],
          onConflictDoNothing: () => ({
            returning: () => {
              const action = { id: "action-1", status: "received", ...val };
              actions.push(action);
              return [action];
            },
          }),
        }),
      }),
      update: () => ({
        set: (val: any) => ({
          where: () => ({
            returning: () => [{ ...actions[0], ...val }],
          }),
        }),
      }),
    });
    const tx = makeTx();
    return {
      ...tx,
      transaction: async (fn: any) => fn(tx),
    } as unknown as Db;
  }

  async function withAuthority<T>(
    setup: Record<string, unknown>,
    run: (db: Db) => Promise<T>,
  ): Promise<T> {
    const db = mockDbForWrites();
    const unregister = registerSlackTaskAuthority(db, async () => authority(setup));
    try {
      return await run(db);
    } finally {
      unregister();
    }
  }

  it("rejects slack_upload_file before any Slack call when the group is off", async () => {
    await withAuthority({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] }, async (db) => {
      const fetchImpl = vi.fn();
      await expect(executeSlackTool(db, binding, "slack_upload_file", {
        attachmentId: "00000000-0000-4000-8000-000000000000",
        channel: "C1",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("does not reject slack_open_dm by opt-in gating when opt-ins are off", async () => {
    await withAuthority({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] }, async (db) => {
      const fetchImpl = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("users.info")) {
          return new Response(JSON.stringify({
            ok: true,
            user: { id: "U1", team_id: "T1", is_bot: false, deleted: false },
          }), { headers: { "x-oauth-scopes": "im:history,im:read,im:write,chat:write" } });
        }
        if (url.includes("conversations.open")) {
          return new Response(JSON.stringify({ ok: true, channel: { id: "D1" } }));
        }
        return new Response(JSON.stringify({ ok: true }));
      });
      await expect(executeSlackTool(
        db,
        binding,
        "slack_open_dm",
        { idempotencyKey: "00000000-0000-4000-8000-000000000002" },
        fetchImpl as unknown as typeof fetch,
        "inv-1",
      )).resolves.toMatchObject({ channel: "D1" });
      expect(fetchImpl).toHaveBeenCalled();
    });
  });

  it("fails fast with 403 slack_dm_scope_missing when grantedScopes lacks im:write and does not call conversations.open", async () => {
    await withAuthority({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] }, async (db) => {
      const fetchImpl = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("users.info")) {
          return new Response(JSON.stringify({
            ok: true,
            user: { id: "U1", team_id: "T1", is_bot: false, deleted: false },
          }), { headers: { "x-oauth-scopes": "im:history,im:read,chat:write" } });
        }
        return new Response(JSON.stringify({ ok: true }));
      });
      const error = await executeSlackTool(
        db,
        binding,
        "slack_open_dm",
        { idempotencyKey: "00000000-0000-4000-8000-000000000003" },
        fetchImpl as unknown as typeof fetch,
        "inv-1",
      ).catch((e) => e);
      expect(error).toMatchObject({
        status: 403,
        message: expect.stringContaining("Reconnect"),
        details: { code: "slack_dm_scope_missing" },
      });
      const calls = fetchImpl.mock.calls.map(([req]) => String(req));
      expect(calls.some((url) => url.includes("conversations.open"))).toBe(false);
    });
  });

  it("proceeds with conversations.open when grantedScopes includes im:write", async () => {
    await withAuthority({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] }, async (db) => {
      const fetchImpl = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("users.info")) {
          return new Response(JSON.stringify({
            ok: true,
            user: { id: "U1", team_id: "T1", is_bot: false, deleted: false },
          }), { headers: { "x-oauth-scopes": "im:history,im:read,im:write,chat:write" } });
        }
        if (url.includes("conversations.open")) {
          return new Response(JSON.stringify({ ok: true, channel: { id: "D_GRANTED" } }));
        }
        return new Response(JSON.stringify({ ok: true }));
      });
      const result = await executeSlackTool(
        db,
        binding,
        "slack_open_dm",
        { idempotencyKey: "00000000-0000-4000-8000-000000000004" },
        fetchImpl as unknown as typeof fetch,
        "inv-1",
      );
      expect(result).toMatchObject({ channel: "D_GRANTED" });
      const calls = fetchImpl.mock.calls.map(([req]) => String(req));
      expect(calls.some((url) => url.includes("conversations.open"))).toBe(true);
    });
  });

  it("surfaces slack_dm_scope_missing when x-oauth-scopes header is absent and conversations.open rejects with missing_scope", async () => {
    await withAuthority({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] }, async (db) => {
      const fetchImpl = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("users.info")) {
          return new Response(JSON.stringify({
            ok: true,
            user: { id: "U1", team_id: "T1", is_bot: false, deleted: false },
          }));
        }
        if (url.includes("conversations.open")) {
          return new Response(JSON.stringify({
            ok: false,
            error: "missing_scope",
            needed: "im:write",
          }));
        }
        return new Response(JSON.stringify({ ok: true }));
      });
      const error = await executeSlackTool(
        db,
        binding,
        "slack_open_dm",
        { idempotencyKey: "00000000-0000-4000-8000-000000000005" },
        fetchImpl as unknown as typeof fetch,
        "inv-1",
      ).catch((e) => e);
      expect(error).toMatchObject({
        status: 403,
        message: expect.stringContaining("Reconnect"),
        details: { code: "slack_dm_scope_missing" },
      });
    });
  });

  it("keeps a requested but uninstalled group disabled", async () => {
    await withAuthority({ slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: [] }, async (db) => {
      const fetchImpl = vi.fn();
      await expect(executeSlackTool(db, binding, "slack_upload_file", {
        attachmentId: "00000000-0000-4000-8000-000000000000",
        channel: "C1",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ details: { code: "slack_tool_not_enabled" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("keeps a removed group disabled even though Slack kept the grant", async () => {
    // Installed says granted; requested says the operator removed it.
    await withAuthority({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: ["channel_management"] }, async (db) => {
      const fetchImpl = vi.fn();
      await expect(executeSlackTool(db, binding, "slack_create_channel", {
        name: "launch", is_private: false, idempotencyKey: "00000000-0000-4000-8000-000000000003",
      }, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe("Slack governed dispatch opt-in gating", () => {
  it("names the missing opt-in before entering the tool gateway", async () => {
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => authorityFor({ slackOptInScopeGroups: [] }));
    try {
      await expect(executeGovernedSlackTool(db, { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" },
        "slack_create_channel", { name: "launch", is_private: false, idempotencyKey: "00000000-0000-4000-8000-000000000004" }))
        .rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled", groups: ["channel_management"] } });
    } finally {
      unregister();
    }
  });

  function authorityFor(setup: Record<string, unknown>) {
    return {
      endpoint: { id: "endpoint", companyId: "company", setup },
    } as unknown as SlackTaskAuthority;
  }
});

describe("Slack write dispatch opt-in gating", () => {
  it("rejects a disabled write before any Slack call", async () => {
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => ({
      endpoint: { id: "endpoint", companyId: "company", setup: { slackOptInScopeGroups: [] } },
      workMode: "standard",
    }) as unknown as SlackTaskAuthority);
    const fetchImpl = vi.fn();
    try {
      await expect(executeSlackWrite(
        db,
        { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" },
        "slack_upload_file",
        { attachmentId: "00000000-0000-4000-8000-000000000000", channel: "C1", idempotencyKey: "00000000-0000-4000-8000-000000000001" },
        undefined,
        fetchImpl as unknown as typeof fetch,
      )).rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});

describe("Slack gating fail-closed edges", () => {
  it("rejects an unknown tool as a client error instead of a TypeError", async () => {
    await expect(executeSlackWrite(
      {} as Db,
      { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" },
      "slack_not_a_tool",
      {},
      undefined,
    )).rejects.toMatchObject({ status: 400, details: { code: "unknown_slack_tool" } });
  });

  it("treats a row with no opt-in fields and no prior install as having no groups", async () => {
    // Two reads: the endpoint row, then the prior-install (legacy) lookup.
    let call = 0;
    const db = {
      select: vi.fn(() => {
        call += 1;
        const first = call === 1;
        return {
          from: () => ({
            where: async () => (first ? [{ id: "endpoint", setup: {} }] : []),
            innerJoin: () => ({ where: async () => [] }),
          }),
        };
      }),
    } as unknown as Db;
    await withAuthorityOn(db, { }, async () => {
      const fetchImpl = vi.fn();
      await expect(executeSlackTool(db, {
        companyId: "company", agentId: "agent", runId: "run", issueId: "issue", endpointId: "endpoint",
      }, "slack_upload_file", {
        attachmentId: "00000000-0000-4000-8000-000000000000",
        channel: "C1",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }, fetchImpl as unknown as typeof fetch)).rejects.toThrow("not enabled for this agent");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  async function withAuthorityOn<T>(db: Db, setup: Record<string, unknown>, run: () => Promise<T>) {
    const unregister = registerSlackTaskAuthority(db, async () => ({
      endpoint: {
        id: "endpoint", companyId: "company", providerAccountId: "T1",
        botExternalId: "UBOT", allowDirectMessages: true, setup,
      },
      conversation: null, slackUserId: "U1", principalId: "principal", userId: "user",
      deliveryId: null, identityContextId: null, revision: "revision",
      workMode: "standard", botToken: "xoxb-test",
    }) as unknown as SlackTaskAuthority);
    try {
      return await run();
    } finally {
      unregister();
    }
  }
});

/**
 * The property that matters most: for every requested/installed combination,
 * the set a listing offers equals the set dispatch accepts. A mismatch means a
 * tool is advertised but fails, or is callable while hidden.
 */
describe("Slack listing and dispatch agree", () => {
  const groups = ["channel_management", "file_upload"] as const;
  const subsets = (items: readonly (typeof groups)[number][]) =>
    items.reduce<(typeof groups)[number][][]>((acc, group) => [...acc, ...acc.map(set => [...set, group])], [[]]);
  const gatedTools = SLACK_TOOLS.filter(tool => tool.name !== "slack_search");

  it("agrees for every requested/installed combination", async () => {
    for (const requested of subsets(groups)) {
      for (const installed of subsets(groups)) {
        const setup = { slackOptInScopeGroups: requested, slackInstalledOptInScopeGroups: installed };
        const listed = new Set(slackEnabledToolsForSetup(setup).map(tool => String(tool.name)));
        const db = {} as Db;
        const unregister = registerSlackTaskAuthority(db, async () => ({
          endpoint: {
            id: "endpoint", companyId: "company", providerAccountId: "T1",
            botExternalId: "UBOT", allowDirectMessages: true, setup,
          },
          conversation: null, slackUserId: "U1", principalId: "principal", userId: "user",
          deliveryId: null, identityContextId: null, revision: "revision",
          workMode: "standard", botToken: "xoxb-test",
        }) as unknown as SlackTaskAuthority);
        try {
          for (const tool of gatedTools) {
            // A gated-off tool must fail on gating, before argument parsing or
            // any Slack call; a listed tool must get past the gate.
            const error = await executeSlackTool(db, {
              companyId: "company", agentId: "agent", runId: "run", issueId: "issue", endpointId: "endpoint",
            }, tool.name, {}, vi.fn() as unknown as typeof fetch).catch(failure => failure);
            const gatedOut = error?.details?.code === "slack_tool_not_enabled";
            expect(gatedOut).toBe(!listed.has(tool.name));
          }
        } finally {
          unregister();
        }
      }
    }
  });
});

/**
 * The endpoint selector decides which endpoint is gated, so it must be valid on
 * its own: a malformed value must never reach a UUID database comparison. The
 * remaining arguments still parse only after gating, so a disabled tool reports
 * the permission error first.
 */
describe("Slack endpoint selector validation", () => {
  const binding = { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" };

  function endpointAuthority(endpointId: string, setup: Record<string, unknown>) {
    return {
      endpoint: {
        id: endpointId,
        companyId: "company",
        providerAccountId: "T1",
        botExternalId: "UBOT",
        allowDirectMessages: true,
        setup,
      },
      conversation: null,
      slackUserId: "U1",
      principalId: "principal",
      userId: "user",
      deliveryId: null,
      identityContextId: null,
      revision: "revision",
      workMode: "standard",
      botToken: "xoxb-test",
    } as unknown as SlackTaskAuthority;
  }

  it.each([
    ["not a uuid", "not-a-uuid"],
    ["a partial uuid", "123e4567-e89b"],
    ["an empty string", ""],
    ["an object", { nested: true }],
    ["a number", 42],
  ])("rejects %s before resolving authority", async (_label, endpointId) => {
    const db = {} as Db;
    // Only the default endpoint is registered: a malformed selector must be
    // refused before it could be looked up.
    const unregister = registerSlackTaskAuthority(db, async () => endpointAuthority("11111111-1111-4111-8111-111111111111", {
      slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"],
    }));
    try {
      await expect(executeSlackTool(db, binding, "slack_upload_file", {
        endpointId,
        attachmentId: "00000000-0000-4000-8000-000000000000",
        channel: "C1",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }, vi.fn() as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 400, details: { code: "slack_endpoint_selector_invalid" } });
    } finally {
      unregister();
    }
  });

  it("still gates a disabled tool before parsing the rest of its arguments", async () => {
    // A valid selector, a disabled group, and otherwise invalid arguments: the
    // permission error must win, because the caller has no access either way.
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => endpointAuthority(
      "22222222-2222-4222-8222-222222222222", { slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
    ));
    try {
      await expect(executeSlackTool(db, binding, "slack_upload_file", {
        endpointId: "22222222-2222-4222-8222-222222222222",
        attachmentId: "not-a-uuid",
        channel: 12345,
      }, vi.fn() as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled" } });
    } finally {
      unregister();
    }
  });

  it("gates the endpoint the selector names, not the assigned one", async () => {
    // Two valid endpoints with different permissions. Only the selector decides
    // which one is gated, so its state must be the one that is read.
    const assigned = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const selected = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const permissions: Record<string, Record<string, unknown>> = {
      [assigned]: { slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"] },
      [selected]: { slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
    };
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async (taskBinding) =>
      endpointAuthority(taskBinding.endpointId ?? assigned, permissions[taskBinding.endpointId ?? assigned]!));
    const args = {
      attachmentId: "00000000-0000-4000-8000-000000000000",
      channel: "C1",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    };
    try {
      // Selecting the endpoint without the group is refused by gating.
      await expect(executeSlackTool(db, binding, "slack_upload_file", { ...args, endpointId: selected },
        vi.fn() as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled" } });
      // Selecting the endpoint with the group gets past gating; whatever fails
      // after that is not a permission refusal.
      const error = await executeSlackTool(db, binding, "slack_upload_file", { ...args, endpointId: assigned },
        vi.fn() as unknown as typeof fetch).catch((failure: unknown) => failure);
      expect((error as { details?: { code?: string } }).details?.code).not.toBe("slack_tool_not_enabled");
    } finally {
      unregister();
    }
  });
});

describe("Slack catalog sync status transitions (TECH-8783)", () => {
  it("keeps existing disabled slack_open_dm disabled, and flips removed to active", async () => {
    const writes: Array<{ values: any; set: any }> = [];
    const mockTx = {
      execute: vi.fn(async () => undefined),
      select: () => ({
        from: (table: any) => ({
          where: async () => {
            if (table === toolConnections) return [{ id: "conn-1", applicationId: "app-1", enabled: true }];
            if (table === toolCatalogEntries) {
              return [
                { name: "slack_bot:slack_open_dm", status: "disabled", versionHash: "old-hash", reviewedByUserId: "u1", reviewedAt: new Date() },
                { name: "slack_bot:slack_upload_file", status: "active", versionHash: "old-hash" },
              ];
            }
            return [];
          },
        }),
      }),
      insert: () => ({
        values: (vals: any) => ({
          returning: () => [{ id: "prof-1", ...vals }],
          onConflictDoNothing: () => ({
            returning: () => [{ id: "prof-1", ...vals }],
          }),
          onConflictDoUpdate: ({ set }: any) => {
            writes.push({ values: vals, set });
            return {
              returning: () => [{ id: "prof-1" }],
            };
          },
        }),
      }),
    } as any;

    const endpoint = {
      id: "ep-1",
      companyId: "c-1",
      connectionId: "conn-1",
      setup: { slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
    } as any;

    await syncSlackBotTools(mockTx, endpoint, "u1", true);

    const openDmDisabledWrite = writes.find((w) => w.values.name === "slack_bot:slack_open_dm");
    expect(openDmDisabledWrite).toBeDefined();
    expect(openDmDisabledWrite?.set.status).toBe("disabled");

    // Now test flipping from removed to active
    writes.length = 0;
    const mockTx2 = {
      execute: vi.fn(async () => undefined),
      select: () => ({
        from: (table: any) => ({
          where: async () => {
            if (table === toolConnections) return [{ id: "conn-1", applicationId: "app-1", enabled: true }];
            if (table === toolCatalogEntries) {
              return [
                { name: "slack_bot:slack_open_dm", status: "removed", versionHash: "old-hash", reviewedByUserId: null, reviewedAt: null },
              ];
            }
            return [];
          },
        }),
      }),
      insert: () => ({
        values: (vals: any) => ({
          returning: () => [{ id: "prof-1", ...vals }],
          onConflictDoNothing: () => ({
            returning: () => [{ id: "prof-1", ...vals }],
          }),
          onConflictDoUpdate: ({ set }: any) => {
            writes.push({ values: vals, set });
            return {
              returning: () => [{ id: "prof-1" }],
            };
          },
        }),
      }),
    } as any;

    await syncSlackBotTools(mockTx2, endpoint, "u1", true);

    const openDmRemovedWrite = writes.find((w) => w.values.name === "slack_bot:slack_open_dm");
    expect(openDmRemovedWrite).toBeDefined();
    expect(openDmRemovedWrite?.set.status).toBe("active");
  });
});
