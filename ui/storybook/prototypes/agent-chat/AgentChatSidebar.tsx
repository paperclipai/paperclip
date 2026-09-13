import { storybookAgents } from "../../fixtures/paperclipData";

export const chatAgents = [
  ...storybookAgents,
  {
    ...storybookAgents[0],
    id: "chat-design",
    urlKey: "design-lead",
    name: "Design Lead",
    icon: "palette",
  },
  {
    ...storybookAgents[0],
    id: "chat-research",
    urlKey: "researcher",
    name: "Researcher",
    icon: "search",
  },
  {
    ...storybookAgents[0],
    id: "chat-ops",
    urlKey: "operations",
    name: "Operations",
    icon: "settings",
  },
];
export const chatIdentifier = (id: string) =>
  id === "agent-codex"
    ? "PAP-241"
    : `PAP-${249 + chatAgents.findIndex((agent) => agent.id === id)}`;
export const chatHref = (id: string) =>
  `/issues/${chatIdentifier(id)}?chatAgent=${encodeURIComponent(id)}`;

import { AgentChatSidebar as ProductionAgentChatSidebar } from "@/components/AgentChatSidebar";
export function AgentChatSidebar(props: {
  activeId: string;
  starredIds: string[];
  recentIds: string[];
  onToggleStar: (id: string) => void;
  agents?: typeof chatAgents;
}) {
  return (
    <ProductionAgentChatSidebar
      {...props}
      agents={props.agents ?? chatAgents}
      href={chatHref}
    />
  );
}
