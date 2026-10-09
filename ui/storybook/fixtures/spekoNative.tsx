import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents } from "./paperclipData";

export const spekoCompanyId = "company-storybook";
export const spekoAgent = { ...storybookAgents[0]!, name: "Company Phone Agent" };
export const spekoEndpoint: ChatEndpoint = {
  id: "voice-endpoint-fixture", companyId: spekoCompanyId, provider: "speko", status: "active",
  assignedAgentId: spekoAgent.id, assignedAgentName: spekoAgent.name,
  botLabel: "Company reception", providerAccountLabel: "Speko workspace", allowUnlinkedPeople: false,
  setup: { step: "complete", webhookUrl: "https://paperclip.example/api/voice-webhooks/fixture/tools" },
  conversations: [], activity: [], resources: [], identityLinks: [],
};
export function SpekoQueryFixture({ children, endpoints = [spekoEndpoint], enabled = true }: { children: ReactNode; endpoints?: ChatEndpoint[]; enabled?: boolean }) {
  const [client] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false, refetchOnWindowFocus: false } } });
    client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: enabled });
    client.setQueryData(queryKeys.chatEndpoints.list(spekoCompanyId), endpoints);
    client.setQueryData(["task-voice-endpoints", spekoCompanyId], endpoints);
    for (const endpoint of endpoints) client.setQueryData(queryKeys.chatEndpoints.detail(endpoint.id), endpoint);
    return client;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
