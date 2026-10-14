import { appearanceForPalette, type Agent } from "@paperclipai/shared";
import { storybookAgents } from "../../fixtures/paperclipData";

export type SidebarScenario = "conversation" | "landing" | "large-team";

// Keep the first identity compatible with the existing chat fixture controller.
export const sidebarAgents: Agent[] = [
  { id: "agent-codex", urlKey: "researcher", name: "Researcher", title: "Customer & market research", palette: "arctic-blue" },
  { id: "chat-analyst", urlKey: "analyst", name: "Analyst", title: "Feedback analysis", palette: "orchid-peach" },
  { id: "chat-writer", urlKey: "writer", name: "Writer", title: "Client updates & drafts", palette: "solar-flare" },
  { id: "chat-strategist", urlKey: "strategist", name: "Strategist", title: "Planning & priorities", palette: "lime-lagoon" },
].map(({ palette, ...agent }) => ({
  ...storybookAgents[0],
  ...agent,
  role: "general",
  status: "idle",
  reportsTo: null,
  appearance: appearanceForPalette(palette as Parameters<typeof appearanceForPalette>[0]),
}));

export function sidebarRoster(scenario: SidebarScenario = "conversation"): Agent[] {
  const roles = ["Product Designer", "Support Specialist", "Growth Marketer", "Security Engineer", "Data Scientist", "Finance Analyst", "Customer Success", "Content Editor", "QA Engineer", "Operations Lead", "Community Manager", "Product Engineer", "Technical Writer", "Recruiter", "Sales Researcher", "Release Engineer"];
  return [...sidebarAgents, ...roles.slice(0, scenario === "large-team" ? roles.length : 4).map((title, index) => ({
    ...sidebarAgents[index % sidebarAgents.length],
    id: `sidebar-agent-${index}`, urlKey: `teammate-${index}`, name: title, title,
  }))];
}

export const sidebarPreviews: Record<string, string> = {
  "agent-codex": "Clarifying your request",
  "chat-analyst": "Feedback analysis",
  "chat-writer": "Client update draft",
  "chat-strategist": "Weekly priorities",
};
