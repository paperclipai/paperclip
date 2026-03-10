import { useQueryClient, useMutation } from "@tanstack/react-query";
import { Pause, Play, Trash2 } from "lucide-react";
import { AGENT_ACTIONABLE_STATUSES } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

interface StatusBadgeMenuProps {
  agentId: string;
  status: string;
  companyId: string;
}

export function StatusBadgeMenu({ agentId, status, companyId }: StatusBadgeMenuProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
  };

  const onError = (err: Error) => {
    pushToast({ title: err.message, tone: "error" });
  };

  const pauseMut = useMutation({
    mutationFn: () => agentsApi.pause(agentId, companyId),
    onSuccess: invalidate,
    onError,
  });

  const resumeMut = useMutation({
    mutationFn: () => agentsApi.resume(agentId, companyId),
    onSuccess: invalidate,
    onError,
  });

  const terminateMut = useMutation({
    mutationFn: () => agentsApi.terminate(agentId, companyId),
    onSuccess: invalidate,
    onError,
  });

  const busy = pauseMut.isPending || resumeMut.isPending || terminateMut.isPending;

  if (!AGENT_ACTIONABLE_STATUSES.has(status as any)) {
    return <StatusBadge status={status} />;
  }

  const canPause = status !== "paused";
  const canResume = status === "paused";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy} onClick={(e) => e.stopPropagation()}>
        <button className="cursor-pointer focus:outline-none" disabled={busy}>
          <StatusBadge status={status} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {canPause && (
          <DropdownMenuItem onClick={() => pauseMut.mutate()} disabled={busy}>
            <Pause className="h-3.5 w-3.5" />
            Pause
          </DropdownMenuItem>
        )}
        {canResume && (
          <DropdownMenuItem onClick={() => resumeMut.mutate()} disabled={busy}>
            <Play className="h-3.5 w-3.5" />
            Resume
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => terminateMut.mutate()} disabled={busy}>
          <Trash2 className="h-3.5 w-3.5" />
          Terminate
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
