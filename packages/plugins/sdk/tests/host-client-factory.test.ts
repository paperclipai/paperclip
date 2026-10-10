import { describe, expect, it, vi } from "vitest";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../src/protocol.js";

describe("createHostClientHandlers invocation company scope", () => {
  it("rejects worker-selected config and secret company ids without a host invocation scope", async () => {
    const configGet = vi.fn(async () => ({ apiKeyRef: "unreachable" }));
    const secretsResolve = vi.fn(async () => "unreachable");
    const services = {
      config: { get: configGet },
      secrets: { resolve: secretsResolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await expect(
      handlers["config.get"]({ companyId: "company-a" }),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["secrets.resolve"]({
        companyId: "company-a",
        secretRef: { type: "secret_ref", secretId: "secret-a" },
      }),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(configGet).not.toHaveBeenCalled();
    expect(secretsResolve).not.toHaveBeenCalled();
  });

  it("allows explicit config and secret company ids only when they match the host invocation scope", async () => {
    const configGet = vi.fn(async () => ({ apiKeyRef: "ref" }));
    const secretsResolve = vi.fn(async () => "resolved");
    const services = {
      config: { get: configGet },
      secrets: { resolve: secretsResolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["config.get"]({ companyId: "company-a" }, context),
    ).resolves.toEqual({ apiKeyRef: "ref" });
    await expect(
      handlers["secrets.resolve"]({
        companyId: "company-a",
        secretRef: { type: "secret_ref", secretId: "secret-a" },
      }, context),
    ).resolves.toBe("resolved");

    expect(configGet).toHaveBeenCalledWith({ companyId: "company-a" }, context);
    expect(secretsResolve).toHaveBeenCalledWith({
      companyId: "company-a",
      secretRef: { type: "secret_ref", secretId: "secret-a" },
    }, context);
  });

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

  it("rejects a human-attributed createComment call when only issue.comments.create is granted", async () => {
    const createComment = vi.fn(async () => ({ id: "comment-1" }));
    const services = {
      issues: { createComment },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.comments.create"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["issues.createComment"]({
        issueId: "issue-a",
        body: "hello",
        companyId: "company-a",
        actorUserId: "user-a",
      }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("allows a human-attributed createComment call once issue.comments.create_human_attributed is also granted", async () => {
    const createComment = vi.fn(async () => ({ id: "comment-1" }));
    const services = {
      issues: { createComment },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.comments.create", "issue.comments.create_human_attributed"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["issues.createComment"]({
        issueId: "issue-a",
        body: "hello",
        companyId: "company-a",
        actorUserId: "user-a",
      }, context),
    ).resolves.toEqual({ id: "comment-1" });
    expect(createComment).toHaveBeenCalledWith({
      issueId: "issue-a",
      body: "hello",
      companyId: "company-a",
      actorUserId: "user-a",
    });
  });

  it("still allows a plain agent-attributed createComment call without the human-attribution capability", async () => {
    const createComment = vi.fn(async () => ({ id: "comment-2" }));
    const services = {
      issues: { createComment },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.comments.create"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["issues.createComment"]({
        issueId: "issue-a",
        body: "hello",
        companyId: "company-a",
        authorAgentId: "agent-a",
      }, context),
    ).resolves.toEqual({ id: "comment-2" });
    expect(createComment).toHaveBeenCalled();
  });
});

describe("createHostClientHandlers capability gating for LOOA-641 methods", () => {
  const context = { invocationScope: { companyId: "company-a" } };

  it("denies issues.respondInteraction without issue.interactions.respond", async () => {
    const respondInteraction = vi.fn(async () => ({ interaction: { id: "i" }, applied: true }));
    const services = { issues: { respondInteraction } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      // A read grant must not confer the ability to respond.
      capabilities: ["issue.interactions.read"],
      services,
    });
    await expect(
      handlers["issues.respondInteraction"]({
        issueId: "issue-a", interactionId: "int-a", companyId: "company-a", action: "accept", actorUserId: "user-a",
      }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(respondInteraction).not.toHaveBeenCalled();
  });

  it("allows issues.respondInteraction with issue.interactions.respond", async () => {
    const respondInteraction = vi.fn(async () => ({ interaction: { id: "i" }, applied: true }));
    const services = { issues: { respondInteraction } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.interactions.respond"],
      services,
    });
    await expect(
      handlers["issues.respondInteraction"]({
        issueId: "issue-a", interactionId: "int-a", companyId: "company-a", action: "accept", actorUserId: "user-a",
      }, context),
    ).resolves.toEqual({ interaction: { id: "i" }, applied: true });
    expect(respondInteraction).toHaveBeenCalledOnce();
  });

  it("denies approvals.decide without approvals.respond", async () => {
    const decide = vi.fn(async () => ({ approval: { id: "a" }, applied: true }));
    const services = { approvals: { decide } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      // A read grant must not confer the ability to decide.
      capabilities: ["approvals.read"],
      services,
    });
    await expect(
      handlers["approvals.decide"]({
        approvalId: "a", companyId: "company-a", action: "approve", actorUserId: "user-a",
      }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(decide).not.toHaveBeenCalled();
  });

  it("allows approvals.decide with approvals.respond", async () => {
    const decide = vi.fn(async () => ({ approval: { id: "a" }, applied: true }));
    const services = { approvals: { decide } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["approvals.respond"],
      services,
    });
    await expect(
      handlers["approvals.decide"]({
        approvalId: "a", companyId: "company-a", action: "approve", actorUserId: "user-a",
      }, context),
    ).resolves.toEqual({ approval: { id: "a" }, applied: true });
    expect(decide).toHaveBeenCalledOnce();
  });

  it("denies read methods without their read capability", async () => {
    const listInteractions = vi.fn(async () => []);
    const list = vi.fn(async () => []);
    const getAttachmentContent = vi.fn(async () => null);
    const services = {
      issues: { listInteractions, getAttachmentContent },
      approvals: { list },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });
    await expect(
      handlers["issues.listInteractions"]({ issueId: "i", companyId: "company-a" }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(
      handlers["approvals.list"]({ companyId: "company-a" }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(
      handlers["issues.getAttachmentContent"]({ attachmentId: "at", companyId: "company-a" }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(listInteractions).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(getAttachmentContent).not.toHaveBeenCalled();
  });

  it("enforces invocation company scope on the new methods", async () => {
    const list = vi.fn(async () => []);
    const services = { approvals: { list } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["approvals.read"],
      services,
    });
    // Requesting company-b while scoped to company-a must be denied.
    await expect(
      handlers["approvals.list"]({ companyId: "company-b" }, context),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(list).not.toHaveBeenCalled();
  });
});
