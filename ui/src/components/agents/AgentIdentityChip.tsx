import type { Agent } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";

export const agentIdentityChipClass = "agent-identity-chip inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs";

export function AgentIdentityChipContent({ agent }: { agent: Agent }) {
  return <><AgentAvatar agent={agent} size={20} /><span className="truncate">{agent.name}</span></>;
}
