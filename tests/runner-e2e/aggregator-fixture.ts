import type { RunnerApi } from "./api.js";
import { startReviewProvider } from "../fixtures/connection-review-provider.js";

/** Deterministic Arcade gateway; the real Paperclip transport, grants and agent are exercised. */
export async function setupAggregatorFixture(
  api: RunnerApi,
  companyId: string,
  agentId: string,
  marker: string,
  requireAccessApproval = false,
) {
  const provider = await startReviewProvider(
    `Contacts: Ada Fixture. Verification code: ${marker}`,
    undefined,
    {
      name: "Hubspot_ListContacts",
      title: "List HubSpot contacts",
      description: "Read recent HubSpot contacts from this authorized gateway.",
    },
  );
  try {
    const connected = await api.post<any>(
      `/api/companies/${companyId}/tools/apps/connect`,
      {
        name: "Arcade fixture",
        link: provider.url,
        authMode: "none",
        grantKind: "organization",
      },
    );
    // Import a reachable fixture MCP endpoint through the normal generic path,
    // then tag its provider via the public configuration API. Branded Arcade
    // setup correctly rejects localhost as an official Arcade gateway URL.
    const connection = await api.get<any>(
      `/api/tool-connections/${connected.connectionId}`,
    );
    await api.patch(`/api/tool-connections/${connected.connectionId}`, {
      config: { ...connection.config, sourceTemplateKey: "arcade" },
    });
    await api.post(
      `/api/companies/${companyId}/tools/apps/${connected.connectionId}/finish`,
      {
        enabledCatalogEntryIds: [
          ...connected.actions.readOnly,
          ...connected.actions.canMakeChanges,
        ].map((action: any) => action.catalogEntryId),
        askFirstCatalogEntryIds: [],
        access: { agentIds: requireAccessApproval ? [] : [agentId] },
      },
    );
    const installed = await api.request.put(
      `/api/tool-connections/${connected.connectionId}/installs`,
      { data: { installs: requireAccessApproval ? [] : [{ targetType: "agent", targetId: agentId }] } },
    );
    if (!installed.ok())
      throw new Error("Could not install the aggregator fixture");
    const effective = await api.get<any>(`/api/companies/${companyId}/tools/profiles/effective/agents/${agentId}`);
    if (requireAccessApproval && (effective.installedConnections.some((c: any) => c.id === connected.connectionId)
      || effective.allowedTools.some((tool: any) => tool.connectionId === connected.connectionId))) {
      throw new Error("Provider-choice fixture unexpectedly grants tool access before the user's decision");
    }
    return {
      ...provider,
      connectionId: connected.connectionId as string,
      catalogEntryIds: [...connected.actions.readOnly, ...connected.actions.canMakeChanges].map((action: any) => action.catalogEntryId as string),
      initialAccess: { installed: effective.installedConnections.some((c: any) => c.id === connected.connectionId),
        allowedToolIds: effective.allowedTools.filter((tool: any) => tool.connectionId === connected.connectionId).map((tool: any) => tool.id) },
      invocationCount: () =>
        provider.captures.filter((call) => call.method === "tools/call").length,
    };
  } catch (error) {
    await provider.close();
    throw error;
  }
}
