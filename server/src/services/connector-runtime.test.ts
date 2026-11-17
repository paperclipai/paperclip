import { afterEach, describe, expect, it, vi } from "vitest";
import { chatEndpoints, toolCatalogEntries, type Db } from "@paperclipai/db";
import { SLACK_TOOLS } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { applyConnectorSkills, connectorToolDefinitionsForSkills, resolveConnectorAssignments, resolvedConnectorToolDefinitionsForSkills, type ConnectorAssignment } from "./connector-runtime.js";
import { logger } from "../middleware/logger.js";
import { registerSlackTaskAuthority, SLACK_ENDPOINT_SELECTION_REQUIRED, SLACK_TASK_AUTHORIZATION_DENIED, type SlackTaskAuthority } from "./connectors/slack-authority.js";

const resolvers = vi.hoisted(() => ({
  browser: vi.fn(), speko: vi.fn(), slack: vi.fn(), inboxes: vi.fn(),
}));
vi.mock("./native-runtime/assigned-mcp-tools.js", () => ({ getAssignedMcpGateway: () => ({ browserUseResources: resolvers.browser }) }));
vi.mock("./voice/speko-agent-tools.js", () => ({ spekoAssignedResources: resolvers.speko }));
vi.mock("./connectors/slack.js", () => ({ slackAssignedResource: resolvers.slack, executeGovernedSlackTool: vi.fn() }));
vi.mock("./email-channels.js", () => ({ emailChannelService: () => ({ assignedInboxes: resolvers.inboxes }) }));

// Workflow tests isolate catalog maintenance; real SQL/filter and fresh-catalog
// coverage lives in chat-channels.integration.test.ts.
vi.mock("./connectors/slack-catalog.js", () => ({
  ensureSlackBotCatalogCurrent: vi.fn(async () => undefined),
  slackActiveCatalogToolNames: async (db: Db) => {
    const entries = await db.select().from(toolCatalogEntries).where(undefined);
    return new Set(entries.filter(entry => entry.status === "active" && entry.quarantinedAt === null).map(entry => entry.toolName));
  },
}));
const activeCatalog = SLACK_TOOLS.map(tool => ({ toolName: tool.name, status: "active", quarantinedAt: null }));
const assets = vi.hoisted(() => ({ materialize: vi.fn() }));
vi.mock("./native-runtime/runtime-context.js", () => ({ materializeAsset: assets.materialize }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

// Model dispatch's endpoint selection in the tests that stub permission reads.
// Leave the existing gatingDb helpers unchanged: this attests to one endpoint,
// rather than implicitly unioning their returned rows.
function taskDb(select: ReturnType<typeof vi.fn>): Db {
  const db = { select } as unknown as Db;
  registerSlackTaskAuthority(db, async () => {
    const rows = await db.select().from({} as never).where(undefined);
    if (rows.length !== 1) throw forbidden("No unambiguous endpoint", { code: SLACK_ENDPOINT_SELECTION_REQUIRED });
    return { endpoint: rows[0] } as unknown as SlackTaskAuthority;
  });
  return db;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("connector assignment preparation", () => {
  it("starts independent resolvers together and retains connector order", async () => {
    const pending = Array.from({ length: 4 }, () => deferred<Array<{ id: string; label: string; connectionId: string; address: string }>>());
    Object.values(resolvers).forEach((resolver, i) => resolver.mockReturnValue(pending[i].promise));
    const assignments = resolveConnectorAssignments({} as Db, { companyId: "company", agentId: "agent" });
    await vi.waitFor(() => Object.values(resolvers).forEach(resolver => expect(resolver).toHaveBeenCalledOnce()));
    for (const i of [3, 2, 1, 0]) pending[i].resolve([{ id: `resource-${i}`, connectionId: `connection-${i}`, label: "Resource", address: "inbox@example.com" }]);
    expect((await assignments).map(assignment => assignment.key)).toEqual(["browser-use-cloud", "speko", "slack", "agentmail"]);
  });

  it("does not look up Slack endpoints for non-Slack assignments", async () => {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([{ id: "inbox", address: "inbox@example.com", connectionId: "email" }]);
    const select = vi.fn();
    const assignments = await resolveConnectorAssignments(taskDb(select), {
      companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
    });
    expect(assignments.map(assignment => assignment.key)).toEqual(["agentmail"]);
    expect(select).not.toHaveBeenCalled();
  });

  /**
   * Minimal stub for the two reads gating performs: the endpoint rows, then the
   * prior-install (legacy) lookup. Gating is requested AND installed.
   */
  function gatingDb(rows: Array<Record<string, unknown>> | Error, legacy = false) {
    let call = 0;
    const select = vi.fn(() => {
      call += 1;
      const isEndpointRead = call === 1;
      return {
        from: () => ({
          where: async () => {
            if (rows instanceof Error) throw rows;
            return isEndpointRead ? rows : activeCatalog;
          },
          innerJoin: () => ({
            where: async () => {
              if (rows instanceof Error) throw rows;
              return legacy ? rows : [];
            },
          }),
        }),
      };
    });
    return select;
  }

  it.each(["default", "upload", "empty", "error"])("filters a task-bound Slack assignment with a %s lookup", async mode => {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "slack", label: "Slack", connectionId: "connection" }]);
    const rows = mode === "error"
      ? new Error("Endpoint lookup unavailable")
      : mode === "empty"
        ? []
        // A group counts only when both requested and installed.
        : [{ id: "slack", setup: {
            slackOptInScopeGroups: mode === "upload" ? ["file_upload"] : [],
            slackInstalledOptInScopeGroups: mode === "upload" ? ["file_upload"] : [],
          } }];
    const select = gatingDb(rows);
    const assignments = await resolveConnectorAssignments(taskDb(select), {
      companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
    });
    const names = assignments[0].tools.map(tool => tool.name);
    expect(names.includes("slack_upload_file")).toBe(mode === "upload");
    expect(names).not.toContain("slack_create_channel");
    if (mode === "empty" || mode === "error") expect(names).toEqual([]);
    else {
      expect(names).toContain("slack_history");
      expect(names).toContain("slack_open_dm");
    }
  });

  it("keeps a requested-but-not-installed group gated", async () => {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "slack", label: "Slack", connectionId: "connection" }]);
    const select = gatingDb([
      { id: "slack", setup: { slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: [] } },
    ]);
    const assignments = await resolveConnectorAssignments(taskDb(select), {
      companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
    });
    expect(assignments[0].tools.map(tool => tool.name)).not.toContain("slack_upload_file");
  });


  it("settles outstanding resolution before propagating a failed connector", async () => {
    const slack = deferred<[]>();
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockRejectedValue(new Error("Speko unavailable"));
    resolvers.slack.mockReturnValue(slack.promise);
    resolvers.inboxes.mockResolvedValue([]);
    let settled = false;
    const assignments = resolveConnectorAssignments({} as Db, { companyId: "company", agentId: "agent" });
    const result = expect(assignments).rejects.toThrow("Speko unavailable").finally(() => { settled = true; });
    await vi.waitFor(() => expect(resolvers.slack).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    slack.resolve([]);
    await result;
  });
});

