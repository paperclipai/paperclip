import type { ChatCatalogContext, ChatCatalogQueryBinding } from "./chat-catalog-contract.js";

const allowedCatalogTokens: Readonly<Record<string, readonly string[]>> = {
  "access.other-company": ["BIRCH-42"], "projects.add-repository": ["acorn/site"],
  "projects.replace-repository": ["acorn/site-old", "acorn/site-new"],
  "workspaces.prepare-repository": ["acorn/site"], "workspaces.private-repository-no-access": ["acorn/site"],
  "chat-channels.outbound-email":["reviewer@example.test"],
};
const allowedResourceKinds: Readonly<Record<string, string>> = { "access.other-company": "issue",
  "projects.add-repository": "project-repository", "projects.replace-repository": "project-repository",
  "workspaces.prepare-repository": "project-repository", "workspaces.private-repository-no-access": "project-repository","chat-channels.outbound-email":"agentmail-recipient" };
export interface RenderedChatQuery {
  originalQuery: string; renderedQuery: string;
  bindings: Array<{ catalogToken: string; fixtureValue: string; resourceKind: "issue" | "project-repository" | "agentmail-recipient"; resourceId: string | number; companyId: string; connectionId?: string }>;
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function safeFixtureEmail(value:unknown):value is string{return typeof value==="string"&&value.length<=254&&!/[\r\n\s<>]/.test(value)&&!value.includes("..")&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value);}
export function renderChatCatalogQuery(scenarioId: string, originalQuery: string, specs: readonly ChatCatalogQueryBinding[] = [], state: Record<string, unknown>): RenderedChatQuery {
  let renderedQuery = originalQuery; const bindings: RenderedChatQuery["bindings"] = [];
  for (const spec of specs) {
    if (!allowedCatalogTokens[scenarioId]?.includes(spec.catalogToken) || spec.resourceKind !== allowedResourceKinds[scenarioId] || spec.valueField !== (spec.resourceKind === "issue" ? "identifier" : spec.resourceKind==="agentmail-recipient"?"email":"fullName")
      || bindings.some(row => row.catalogToken === spec.catalogToken) || originalQuery.split(spec.catalogToken).length !== 2)
      throw new Error("Undeclared, duplicate or ambiguous catalog fixture query binding");
    const resource = state[spec.stateKey] as { id?: unknown; companyId?: unknown; identifier?: unknown; fullName?: unknown; connectionId?: unknown;email?:unknown } | undefined;
    if (!resource || typeof resource.companyId !== "string" || !resource.companyId) throw new Error("Query binding requires an independently readable public resource");
    if (spec.resourceKind === "issue") {
      if (typeof resource.id !== "string" || !resource.id || typeof resource.identifier !== "string" || !/^[A-Z]+-\d+$/.test(resource.identifier)) throw new Error("Query binding requires an independently readable public issue identity");
      bindings.push({ catalogToken: spec.catalogToken, fixtureValue: resource.identifier, resourceKind: "issue", resourceId: resource.id, companyId: resource.companyId });
    } else if(spec.resourceKind==="agentmail-recipient"){
      if(typeof resource.id!=="string"||!uuid.test(resource.id)||typeof resource.connectionId!=="string"||!uuid.test(resource.connectionId)||!safeFixtureEmail(resource.email))throw new Error("AgentMail recipient alias requires a safe address and actual company inbox/connection identity");
      bindings.push({catalogToken:spec.catalogToken,fixtureValue:resource.email,resourceKind:"agentmail-recipient",resourceId:resource.id,companyId:resource.companyId,connectionId:resource.connectionId});
    } else {
      if (!Number.isSafeInteger(resource.id) || Number(resource.id) <= 0 || typeof resource.connectionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(resource.connectionId)
        || typeof resource.fullName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(resource.fullName)) throw new Error("Repository query binding requires a numeric provider identity and current connection");
      bindings.push({ catalogToken: spec.catalogToken, fixtureValue: resource.fullName, resourceKind: "project-repository", resourceId: resource.id as number, companyId: resource.companyId, connectionId: resource.connectionId });
    }
  }
  // Apply positions from the original query, so a real identity cannot be rewritten as a later alias.
  for (const binding of [...bindings].sort((a, b) => originalQuery.indexOf(b.catalogToken) - originalQuery.indexOf(a.catalogToken))) {
    const index = originalQuery.indexOf(binding.catalogToken);
    renderedQuery = renderedQuery.slice(0, index) + binding.fixtureValue + renderedQuery.slice(index + binding.catalogToken.length);
  }
  return { originalQuery, renderedQuery, bindings };
}
export async function resolveChatCatalogQuery(ctx: ChatCatalogContext, specs: readonly ChatCatalogQueryBinding[] | undefined, state: Record<string, unknown>) {
  const rendered = renderChatCatalogQuery(ctx.scenario.id, ctx.scenario.query, specs, state);
  for (const binding of rendered.bindings) {
    if (binding.resourceKind === "issue") {
      const saved = await ctx.input.api.get<{ id: string; companyId: string; identifier: string }>(`/api/issues/${binding.resourceId}`);
      if (saved.id !== binding.resourceId || saved.companyId !== binding.companyId || saved.identifier !== binding.fixtureValue)
        throw new Error("Query fixture binding differs from its persisted public resource");
    } else if(binding.resourceKind==="agentmail-recipient"){
      if(!ctx.input.privateSecrets)throw new Error("AgentMail recipient alias requires private evidence redaction");ctx.input.privateSecrets.push(binding.fixtureValue);
      const config=ctx.input.privateInputs?.configuration("external-provider") as {providers?:{agentmail?:{disposable?:boolean;resourceIds?:string[];prerequisites?:Record<string,string>}}}|undefined,provider=config?.providers?.agentmail,p=provider?.prerequisites;
      if(provider?.disposable!==true||p?.recipientAuthorization!=="self-addressed-only"||p.recipient!==binding.fixtureValue||p.inboxId!==binding.fixtureValue||!provider.resourceIds?.includes(p.inboxId)||binding.companyId!==ctx.input.fixtures.company.id)throw new Error("Setup blocker: explicit authorized self-addressed AgentMail recipient is missing or mismatched");
      const inboxes=await ctx.input.api.get<Array<{id:string;companyId:string;connectionId:string;assignedAgentId:string;address:string|null;status:string}>>(`/api/companies/${binding.companyId}/email/inboxes`);
      const endpoint=await ctx.input.api.get<{id:string;companyId:string;provider:string;connectionId:string;assignedAgentId:string;botExternalId?:string;status:string}>(`/api/chat-endpoints/${binding.resourceId}`);
      const connection=await ctx.input.api.get<{id:string;companyId:string;status:string;enabled:boolean;config?:{provider?:string}}>(`/api/tool-connections/${binding.connectionId}`);
      if(inboxes.filter(row=>row.id===binding.resourceId&&row.companyId===binding.companyId&&row.connectionId===binding.connectionId&&row.address===binding.fixtureValue&&row.status==="active"&&row.assignedAgentId===ctx.input.fixtures.agent.id).length!==1||endpoint.id!==binding.resourceId||endpoint.companyId!==binding.companyId||endpoint.provider!=="agentmail"||endpoint.connectionId!==binding.connectionId||endpoint.assignedAgentId!==ctx.input.fixtures.agent.id||endpoint.botExternalId!==binding.fixtureValue||endpoint.status!=="active"||connection.id!==binding.connectionId||connection.companyId!==binding.companyId||connection.status!=="active"||!connection.enabled||connection.config?.provider!=="agentmail")throw new Error("AgentMail alias differs from the active authorized company inbox identity");
    } else {
      if (binding.companyId !== ctx.input.fixtures.company.id) throw new Error("Repository binding belongs to another company");
      const discovery = await ctx.input.api.get<{ repositories: Array<{ id: string; fullName: string; connectionIds?: string[] }> }>(`/api/companies/${binding.companyId}/project-repositories`);
      const matches = discovery.repositories.filter(row => /^\d+$/.test(row.id) && Number(row.id) === binding.resourceId
        && row.fullName === binding.fixtureValue && row.connectionIds?.includes(binding.connectionId!));
      const connection = await ctx.input.api.get<{ id: string; companyId: string; status: string; enabled: boolean; config?: { sourceTemplateKey?: string } }>(`/api/tool-connections/${binding.connectionId}`);
      if (matches.length !== 1 || connection.id !== binding.connectionId || connection.companyId !== binding.companyId
        || connection.status !== "active" || !connection.enabled || connection.config?.sourceTemplateKey !== "github") throw new Error("Repository alias differs from active company-scoped provider discovery");
    }
  }
  return rendered;
}
