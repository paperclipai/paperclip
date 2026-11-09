import type { Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { authorizationDeniedDetails, type AuthorizationActor } from "./authorization.js";

type ResolvableSecretProposal = {
  kind: string;
  targetId: string | null;
};

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
