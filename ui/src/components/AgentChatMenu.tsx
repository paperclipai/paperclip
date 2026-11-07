import { Archive, Loader2, MoreHorizontal } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { agentRouteRef, cn } from "@/lib/utils";

/** Agent states that are already leaving, so archiving again has nothing to do. */
const ENDED_LIFECYCLE_STATES = ["terminating", "cleaning_up", "terminated", "rejected"];

export function canArchiveAgentFromChat(agent: Pick<Agent, "status" | "lifecycleState">) {
  return agent.status !== "terminated" && !ENDED_LIFECYCLE_STATES.includes(agent.lifecycleState ?? "");
}

/**
 * The per-agent ⋯ menu in the chat contact list. "Archive agent" uses the
 * agent detail page's Terminate action, behind a confirmation.
 */
export function AgentChatMenu({ agent, userId, onArchived, className }: {
  agent: Agent; userId: string | null; onArchived?: (agent: Agent) => void; className?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const archive = useMutation({
    mutationFn: () => agentsApi.terminate(agent.id, agent.companyId),
    onSuccess: (archived) => {
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentRouteRef(agent)) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentChats.list(agent.companyId, userId) });
      onArchived?.(archived);
    },
    onError: (error) => {
      pushToast({ title: "Couldn’t archive agent", body: error instanceof Error ? error.message : "Try again.", tone: "error" });
    },
  });
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Open actions for ${agent.name}`} title={`Actions for ${agent.name}`}
          onClick={event => event.stopPropagation()}
          className={cn("agent-chat-pin agent-chat-menu flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100 group-hover/agent-pin:opacity-100 group-focus-within/agent-pin:opacity-100 pointer-coarse:opacity-100", className)}>
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem variant="destructive" disabled={archive.isPending} onSelect={() => setConfirmOpen(true)}>
          <Archive className="size-4" />
          <span>Archive agent</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <AlertDialog open={confirmOpen} onOpenChange={open => { if (!archive.isPending) setConfirmOpen(open); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {agent.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This terminates the agent. It stops running and leaves your chat list. You can still read its chat history. You can’t undo this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={archive.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={archive.isPending}
            onClick={event => { event.preventDefault(); archive.mutate(); }}>
            {archive.isPending && <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />}
            Archive agent
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
