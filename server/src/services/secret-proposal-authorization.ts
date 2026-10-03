import type { Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { authorizationDeniedDetails, type AuthorizationActor } from "./authorization.js";

type ResolvableSecretProposal = {
  kind: string;
  targetId: string | null;
};

export function hasSecretDefinitionAdminAccess(
  actor: AuthorizationActor,
  companyId: string,
): boolean {
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
  const membership = actor.memberships?.find((item) => item.companyId === companyId);
  return (
    membership?.status === "active" &&
    ["owner", "admin"].includes(String(membership?.membershipRole))
  );
}

export function assertSecretDefinitionAdmin(
  actor: AuthorizationActor,
  companyId: string,
): void {
  if (hasSecretDefinitionAdminAccess(actor, companyId)) return;
  throw forbidden("Company admin access required");
}

export async function assertCanResolveProposal(input: {
  db: Db;
  actor: AuthorizationActor;
  companyId: string;
  proposal: ResolvableSecretProposal;
  assertSecretDefinitionAdmin?: () => void;
}) {
  if (input.proposal.kind === "secret") {
    if (!input.assertSecretDefinitionAdmin) {
      throw forbidden("Company admin access required");
    }
    input.assertSecretDefinitionAdmin();
    return;
  }
  if (input.proposal.kind !== "binding" || !input.proposal.targetId) {
    throw unprocessable("Binding proposal target is missing");
  }
  const decision = await accessService(input.db).decide({
    actor: input.actor,
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
