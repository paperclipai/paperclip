import type { RunnerApi } from "./api.js";
import { startReviewProvider } from "../fixtures/connection-review-provider.js";

/** Deterministic Arcade gateway; the real Paperclip transport, grants and agent are exercised. */
export async function setupAggregatorFixture(
  api: RunnerApi,
  companyId: string,
  agentId: string,
  marker: string,
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
        access: { agentIds: [agentId] },
      },
    );
    const installed = await api.request.put(
      `/api/tool-connections/${connected.connectionId}/installs`,
      { data: { installs: [{ targetType: "agent", targetId: agentId }] } },
    );
    if (!installed.ok())
      throw new Error("Could not install the aggregator fixture");
    return {
      ...provider,
      invocationCount: () =>
        provider.captures.filter((call) => call.method === "tools/call").length,
    };
  } catch (error) {
    await provider.close();
    throw error;
  }
}
