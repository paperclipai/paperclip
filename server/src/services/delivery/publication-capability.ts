import { forbidden } from "../../errors.js";

/**
 * Publication capability binding.
 *
 * The capability is the runtime tools token (scope `github_credentials`) minted
 * for a specific agent run. Company scope alone is not enough: the claims must
 * match the authenticated actor, so a capability minted for one agent or run
 * cannot be replayed by another inside the same company.
 */
export type PublicationCapabilityClaims = {
  company_id: string;
  sub: string;
  run_id: string;
};

export type PublicationActor = {
  type: "board" | "agent" | "none";
  agentId?: string | null;
  runId?: string | null;
};

export function assertPublicationCapabilityBinding(input: {
  claims: PublicationCapabilityClaims;
  companyId: string;
  actor: PublicationActor;
}): void {
  if (input.claims.company_id !== input.companyId) {
    throw forbidden("Publication capability is scoped to another company");
  }
  if (input.actor.type !== "agent") {
    throw forbidden("Publication capability requires agent runtime authentication");
  }
  if (!input.actor.agentId || input.claims.sub !== input.actor.agentId) {
    throw forbidden("Publication capability is bound to another agent");
  }
  if (!input.actor.runId || input.claims.run_id !== input.actor.runId) {
    throw forbidden("Publication capability is bound to another run");
  }
}
