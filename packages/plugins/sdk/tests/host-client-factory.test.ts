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

  it("allows explicit single-company local folder calls when the invocation scope token is invalid", async () => {
    const localFolderStatus = vi.fn(async () => ({
      companyId: "company-a",
      key: "wiki-root",
      declaration: null,
      configuredPath: null,
      resolvedPath: null,
      isConfigured: false,
      isAccessible: false,
      configuredAt: null,
      lastValidatedAt: null,
      accessibilityError: null,
    }));
    const services = {
      localFolders: {
        status: localFolderStatus,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["local.folders"],
      services,
    });

    await expect(
      handlers["localFolders.status"](
        { companyId: "company-a", key: "wiki-root" },
        { invalidInvocationScope: true },
      ),
    ).resolves.toMatchObject({
      companyId: "company-a",
      key: "wiki-root",
    });
    expect(localFolderStatus).toHaveBeenCalledWith({ companyId: "company-a", key: "wiki-root" });
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
});