describe("connector tool definitions fail closed", () => {
  const slackSkill = "paperclipai/paperclip/slack";

  it("yields no gated Slack tools when the enabled set is omitted", () => {
    // S4: an omitted set is not "everything".
    const [slack] = connectorToolDefinitionsForSkills(new Set([slackSkill]));
    const names = slack!.tools.map(tool => tool.name);
    expect(names).not.toContain("slack_upload_file");
    expect(names).not.toContain("slack_create_channel");
    expect(names).not.toContain("slack_invite");
    // Ungated Slack tools are unaffected.
    expect(names).toContain("slack_history");
    expect(names).toContain("slack_open_dm");
  });

  it("includes a gated tool once the enabled set names it", () => {
    const [slack] = connectorToolDefinitionsForSkills(new Set([slackSkill]), new Set(["slack_upload_file"]));
    const names = slack!.tools.map(tool => tool.name);
    expect(names).toContain("slack_upload_file");
    expect(names).not.toContain("slack_create_channel");
  });
});

describe("Slack connector exposure boundaries", () => {
  it.each(["disabled", "quarantined", "active-quarantined"])("preserves a %s catalog restriction after maintenance", async status => {
    const endpoint = { id: "selected", companyId: "company", connectionId: "connection", setup: { slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"] } };
    const db = { select: () => ({ from: () => ({ where: async () => [{
      toolName: "slack_upload_file", status: status === "active-quarantined" ? "active" : status,
      quarantinedAt: status === "active-quarantined" ? new Date() : null,
    }] }) }) } as unknown as Db;
    const unregister = registerSlackTaskAuthority(db, async () => ({ endpoint }) as unknown as SlackTaskAuthority);
    try {
      const [spec] = await resolvedConnectorToolDefinitionsForSkills(db, new Set(["paperclipai/paperclip/slack"]), {
        companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
      });
      expect(spec!.tools.map(tool => tool.name)).not.toContain("slack_upload_file");
    } finally { unregister(); }
  });
  it("does not union another endpoint's groups into the selected endpoint", async () => {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "selected", label: "Slack", connectionId: "connection" }]);
    const selected = { id: "selected", companyId: "company", setup: { slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] } };
    const other = { id: "other", companyId: "company", setup: { slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"] } };
    const from = vi.fn((table: unknown) => ({ where: async () => {
      if (table === chatEndpoints) return [selected, other];
      if (table === toolCatalogEntries) return activeCatalog;
      throw new Error("Unexpected permission query");
    } }));
    const db = { select: () => ({ from }) } as unknown as Db;
    const unregister = registerSlackTaskAuthority(db, async () => ({ endpoint: selected }) as unknown as SlackTaskAuthority);
    try {
      const assignments = await resolveConnectorAssignments(db, { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" });
      expect(assignments[0]!.tools.map(tool => tool.name)).not.toContain("slack_upload_file");
      expect(assignments[0]!.tools.map(tool => tool.name)).toContain("slack_history");
      for (const tool of JSON.parse(JSON.stringify(assignments[0]!.tools))) expect(tool).not.toHaveProperty("scopes");
      expect(from).toHaveBeenCalledWith(toolCatalogEntries);
      expect(from).not.toHaveBeenCalledWith(chatEndpoints);
    } finally { unregister(); }
  });

  it.each(["Unlinked user", "No accepted responsible user"])("silently hides tools for expected denial: %s", async reason => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => { throw forbidden(reason, { code: SLACK_TASK_AUTHORIZATION_DENIED }); });
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "slack", label: "Slack", connectionId: "connection" }]);
    const binding = { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" };
    try {
      expect((await resolveConnectorAssignments(db, binding))[0]!.tools).toEqual([]);
      expect((await resolvedConnectorToolDefinitionsForSkills(db, new Set(["paperclipai/paperclip/slack"]), binding))[0]!.tools).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it("logs an unexpected structured controller 403 without exposing its message", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => { throw Object.assign(new Error("Authorization denied"), { status: 403 }); });
    try {
      const specs = await resolvedConnectorToolDefinitionsForSkills(db, new Set(["paperclipai/paperclip/slack"]), {
        companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
      });
      expect(specs[0]!.tools).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ issueId: "issue", errorClass: "Error", status: 403 }), expect.any(String));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("Authorization denied");
    } finally { unregister(); }
  });

  it("silently unions only usable endpoints after an expected selection-required denial", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const first = { id: "first", companyId: "company", connectionId: "one", setup: { slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] } };
    const second = { id: "second", companyId: "company", connectionId: "two", setup: { slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"] } };
    const db = { select: () => ({ from: (table: unknown) => ({ where: async () => {
      if (table === chatEndpoints) return [first, second];
      if (table === toolCatalogEntries) return activeCatalog;
      throw new Error("Unexpected permission query");
    } }) }) } as unknown as Db;
    const unregister = registerSlackTaskAuthority(db, async binding => {
      if (!binding.endpointId) throw forbidden("Select a connection", { code: SLACK_ENDPOINT_SELECTION_REQUIRED });
      return { endpoint: binding.endpointId === first.id ? first : second } as unknown as SlackTaskAuthority;
    });
    try {
      const [spec] = await resolvedConnectorToolDefinitionsForSkills(db, new Set(["paperclipai/paperclip/slack"]), {
        companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
      });
      expect(spec!.tools.map(tool => tool.name)).toContain("slack_history");
      expect(spec!.tools.map(tool => tool.name)).toContain("slack_upload_file");
      expect(spec!.tools.map(tool => tool.name)).not.toContain("slack_create_channel");
      expect(warn).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it.each(["chat_action_authorization_changed", "chat_requester_authorization_changed", "run_identity_not_active", "run_task_identity_invalid"])("keeps the usable endpoint when one candidate denies with %s", async code => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const endpoint = { id: "usable", companyId: "company", connectionId: "connection", setup: { slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"] } };
    const db = { select: () => ({ from: (table: unknown) => ({ where: async () =>
      table === chatEndpoints ? [{ id: "denied" }, endpoint] : activeCatalog,
    }) }) } as unknown as Db;
    const unregister = registerSlackTaskAuthority(db, async binding => {
      if (!binding.endpointId) throw forbidden("Select", { code: SLACK_ENDPOINT_SELECTION_REQUIRED });
      if (binding.endpointId === "denied") throw forbidden("Denied", { code });
      return { endpoint, userId: "user" } as unknown as SlackTaskAuthority;
    });
    try {
      const [spec] = await resolvedConnectorToolDefinitionsForSkills(db, new Set(["paperclipai/paperclip/slack"]), {
        companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
      });
      expect(spec!.tools.map(tool => tool.name)).toContain("slack_upload_file");
      expect(warn).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it("logs and fails closed in both assignment discovery and native tool preparation", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => { throw new Error("transient DB outage: secret-canary"); });
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "slack", label: "Slack", connectionId: "connection" }]);
    const binding = { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" };
    try {
      const assignments = await resolveConnectorAssignments(db, binding);
      expect(assignments[0]!.tools).toEqual([]);
      const native = await resolvedConnectorToolDefinitionsForSkills(db, new Set(["paperclipai/paperclip/slack"]), binding);
      expect(native[0]!.tools.map(tool => tool.name)).not.toContain("slack_upload_file");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({ issueId: "issue", errorClass: "Error" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-canary");
    } finally { unregister(); }
  });

  it("keeps native preparation alive on a transient Slack lookup failure and logs it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const db = { select: () => { throw new Error("transient database error"); } } as unknown as Db;
    const unregister = registerSlackTaskAuthority(db, async () => { throw new Error("transient database error"); });
    try {
      const specs = await resolvedConnectorToolDefinitionsForSkills(db, new Set(["paperclipai/paperclip/slack"]), {
        companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
      });
      expect(specs[0]!.tools).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    } finally { unregister(); }
  });

  it("strips scope metadata when serializing TOOLS.json even for an older assignment", async () => {
    assets.materialize.mockResolvedValue({ rootPath: "/test/connector-bundle" });
    await applyConnectorSkills({}, [], [{
      key: "slack", label: "Slack", skillKey: "paperclipai/paperclip/slack", resources: [],
      tools: [{ name: "slack_history", description: "History", inputSchema: {}, scopes: ["channels:history"] }],
    }] as unknown as ConnectorAssignment[]);
    const files = assets.materialize.mock.calls[0]![0] as { path: string; content: Buffer }[];
    const spec = JSON.parse(files.find(file => file.path === "TOOLS.json")!.content.toString());
    expect(spec).toEqual([{ name: "slack_history", description: "History", inputSchema: {} }]);
  });

  it("does not serialize internal scope metadata in connector tool definitions", () => {
    const definitions = connectorToolDefinitionsForSkills(new Set(["paperclipai/paperclip/slack"]), new Set(["slack_upload_file"]));
    const serialized = JSON.parse(JSON.stringify(definitions));
    expect(serialized[0].tools.length).toBeGreaterThan(0);
    for (const tool of serialized[0].tools) expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
  });
});

describe("Slack connector gating is requested and installed", () => {
  function gatingDb(rows: Array<Record<string, unknown>>) {
    let call = 0;
    return vi.fn(() => {
      call += 1;
      const first = call === 1;
      return {
        from: () => ({
          where: async () => (first ? rows : activeCatalog),
          innerJoin: () => ({ where: async () => [] }),
        }),
      };
    });
  }

  async function slackToolNames(setup: Record<string, unknown>) {
    resolvers.browser.mockResolvedValue([]);
    resolvers.speko.mockResolvedValue([]);
    resolvers.inboxes.mockResolvedValue([]);
    resolvers.slack.mockResolvedValue([{ id: "slack", label: "Slack", connectionId: "connection" }]);
    const assignments = await resolveConnectorAssignments(taskDb(gatingDb([{ id: "slack", setup }])), {
      companyId: "company", agentId: "agent", runId: "run", issueId: "issue",
    });
    return assignments[0]!.tools.map(tool => tool.name);
  }

  it("disables a granted group the operator removed", async () => {
    // Slack still reports the scope, but the request is empty.
    const names = await slackToolNames({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: ["file_upload"] });
    expect(names).not.toContain("slack_upload_file");
    expect(names).toContain("slack_history");
  });

  it("offers a group only when requested and installed", async () => {
    const names = await slackToolNames({ slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"] });
    expect(names).toContain("slack_upload_file");
  });
});
