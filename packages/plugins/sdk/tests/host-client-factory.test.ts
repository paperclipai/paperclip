import { describe, expect, it, vi } from "vitest";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../src/protocol.js";

describe("createHostClientHandlers invocation company scope", () => {
  it("rejects company-scoped host calls outside the current invocation company", async () => {
    const projectsList = vi.fn(async () => []);
    const services = {
      projects: {
        list: projectsList,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["projects.read"],
      services,
    });

    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    expect(projectsList).not.toHaveBeenCalled();
  });

  it("filters companies.list to the current invocation company", async () => {
    const services = {
      companies: {
        list: vi.fn(async () => [
          { id: "company-a", name: "Company A" },
          { id: "company-b", name: "Company B" },
        ]),
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    await expect(
      handlers["companies.list"](
        {},
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual([{ id: "company-a", name: "Company A" }]);
  });

  it("rejects company-scope store access for a different company", async () => {
    const stateGet = vi.fn(async () => null);
    const services = {
      state: {
        get: stateGet,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["plugin.state.read"],
      services,
    });

    await expect(
      handlers["state.get"](
        { scopeKind: "company", scopeId: "company-b", stateKey: "settings" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(stateGet).not.toHaveBeenCalled();
  });

  it("delegates state.list when the plugin has state read capability", async () => {
    const stateList = vi.fn(async () => ({ entries: [], hasMore: false }));
    const services = {
      state: {
        list: stateList,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["plugin.state.read"],
      services,
    });

    await expect(
      handlers["state.list"]({ scopeKind: "instance", stateKeyPrefix: "link:" }),
    ).resolves.toEqual({ entries: [], hasMore: false });
    expect(stateList).toHaveBeenCalledWith({ scopeKind: "instance", stateKeyPrefix: "link:" });
  });

  it.each([
    [
      "state.list",
      "plugin.state.read",
      { scopeKind: "instance" },
      (services: HostServices) => vi.mocked(services.state.list),
    ],
    [
      "access.members.list",
      "access.members.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.access.listMembers),
    ],
    [
      "access.members.update",
      "access.members.write",
      { companyId: "company-a", memberId: "member-a", patch: { status: "active" } },
      (services: HostServices) => vi.mocked(services.access.updateMember),
    ],
    [
      "authorization.grants.set",
      "authorization.grants.write",
      { companyId: "company-a", principalType: "agent", principalId: "agent-a", grants: [] },
      (services: HostServices) => vi.mocked(services.authorization.setGrants),
    ],
    [
      "authorization.policies.update",
      "authorization.policies.write",
      { companyId: "company-a", resourceType: "agent", resourceId: "agent-a", policy: null },
      (services: HostServices) => vi.mocked(services.authorization.updatePolicy),
    ],
    [
      "authorization.audit.search",
      "authorization.audit.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.authorization.searchAudit),
    ],
    [
      "approvals.resolve",
      "approvals.resolve",
      {
        companyId: "company-a",
        approvalId: "approval-a",
        decision: "approve",
        decidedByUserId: "slack:U1",
      },
      (services: HostServices) => vi.mocked(services.approvals.resolve),
    ],
  ] as const)(
    "rejects %s when the plugin lacks %s",
    async (method, capability, params, getDelegate) => {
      const services = {
        access: {
          listMembers: vi.fn(async () => []),
          updateMember: vi.fn(async () => ({ id: "member-a" })),
        },
        authorization: {
          setGrants: vi.fn(async () => []),
          updatePolicy: vi.fn(async () => ({ policy: null })),
          searchAudit: vi.fn(async () => []),
        },
        approvals: {
          resolve: vi.fn(async () => ({
            id: "approval-a",
            companyId: "company-a",
            type: "request_board_approval",
            status: "approved",
            requestedByAgentId: null,
            requestedByUserId: null,
            decisionNote: null,
            decidedByUserId: "slack:U1",
            decidedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            applied: true,
          })),
        },
        state: {
          list: vi.fn(async () => ({ entries: [], hasMore: false })),
        },
      } as unknown as HostServices;
      const handlers = createHostClientHandlers({
        pluginId: "paperclip.test",
        capabilities: [],
        services,
      });

      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toMatchObject({
        name: "CapabilityDeniedError",
        message: expect.stringContaining(capability),
      });
      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(getDelegate(services)).not.toHaveBeenCalled();
    },
  );

  it("checks invocation company scope before exposing authorization data", async () => {
    const searchAudit = vi.fn(async () => []);
    const services = {
      authorization: {
        searchAudit,
      },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["authorization.audit.read"],
      services,
    });

    await expect(
      handlers["authorization.audit.search"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(searchAudit).not.toHaveBeenCalled();
  });

  it("checks invocation company scope before resolving approvals", async () => {
    const resolve = vi.fn(async () => ({
      id: "approval-a",
      companyId: "company-a",
      type: "request_board_approval",
      status: "approved",
      requestedByAgentId: null,
      requestedByUserId: null,
      decisionNote: null,
      decidedByUserId: "slack:U1",
      decidedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      applied: true,
    }));
    const services = {
      approvals: { resolve },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["approvals.resolve"],
      services,
    });

    await expect(
      handlers["approvals.resolve"](
        {
          companyId: "company-b",
          approvalId: "approval-a",
          decision: "approve",
          decidedByUserId: "slack:U1",
        },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("agents.updateAdapterOverrides (optional, capability-gated host method)", () => {
  const PARAMS = {
    agentId: "agent-1",
    companyId: "company-a",
    overrides: { endpoint: "https://api.penstock.run" } as Record<string, unknown>,
  };

  it("denies the call without the agents.adapter.write capability", async () => {
    const updateAdapterOverrides = vi.fn(async () => ({}) as never);
    const services = {
      agents: { updateAdapterOverrides },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });

    await expect(handlers["agents.updateAdapterOverrides"](PARAMS)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    expect(updateAdapterOverrides).not.toHaveBeenCalled();
  });

  it("delegates to the host when the capability is granted and the host implements it", async () => {
    const updated = { id: "agent-1", companyId: "company-a", adapterConfig: PARAMS.overrides };
    const updateAdapterOverrides = vi.fn(async () => updated as never);
    const services = {
      agents: { updateAdapterOverrides },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["agents.adapter.write"],
      services,
    });

    await expect(handlers["agents.updateAdapterOverrides"](PARAMS)).resolves.toBe(updated);
    expect(updateAdapterOverrides).toHaveBeenCalledWith(PARAMS);
  });

  it("forwards a null override (rollback) unchanged", async () => {
    const updateAdapterOverrides = vi.fn(async () => ({ id: "agent-1", adapterConfig: {} }) as never);
    const services = {
      agents: { updateAdapterOverrides },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["agents.adapter.write"],
      services,
    });

    const clearParams = { agentId: "agent-1", companyId: "company-a", overrides: null };
    await handlers["agents.updateAdapterOverrides"](clearParams);
    expect(updateAdapterOverrides).toHaveBeenCalledWith(clearParams);
  });

  it("throws not-implemented when a capable host has not wired the optional method", async () => {
    const services = { agents: {} } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["agents.adapter.write"],
      services,
    });

    await expect(handlers["agents.updateAdapterOverrides"](PARAMS)).rejects.toThrow(
      /does not implement agents\.updateAdapterOverrides/,
    );
  });
});
