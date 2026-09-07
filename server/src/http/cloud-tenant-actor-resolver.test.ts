import { describe, expect, it } from "bun:test";
import type { Db } from "@paperclipai/db";
import type { HttpActor } from "./actor-context.js";
import {
  createCloudTenantActorResolver,
  type LegacyCloudTenantActorResolver,
} from "./cloud-tenant-actor-resolver.js";

const legacyBoardActor = {
  type: "board" as const,
  userId: "user-123",
  userName: "Cloud Owner",
  userEmail: "owner@example.com",
  companyIds: ["company-primary", "company-imported"],
  memberships: [
    { companyId: "company-primary", membershipRole: "owner", status: "active" },
    { companyId: "company-imported", membershipRole: "member", status: "active" },
  ],
  isInstanceAdmin: true,
  source: "cloud_tenant" as const,
};

function createResolver(
  resolveLegacy: LegacyCloudTenantActorResolver,
): ReturnType<typeof createCloudTenantActorResolver> {
  return createCloudTenantActorResolver({} as Db, resolveLegacy);
}

describe("cloud tenant actor resolver", () => {
  it("maps the legacy cloud actor to the typed HTTP actor", async () => {
    let receivedHeader: string | undefined;
    const resolveLegacy: LegacyCloudTenantActorResolver = async (_db, headers) => {
      receivedHeader = headers.header("x-paperclip-cloud-user-id");
      return legacyBoardActor;
    };
    const resolveActor = createResolver(resolveLegacy);

    const request = new Request("http://localhost/api/health", {
      headers: {
        "x-paperclip-cloud-user-id": "user-123",
        "x-paperclip-run-id": "run-456",
      },
    });

    const actor = await resolveActor(request);

    expect(receivedHeader).toBe("user-123");
    expect(actor).toEqual({
      type: "board",
      source: "cloud_tenant",
      userId: "user-123",
      userName: "Cloud Owner",
      userEmail: "owner@example.com",
      companyIds: ["company-primary", "company-imported"],
      memberships: legacyBoardActor.memberships,
      isInstanceAdmin: true,
      runId: "run-456",
    } satisfies HttpActor);
  });

  it("returns null when cloud credentials are not resolved", async () => {
    const resolveActor = createResolver(async (_db, headers) => {
      if (!headers.header("x-paperclip-cloud-tenant-token")) return null;
      return legacyBoardActor;
    });

    const actor = await resolveActor(
      new Request("http://localhost/api/health"),
    );

    expect(actor).toBeNull();
  });

  it("fails closed when the legacy resolver throws", async () => {
    const resolveActor = createResolver(async () => {
      throw new Error("missing trusted cloud header");
    });

    const actor = await resolveActor(
      new Request("http://localhost/api/health"),
    );

    expect(actor).toBeNull();
  });

  it("does not map non-board legacy actors into board authority", async () => {
    const resolveActor = createResolver(async () => ({
      type: "agent",
      companyId: "company-primary",
    }));

    const actor = await resolveActor(
      new Request("http://localhost/api/health"),
    );

    expect(actor).toBeNull();
  });
});
