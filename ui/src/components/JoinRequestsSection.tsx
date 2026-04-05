import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, XCircle, Clock, User, Bot, UserPlus } from "lucide-react";
import type { JoinRequest } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function statusBadge(status: string) {
  switch (status) {
    case "pending_approval":
      return <Badge variant="outline" className="text-[10px] gap-1 text-amber-600 border-amber-600/30"><Clock className="h-3 w-3" /> Pending</Badge>;
    case "approved":
      return <Badge variant="outline" className="text-[10px] gap-1 text-green-600 border-green-600/30"><CheckCircle className="h-3 w-3" /> Approved</Badge>;
    case "rejected":
      return <Badge variant="outline" className="text-[10px] gap-1 text-destructive border-destructive/30"><XCircle className="h-3 w-3" /> Rejected</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
  }
}

function JoinRequestRow({ request, companyId }: { request: JoinRequest; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const isPending = request.status === "pending_approval";

  const approveMutation = useMutation({
    mutationFn: () => accessApi.approveJoinRequest(companyId, request.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.members.list(companyId) });
      pushToast({ title: "Join request approved", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Failed to approve", body: err instanceof Error ? err.message : "Unknown error", tone: "error" }),
  });

  const rejectMutation = useMutation({
    mutationFn: () => accessApi.rejectJoinRequest(companyId, request.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
      pushToast({ title: "Join request rejected", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Failed to reject", body: err instanceof Error ? err.message : "Unknown error", tone: "error" }),
  });

  const displayName = request.agentName ?? request.requestEmailSnapshot ?? "Unknown";
  const createdAt = new Date(request.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {request.requestType === "agent" ? <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          <span className="text-sm font-medium truncate">{displayName}</span>
          {statusBadge(request.status)}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">{request.requestType}</span>
          {request.adapterType && <span className="text-xs text-muted-foreground">· {request.adapterType}</span>}
          <span className="text-xs text-muted-foreground">· {createdAt}</span>
        </div>
      </div>
      {isPending && (
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="text-green-600 border-green-600/30 hover:bg-green-50 dark:hover:bg-green-950/20"
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending || rejectMutation.isPending}
          >
            {approveMutation.isPending ? "..." : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive border-destructive/30 hover:bg-destructive/5"
            onClick={() => rejectMutation.mutate()}
            disabled={approveMutation.isPending || rejectMutation.isPending}
          >
            {rejectMutation.isPending ? "..." : "Reject"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function JoinRequestsSection({ companyId }: { companyId: string }) {
  const { data: requests, isLoading, error } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId, "all"),
    queryFn: async () => {
      const [pending, approved, rejected] = await Promise.all([
        accessApi.listJoinRequests(companyId, "pending_approval"),
        accessApi.listJoinRequests(companyId, "approved"),
        accessApi.listJoinRequests(companyId, "rejected"),
      ]);
      return [...pending, ...approved, ...rejected];
    },
    enabled: !!companyId,
  });

  const pendingCount = requests?.filter((r) => r.status === "pending_approval").length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-muted-foreground" />
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Join Requests
        </div>
        {pendingCount > 0 && (
          <Badge variant="default" className="text-[10px] px-1.5 py-0 bg-amber-600 hover:bg-amber-600">
            {pendingCount} pending
          </Badge>
        )}
      </div>

      {isLoading && (
        <div className="rounded-md border border-border px-4 py-6 text-sm text-muted-foreground">
          Loading join requests...
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error instanceof Error && error.message.includes("403")
            ? "You don't have permission to manage join requests."
            : "Failed to load join requests."}
        </div>
      )}

      {requests && requests.length === 0 && (
        <div className="rounded-md border border-border px-4 py-6 text-sm text-muted-foreground text-center">
          No join requests.
        </div>
      )}

      {requests && requests.length > 0 && (
        <div className="rounded-md border border-border overflow-hidden">
          {requests.map((r) => (
            <JoinRequestRow key={r.id} request={r} companyId={companyId} />
          ))}
        </div>
      )}
    </div>
  );
}
