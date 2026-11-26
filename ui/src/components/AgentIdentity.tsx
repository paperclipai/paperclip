import { AgentAvatar, type AvatarAgent } from "./AgentAvatar";
import { cn } from "@/lib/utils";
export function AgentIdentity({ agent, size = "default", className }: { agent: AvatarAgent; size?: "xs" | "sm" | "default" | "lg"; className?: string }) {
  const pixels = { xs: 20, sm: 24, default: 32, lg: 40 } as const;
  return <span title={agent.name} className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
    <AgentAvatar agent={agent} size={pixels[size]} />
    <span className={cn("truncate", size === "sm" ? "text-xs" : "text-sm")}>{agent.name ?? "Agent"}</span>
  </span>;
}
