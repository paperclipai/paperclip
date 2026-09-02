import { and, eq } from "drizzle-orm";
import { companies, companyMemberships, instanceSettings, type Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { authorizationDeniedDetails, type AuthorizationActor } from "./authorization.js";
import { boardAuthService } from "./board-auth.js";

type ResolvableSecretProposal = {
  kind: string;
  targetId: string | null;
};

async function refreshCloudTenantElevation(db: Db, actor: AuthorizationActor) {
  if (
    actor.type !== "board" ||
    actor.source !== "cloud_tenant" ||
    !actor.isInstanceAdmin
  ) {
    return actor;
  }

  // The request-time bit proves the trusted-header stack-owner attestation,
  // but the operator can revoke its elevation while the request is waiting on
  // proposal locks. Lock the authoritative settings row inside the governed
  // transaction and refresh the mutable flag. A concurrent settings UPDATE
  // then either commits before this read (and is observed) or waits until the
  // proposal mutation commits.
  const settings = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .for("update")
    .then((rows) => rows[0] ?? null);
  return {
    ...actor,
    isInstanceAdmin: settings?.experimental?.enableOwnerInstanceAdmin === true,
  };
}

export async function assertCanResolveProposal(input: {
  db: Db;
  actor: AuthorizationActor;
  companyId: string;
  proposal: ResolvableSecretProposal;
}) {
  const actor = await refreshCloudTenantElevation(input.db, input.actor);
  const company = await input.db
    .select({ status: companies.status })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  if (company?.status !== "active") throw forbidden("Company is not active");

  if (input.proposal.kind === "secret") {
    if (actor.type !== "board") throw forbidden("Company admin access required");
    if (actor.source === "local_implicit") return;

    // Cloud-tenant elevation is attested for each request and has no
    // instance_user_roles row to refresh. Membership authority still comes
    // from the database and must be re-read after the principal authorization
    // lock so a concurrent revocation cannot lose to a request-time snapshot.
    // All other board actors refresh both role and membership through the
    // board access service for the same reason.
    if (actor.source === "cloud_tenant") {
      const membership = actor.userId
        ? await input.db
            .select({
              membershipRole: companyMemberships.membershipRole,
              status: companyMemberships.status,
            })
            .from(companyMemberships)
            .where(and(
              eq(companyMemberships.companyId, input.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, actor.userId),
            ))
            .then((rows) => rows[0] ?? null)
        : null;
      if (
        actor.isInstanceAdmin ||
        (membership?.status === "active" && ["owner", "admin"].includes(String(membership.membershipRole)))
      ) return;
      throw forbidden("Company admin access required");
    }

    if (!actor.userId) throw forbidden("Company admin access required");
    const access = await boardAuthService(input.db).resolveBoardAccess(actor.userId);
    const membership = access.memberships.find((item) => item.companyId === input.companyId);
    if (
      access.isInstanceAdmin ||
      (membership?.status === "active" && ["owner", "admin"].includes(String(membership.membershipRole)))
    ) return;
    throw forbidden("Company admin access required");
  }
  if (input.proposal.kind !== "binding" || !input.proposal.targetId) {
    throw unprocessable("Binding proposal target is missing");
  }
  // Session actors may carry an instance-admin bit computed at authentication
  // time. Governed proposal mutations re-run this check after acquiring the
  // principal authorization lock, so force non-cloud actors to consult the
  // authoritative instance_user_roles row instead of trusting that cached bit.
  // Cloud-tenant elevation is separately attested and is not backed by that
  // table; local implicit board access is handled by its source policy.
  const authoritativeActor = actor.type === "board" && actor.source !== "cloud_tenant"
    ? { ...actor, isInstanceAdmin: false }
    : actor;
  const decision = await accessService(input.db).decide({
    actor: authoritativeActor,
    action: "agent_config:update",
    resource: {
      type: "agent",
      companyId: input.companyId,
      agentId: input.proposal.targetId,
    },
    scope: { requiresChangeGrant: true },
  });
  if (!decision.allowed) {
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
}
