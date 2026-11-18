import { McpOAuthError, type PublicMcpOAuth } from "../../services/public-mcp/oauth.js";

type DotOAuthPrincipalOwner = Pick<PublicMcpOAuth, "mode" | "config" | "authenticate">;
export interface DotOriginalTokenPrincipal {
  userId: string;
  companyId: string;
  grantId: string;
  clientId: string;
  resource: string;
  purpose: "agent";
}
export async function readDotOriginalTokenPrincipal(oauth: DotOAuthPrincipalOwner, input: {
  accessToken: string;
  upstreamClientId: string;
  selectingUserId: string;
  canonicalVerifiedResource: string;
  requestedCompanyId?: string;
}): Promise<DotOriginalTokenPrincipal> {
  const deny = () => new McpOAuthError("invalid_grant", "Dot connection authority does not match the selected request.");
  let origin: string;
  try { origin = new URL(input.canonicalVerifiedResource).origin; } catch { throw deny(); }
  if (oauth.mode !== "openai_dot_agent" || input.canonicalVerifiedResource !== origin + "/mcp/runner"
    || oauth.config.origin !== origin || oauth.config.resource !== input.canonicalVerifiedResource) throw deny();
  const { grant, company } = await oauth.authenticate(input.accessToken);
  if (grant.purpose !== "agent" || !grant.scopes.includes("paperclip:agent")
    || !grant.id || !grant.companyId || company.id !== grant.companyId
    || !input.upstreamClientId || grant.clientId !== input.upstreamClientId
    || !input.selectingUserId || grant.userId !== input.selectingUserId
    || grant.resource !== input.canonicalVerifiedResource
    || input.requestedCompanyId !== undefined && grant.companyId !== input.requestedCompanyId) throw deny();
  return { userId: grant.userId, companyId: grant.companyId, grantId: grant.id, clientId: grant.clientId, resource: grant.resource, purpose: "agent" };
}
