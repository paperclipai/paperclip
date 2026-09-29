import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, MessageSquare, Search } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { AgentChatPicker } from "@/components/AgentChatPicker";
export { SidebarAgentChats as ChatEntrySidebar } from "@/components/SidebarAgentChats";
import { useSidebar } from "@/context/SidebarContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { chatAgents } from "../agent-chat/AgentChatSidebar";

export type EntryScenario = "first-use" | "returning" | "picker" | "search" | "no-results" | "paused" | "large-team";

const titles: Record<string, string> = {
  "chat-design": "Product Designer", "chat-research": "Research Analyst", "chat-ops": "Operations Lead",
};
export const entryAgents: Agent[] = chatAgents.map((agent) => ({
  ...agent,
  title: titles[agent.id] ?? agent.title,
  status: agent.id === "chat-ops" ? "paused" : "idle",
}));
const extraRoles = ["Content Strategist", "Customer Researcher", "Data Analyst", "Support Specialist", "Growth Marketer", "Security Engineer"];
export function reviewRoster(scenario?: EntryScenario): Agent[] {
  return scenario === "large-team" ? [...entryAgents, ...extraRoles.map((title, index) => ({
    ...entryAgents[0], id: `extra-${index}`, urlKey: `extra-${index}`, name: title, title,
  }))] : entryAgents;
}

interface ReviewState {
  agents: Agent[];
  openPicker: () => void;
  choose: (agent: Agent) => void;
}
const ReviewContext = createContext<ReviewState | null>(null);
function useReview() {
  const value = useContext(ReviewContext);
  if (!value) throw new Error("Chat entry review provider is required");
  return value;
}

export function ChatEntryReviewProvider({ scenario, children }: { scenario: EntryScenario; children: ReactNode }) {
  const [open, setOpen] = useState(["picker", "search", "no-results", "large-team"].includes(scenario));
  const agents = reviewRoster(scenario);
  const navigate = useNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  function choose(agent: Agent) {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    navigate(`/chats/${encodeURIComponent(agentRouteRef(agent))}`);
  }
  return <ReviewContext.Provider value={{ agents, openPicker: () => setOpen(true), choose }}>
    {children}
    <AgentChatPicker agents={agents} open={open} onOpenChange={setOpen} onSelect={choose} />
  </ReviewContext.Provider>;
}

export function ChatEntryLanding() {
  const { agents, choose, openPicker } = useReview();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Chats" }]), [setBreadcrumbs]);
  const suggestions = ["agent-cto", "agent-codex", "chat-design"].flatMap((id) => agents.filter((a) => a.id === id));
  return <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-16">
    <div className="flex flex-col gap-3">
      <MessageSquare className="size-6 text-muted-foreground" />
      <h1 className="text-xl font-semibold">Who would you like to talk to?</h1>
      <p className="text-sm text-muted-foreground">Think through an idea, ask a question, or plan the next step with someone on your team.</p>
    </div>
    <div className="flex flex-col gap-1">
      {suggestions.map((agent) => <Button key={agent.id} variant="ghost" className="h-auto justify-start gap-3 px-3 py-3" onClick={() => choose(agent)}>
        <AgentIcon icon={agent.icon} className="size-5" />
        <span className="flex flex-1 flex-col items-start gap-1"><span>{agent.name}</span><span className="text-xs font-normal text-muted-foreground">{agent.title}</span></span>
        <ArrowRight className="size-4 text-muted-foreground" />
      </Button>)}
    </div>
    <Button variant="outline" className="self-start" onClick={openPicker}><Search className="size-4" />Browse all {agents.length} agents</Button>
    <p className="text-xs text-muted-foreground">Your conversations will appear in Chats. Star the people you talk to most.</p>
  </div>;
}
