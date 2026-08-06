import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  authUsers,
  boardApiKeyAuthorizationEvents,
  boardApiKeys,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import { BOARD_API_KEY_SCOPE_PRESETS } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { boardAuthService, hashBearerToken } from "../services/board-auth.js";
import {
  createBoardKeyAuditContext,
  runWithBoardKeyAuditContext,
} from "./board-key-audit-coupling.js";
import { authorizeBoardKey, lookupBoardKeyRoute } from "./board-key-route-registry.js";

const TOKEN = "pcp_board_authorization_matrix";

function scope(companyId: string) {
  return {
    version: 1 as const,
    kind: "scoped" as const,
    companyIds: [companyId],
    permissions: [...BOARD_API_KEY_SCOPE_PRESETS.full_instance_admin.permissions],
    instanceCapabilities: ["instance_admin"] as const,
  };
}

function createLiveAuthorityDb() {
  const companyId = randomUUID();
  const ownerId = randomUUID();
  const keyId = randomUUID();
  const state = {
    ownerExists: true,
    membershipActive: true,
    membershipRole: "owner",
    instanceAdmin: true,
    revoked: false,
    permissionGrants: new Set(["agents:create", "agents:configure", "tasks:assign"]),
  };
  const key = {
    id: keyId,
    userId: ownerId,
    name: "matrix",
    keyHash: hashBearerToken(TOKEN),
    tokenPrefix: "pcp_board_author",
    scopeConfig: scope(companyId),
    legacyUnrestricted: false,
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
  const audit: Array<Record<string, unknown>> = [];

  const db = {
    select: vi.fn(() => ({
      from(table: unknown) {
        const rows = table === boardApiKeys
          ? (state.revoked ? [{ ...key, revokedAt: new Date() }] : [key])
          : table === authUsers
            ? (state.ownerExists ? [{ id: ownerId, name: "Owner", email: "owner@example.com" }] : [])
            : table === companyMemberships
              ? (state.membershipActive ? [{ companyId, membershipRole: state.membershipRole, status: "active" }] : [])
              : table === instanceUserRoles
                ? (state.instanceAdmin ? [{ id: randomUUID() }] : [])
                : table === principalPermissionGrants
                  ? [...state.permissionGrants].map((permissionKey) => ({ companyId, permissionKey }))
                : [];
        return {
          where: () => Promise.resolve(rows),
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(state.revoked ? [] : [{ id: keyId }]),
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === boardApiKeyAuthorizationEvents) audit.push(values);
        return [];
      },
    })),
  } as any;

  return { db, state, key, companyId, ownerId, audit };
}

function requestFor(
  authentication: Awaited<ReturnType<ReturnType<typeof boardAuthService>["authenticateBoardApiKey"]>>,
  method = "POST",
) {
  if (!authentication.ok) throw new Error("Expected successful board-key authentication");
  const { key, scopeConfig, access } = authentication;
  const companyIds = scopeConfig
    ? scopeConfig.companyIds.filter((id) => access.companyIds.includes(id))
    : access.companyIds;
  return {
    id: randomUUID(),
    method,
    actor: {
      type: "board",
      source: "board_key",
      userId: key.userId,
      keyId: key.id,
      boardKeyOwnerId: key.userId,
      boardKeyPrefix: key.tokenPrefix,
      boardKeyScope: scopeConfig,
      boardKeyLegacyUnrestricted: key.legacyUnrestricted,
      companyIds,
      memberships: access.memberships.filter((membership) => companyIds.includes(membership.companyId)),
      isInstanceAdmin: access.isInstanceAdmin,
    },
  } as unknown as Request;
}

async function expectDenied(run: Promise<unknown>, status: number) {
  await expect(run).rejects.toMatchObject({ status } satisfies Partial<HttpError>);
}

describe("board-key effective authority", () => {
  it("stages a mutating allow for its transaction instead of auditing ahead of the mutation", async () => {
    const { db, companyId, audit } = createLiveAuthorityDb();
    const authentication = await boardAuthService(db).authenticateBoardApiKey(TOKEN);
    const req = requestFor(authentication);
    const metadata = lookupBoardKeyRoute("POST", `/api/companies/${companyId}/issues`);
    const context = createBoardKeyAuditContext();

    await runWithBoardKeyAuditContext(context, () => authorizeBoardKey(
      db,
      req,
      metadata.action,
      async () => ({ companyId, resourceType: "company", resourceId: companyId }),
      metadata,
    ));

    // Nothing durable yet: the disposition commits with the mutation it
    // authorizes, so a rolled-back controller leaves no `authorized` record.
    expect(audit).toHaveLength(0);
    expect(context.pending).toMatchObject({ decision: "allow", action: "issues:write" });
  });

  it("audits a read-only allow immediately because it has no mutation to couple to", async () => {
    const { db, companyId, audit } = createLiveAuthorityDb();
    const authentication = await boardAuthService(db).authenticateBoardApiKey(TOKEN);
    const req = requestFor(authentication, "GET");
    const metadata = lookupBoardKeyRoute("GET", `/api/companies/${companyId}/issues`);
    const context = createBoardKeyAuditContext();

    await runWithBoardKeyAuditContext(context, () => authorizeBoardKey(
      db,
      req,
      metadata.action,
      async () => ({ companyId, resourceType: "company", resourceId: companyId }),
      metadata,
    ));

    expect(context.pending).toBeNull();
    expect(audit.at(-1)).toMatchObject({ decision: "allow", action: "issues:read" });
  });

  it("fails closed before side effects when a detached allow audit cannot be persisted", async () => {
    const { db, companyId } = createLiveAuthorityDb();
    const authentication = await boardAuthService(db).authenticateBoardApiKey(TOKEN);
    const req = requestFor(authentication);
    const metadata = lookupBoardKeyRoute("POST", `/api/companies/${companyId}/issues`);
    db.insert = vi.fn(() => ({ values: vi.fn().mockRejectedValue(new Error("audit unavailable")) }));
    const sideEffect = vi.fn();

    // No request context, so the gate cannot couple the disposition to a
    // transaction and must persist it before the caller proceeds.
    try {
      await authorizeBoardKey(
        db,
        req,
        metadata.action,
        async () => ({ companyId, resourceType: "company", resourceId: companyId }),
        metadata,
      );
      sideEffect();
    } catch (error) {
      expect(error).toMatchObject({ status: 500 });
    }
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("allows only self-revoke without requiring instance admin or a company pin", async () => {
    const { db, key } = createLiveAuthorityDb();
    const authentication = await boardAuthService(db).authenticateBoardApiKey(TOKEN);
    const req = requestFor(authentication);
    req.actor.isInstanceAdmin = false;
    req.actor.companyIds = [];
    req.actor.memberships = [];
    const ownMetadata = lookupBoardKeyRoute("DELETE", `/api/board-api-keys/${key.id}`);

    await expect(authorizeBoardKey(
      db,
      req,
      ownMetadata.action,
      async () => ({ companyId: null, resourceType: "board_api_key", resourceId: key.id }),
      ownMetadata,
    )).resolves.toBeUndefined();

    const otherKeyId = randomUUID();
    const otherMetadata = lookupBoardKeyRoute("DELETE", `/api/board-api-keys/${otherKeyId}`);
    await expectDenied(authorizeBoardKey(
      db,
      req,
      otherMetadata.action,
      async () => ({ companyId: null, resourceType: "board_api_key", resourceId: otherKeyId }),
      otherMetadata,
    ), 404);
  });

  it("applies owner suspension, removal, demotion, admin loss, and deletion on the next request", async () => {
    const { db, state, companyId } = createLiveAuthorityDb();
    const service = boardAuthService(db);
    const companyMetadata = lookupBoardKeyRoute("POST", `/api/companies/${companyId}/issues`);
    const instanceMetadata = lookupBoardKeyRoute("POST", "/api/instance/settings");

    state.membershipActive = false; // suspension
    let authentication = await service.authenticateBoardApiKey(TOKEN);
    await expectDenied(authorizeBoardKey(
      db,
      requestFor(authentication),
      companyMetadata.action,
      async () => ({ companyId, resourceType: "company", resourceId: companyId }),
      companyMetadata,
    ), 404);

    state.membershipActive = false; // removal has the same effective-authority result
    authentication = await service.authenticateBoardApiKey(TOKEN);
    expect(authentication.ok && authentication.access.companyIds).toEqual([]);

    state.membershipActive = true;
    state.membershipRole = "viewer"; // demotion
    authentication = await service.authenticateBoardApiKey(TOKEN);
    await expectDenied(authorizeBoardKey(
      db,
      requestFor(authentication),
      companyMetadata.action,
      async () => ({ companyId, resourceType: "company", resourceId: companyId }),
      companyMetadata,
    ), 403);

    state.membershipRole = "owner";
    state.instanceAdmin = false; // instance-admin role removed
    authentication = await service.authenticateBoardApiKey(TOKEN);
    await expectDenied(authorizeBoardKey(
      db,
      requestFor(authentication),
      instanceMetadata.action,
      async () => ({ companyId: null, resourceType: "instance", resourceId: null }),
      instanceMetadata,
    ), 403);

    state.ownerExists = false; // owner deletion rejects authentication itself
    authentication = await service.authenticateBoardApiKey(TOKEN);
    expect(authentication).toMatchObject({ ok: false, reason: "owner_deleted" });
  });

  it("applies owner permission-grant revocation on the next request", async () => {
    const { db, state, companyId } = createLiveAuthorityDb();
    const authentication = await boardAuthService(db).authenticateBoardApiKey(TOKEN);
    const req = requestFor(authentication);
    const metadata = lookupBoardKeyRoute("PATCH", `/api/agents/${randomUUID()}`);

    await expect(authorizeBoardKey(
      db,
      req,
      metadata.action,
      async () => ({ companyId, resourceType: "agent", resourceId: randomUUID() }),
      metadata,
    )).resolves.toBeUndefined();

    state.permissionGrants.delete("agents:configure");
    await expectDenied(authorizeBoardKey(
      db,
      req,
      metadata.action,
      async () => ({ companyId, resourceType: "agent", resourceId: randomUUID() }),
      metadata,
    ), 403);
  });

  it("applies owner permission-grant revocation to company collections on the next request", async () => {
    const { db, state, companyId } = createLiveAuthorityDb();
    const authentication = await boardAuthService(db).authenticateBoardApiKey(TOKEN);
    const req = requestFor(authentication);
    const metadata = {
      ...lookupBoardKeyRoute("GET", "/api/companies"),
      action: "agents:write" as const,
    };

    await expect(authorizeBoardKey(
      db,
      req,
      metadata.action,
      async () => ({ companyId: null, resourceType: "company_collection", resourceId: null }),
      metadata,
    )).resolves.toBeUndefined();

    state.permissionGrants.delete("agents:configure");
    await expectDenied(authorizeBoardKey(
      db,
      req,
      metadata.action,
      async () => ({ companyId: null, resourceType: "company_collection", resourceId: null }),
      metadata,
    ), 403);
  });
});
