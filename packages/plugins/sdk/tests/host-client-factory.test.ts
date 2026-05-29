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

  it.each([
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

  it("delegates issues.listInteractions to the host service when the capability is present", async () => {
    const listInteractions = vi.fn(async () => [
      { id: "int-1", kind: "request_confirmation", status: "pending" },
    ]);
    const services = {
      issues: { listInteractions },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.interactions.read"],
      services,
    });

    await expect(
      handlers["issues.listInteractions"](
        { issueId: "issue-a", companyId: "company-a", status: "pending" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual([{ id: "int-1", kind: "request_confirmation", status: "pending" }]);
    expect(listInteractions).toHaveBeenCalledWith({
      issueId: "issue-a",
      companyId: "company-a",
      status: "pending",
    });
  });

  it("rejects issues.listInteractions when the plugin lacks issue.interactions.read", async () => {
    const listInteractions = vi.fn(async () => []);
    const services = {
      issues: { listInteractions },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });

    await expect(
      handlers["issues.listInteractions"]({ issueId: "issue-a", companyId: "company-a" }),
    ).rejects.toMatchObject({
      name: "CapabilityDeniedError",
      message: expect.stringContaining("issue.interactions.read"),
    });
    expect(listInteractions).not.toHaveBeenCalled();
  });

  it("delegates issues.acceptInteraction to the host service when the capability is present", async () => {
    const acceptInteraction = vi.fn(async () => ({ id: "int-1", kind: "request_confirmation", status: "accepted" }));
    const services = {
      issues: { acceptInteraction },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.interactions.resolve"],
      services,
    });

    await expect(
      handlers["issues.acceptInteraction"](
        { issueId: "issue-a", companyId: "company-a", interactionId: "int-1" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual({ id: "int-1", kind: "request_confirmation", status: "accepted" });
    expect(acceptInteraction).toHaveBeenCalledWith({
      issueId: "issue-a",
      companyId: "company-a",
      interactionId: "int-1",
    });
  });

  it("delegates issues.rejectInteraction and issues.respondInteraction when the capability is present", async () => {
    const rejectInteraction = vi.fn(async () => ({ id: "int-1", status: "rejected" }));
    const respondInteraction = vi.fn(async () => ({ id: "int-2", status: "answered" }));
    const services = {
      issues: { rejectInteraction, respondInteraction },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.interactions.resolve"],
      services,
    });

    await expect(
      handlers["issues.rejectInteraction"](
        { issueId: "issue-a", companyId: "company-a", interactionId: "int-1", reason: "nope" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual({ id: "int-1", status: "rejected" });
    await expect(
      handlers["issues.respondInteraction"](
        { issueId: "issue-a", companyId: "company-a", interactionId: "int-2", answers: [] },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual({ id: "int-2", status: "answered" });
    expect(rejectInteraction).toHaveBeenCalledWith({
      issueId: "issue-a",
      companyId: "company-a",
      interactionId: "int-1",
      reason: "nope",
    });
    expect(respondInteraction).toHaveBeenCalledWith({
      issueId: "issue-a",
      companyId: "company-a",
      interactionId: "int-2",
      answers: [],
    });
  });

  it("rejects issues.acceptInteraction when the plugin lacks issue.interactions.resolve", async () => {
    const acceptInteraction = vi.fn(async () => ({}));
    const services = {
      issues: { acceptInteraction },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });

    await expect(
      handlers["issues.acceptInteraction"]({ issueId: "issue-a", companyId: "company-a", interactionId: "int-1" }),
    ).rejects.toMatchObject({
      name: "CapabilityDeniedError",
      message: expect.stringContaining("issue.interactions.resolve"),
    });
    expect(acceptInteraction).not.toHaveBeenCalled();
  });

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
});
