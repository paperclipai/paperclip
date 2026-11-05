import { t as translateShell, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus2 } from "lucide-react";
import { accessApi } from "@/api/access";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

export function JoinRequestQueue() {
  const { t: translateShell } = useTranslation("shell");
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"pending_approval" | "approved" | "rejected">("pending_approval");
  const [requestType, setRequestType] = useState<"all" | "human" | "agent">("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? translateShell("shell:organization"), href: "/dashboard" },
      { label: translateShell("shell:inbox"), href: "/inbox" },
      { label: translateShell("shell:join_requests") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, translateShell]);

  const requestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId ?? "", `${status}:${requestType}`),
    queryFn: () =>
      accessApi.listJoinRequests(
        selectedCompanyId!,
        status,
        requestType === "all" ? undefined : requestType,
      ),
    enabled: !!selectedCompanyId,
  });
  const requestsView = useQueryView(requestsQuery);

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(selectedCompanyId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!) });
      pushToast({ title: translateShell("shell:join_request_approved"), tone: "success" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      pushToast({ title: translateShell("shell:join_request_rejected"), tone: "success" });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{translateShell("shell:select_an_organization_to_review_join_requests")}</div>;
  }

  if (requestsQuery.isLoading || requestsView.kind === "reconnecting") {
    return <div className="text-sm text-muted-foreground">{translateShell("shell:loading_join_requests")}</div>;
  }

  if (requestsView.kind === "error") {
    if (requestsView.errorKind === "forbidden") {
      return (
        <div className="text-sm text-destructive">{translateShell("shell:you_do_not_have_permission_to_review")}</div>
      );
    }
    return (
      <QueryErrorState
        size="page"
        error={requestsQuery.error}
        action={translateShell("shell:extra_43_load_join_requests")}
        onRetry={requestsView.retry}
        retrying={requestsView.isFetching}
      />
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{translateShell("shell:join_request_queue")}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{translateShell("shell:review_human_and_agent_join_requests_outside")}</p>
      </div>

      <Card className="flex-row flex-wrap gap-3 p-4">
        <label className="space-y-2 text-sm">
          <span className="font-medium">{translateShell("shell:status")}</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "pending_approval" | "approved" | "rejected")
            }
          >
            <option value="pending_approval">{translateShell("shell:pending_approval")}</option>
            <option value="approved">{translateShell("shell:approved")}</option>
            <option value="rejected">{translateShell("shell:rejected")}</option>
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">{translateShell("shell:request_type")}</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={requestType}
            onChange={(event) =>
              setRequestType(event.target.value as "all" | "human" | "agent")
            }
          >
            <option value="all">{translateShell("shell:all")}</option>
            <option value="human">{translateShell("shell:human")}</option>
            <option value="agent">{translateShell("shell:agent_11b39c")}</option>
          </select>
        </label>
      </Card>

      <div className="space-y-4">
        {(requestsQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">{translateShell("shell:no_join_requests_match_the_current_filters")}</div>
        ) : (
          requestsQuery.data!.map((request) => (
            <Card key={request.id} className="block p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={request.status === "pending_approval" ? "secondary" : request.status === "approved" ? "outline" : "destructive"}>
                      {translateShell({ pending_approval: "shell:pending_approval", approved: "shell:approved", rejected: "shell:rejected" }[request.status])}
                    </Badge>
                    <Badge variant="outline">{translateShell(request.requestType === "human" ? "shell:human" : "shell:agent_11b39c")}</Badge>
                    {request.adapterType ? <Badge variant="outline">{request.adapterType}</Badge> : null}
                  </div>
                  <div>
                    <div className="text-base font-medium">
                      {request.requestType === "human"
                        ? request.requesterUser?.name || request.requestEmailSnapshot || request.requestingUserId || translateShell("shell:unknown_human_requester")
                        : request.agentName || translateShell("shell:unknown_agent_requester")}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {request.requestType === "human"
                        ? request.requesterUser?.email || request.requestEmailSnapshot || request.requestingUserId
                        : request.capabilities || request.requestIp}
                    </div>
                  </div>
                </div>

                {request.status === "pending_approval" ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => rejectMutation.mutate(request.id)}
                      disabled={rejectMutation.isPending}
                    >{translateShell("shell:reject")}</Button>
                    <Button
                      onClick={() => approveMutation.mutate(request.id)}
                      disabled={approveMutation.isPending}
                    >{translateShell("shell:approve")}</Button>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">{translateShell("shell:invite_context")}</div>
                  <div className="mt-2">
                    {request.invite
                      ? translateShell("shell:join_invite", { value1: request.invite.allowedJoinTypes, value2: request.invite.humanRole ? translateShell("shell:default_role", { value1: request.invite.humanRole }) : "" })
                      : translateShell("shell:invite_metadata_unavailable")}
                  </div>
                  {request.invite?.inviteMessage ? (
                    <div className="mt-2 text-foreground">{request.invite.inviteMessage}</div>
                  ) : null}
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">{translateShell("shell:request_details")}</div>
                  <div className="mt-2">{translateShell("shell:submitted")}{" "}{new Date(request.createdAt).toLocaleString()}</div>
                  <div>{translateShell("shell:source_ip", { value1: request.requestIp })}</div>
                  {request.requestType === "agent" && request.capabilities ? <div>{request.capabilities}</div> : null}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
