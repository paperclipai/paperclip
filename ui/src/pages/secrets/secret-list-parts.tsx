import type { ReactNode } from "react";
import type { Agent } from "@paperclipai/shared";
import { Building2, ChevronRight, CircleHelp, Users } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../../lib/utils";
import type { SecretOriginGroup } from "./secret-origin";

/** Which agents hold the secret; falls back to other places it is set, then to "Not used yet". */
export function SecretUsedBy({ agents, otherUseCount = 0 }: { agents: readonly Agent[]; otherUseCount?: number }) {
  if (agents.length === 0) {
    return (
      <span className="truncate text-sm text-muted-foreground">
        {otherUseCount > 0 ? `Set in ${otherUseCount} ${otherUseCount === 1 ? "place" : "places"}` : "Not used yet"}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <span className="flex shrink-0 -space-x-1.5">
        {agents.slice(0, 3).map((agent) => (
          <AgentAvatar key={agent.id} agent={agent} size={24} className="ring-2 ring-background" />
        ))}
      </span>
      <span className="truncate text-muted-foreground">
        {agents.length === 1 ? agents[0].name : `${agents.length} agents`}
      </span>
    </span>
  );
}

/** Who supplies the value: the organization, or each user (with how many have). */
export function SecretProvidedBy({ perUser, coverage }: { perUser: boolean; coverage?: ReactNode }) {
  const Icon = perUser ? Users : Building2;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {perUser ? "Each user" : "Organization"}
        {perUser && coverage ? <> · {coverage}</> : null}
      </span>
    </span>
  );
}

export function HowSecretsWork() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground">
          <CircleHelp className="h-3.5 w-3.5" aria-hidden />
          How secrets work
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-sm">
        <ol className="flex list-decimal flex-col gap-2 pl-4 text-muted-foreground">
          <li>Add a secret once. The organization provides one shared value, or each user adds their own.</li>
          <li>Choose which agents can use it, here or in an agent&apos;s settings. A project can set it for every task in that project.</li>
          <li>
            When a run starts, the agent finds it as an environment variable, such as{" "}
            <code className="font-mono text-foreground">GITHUB_TOKEN</code>. The value is never shown again.
          </li>
        </ol>
      </PopoverContent>
    </Popover>
  );
}

/** One collapsible origin ("Connections", "Model sign-ins", …) inside Managed by Paperclip. */
export function ManagedSecretGroup({
  group,
  count,
  open,
  onToggle,
  children,
}: {
  group: SecretOriginGroup;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const Icon = group.icon;
  return (
    <div data-testid={`managed-secret-group-${group.id}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2.5 border-b border-border/60 px-3 py-2.5 text-left hover:bg-accent/40"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronRight
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")}
          aria-hidden
        />
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 text-sm font-medium">{group.label}</span>
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground @min-[40rem]:inline">{group.detail}</span>
        <span className="ml-auto shrink-0 text-sm tabular-nums text-muted-foreground">
          {count} {count === 1 ? "secret" : "secrets"}
        </span>
      </button>
      {open ? children : null}
    </div>
  );
}
