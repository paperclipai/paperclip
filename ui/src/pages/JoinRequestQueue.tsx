import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus2 } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";

export function JoinRequestQueue() {
  const { t } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"pending_approval" | "approved" | "rejected">("pending_approval");
  const [requestType, setRequestType] = useState<"all" | "human" | "agent">("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("pages.joinRequestQueue.breadcrumbCompany", { defaultValue: "Company" }), href: "/dashboard" },
      { label: t("pages.joinRequestQueue.breadcrumbInbox", { defaultValue: "Inbox" }), href: "/inbox" },
      { label: t("pages.joinRequestQueue.breadcrumbJoinRequests", { defaultValue: "Join Requests" }) },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

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

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(selectedCompanyId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!) });
      pushToast({ title: t("pages.joinRequestQueue.toastApproved", { defaultValue: "Join request approved" }), tone: "success" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      pushToast({ title: t("pages.joinRequestQueue.toastRejected", { defaultValue: "Join request rejected" }), tone: "success" });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("pages.joinRequestQueue.selectCompany", { defaultValue: "Select a company to review join requests." })}</div>;
  }

  if (requestsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("pages.joinRequestQueue.loading", { defaultValue: "Loading join requests…" })}</div>;
  }

  if (requestsQuery.error) {
    const message =
      requestsQuery.error instanceof ApiError && requestsQuery.error.status === 403
        ? t("pages.joinRequestQueue.errorForbidden", { defaultValue: "You do not have permission to review join requests for this company." })
        : requestsQuery.error instanceof Error
          ? requestsQuery.error.message
          : t("pages.joinRequestQueue.errorLoadFailed", { defaultValue: "Failed to load join requests." });
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("pages.joinRequestQueue.heading", { defaultValue: "Join Request Queue" })}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("pages.joinRequestQueue.description", { defaultValue: "Review human and agent join requests outside the mixed inbox feed. This queue uses the same approval mutations as the inline inbox cards." })}
        </p>
      </div>

      <div className="flex flex-wrap gap-3 rounded-xl border border-border bg-card p-4">
        <label className="space-y-2 text-sm">
          <span className="font-medium">{t("pages.joinRequestQueue.statusLabel", { defaultValue: "Status" })}</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "pending_approval" | "approved" | "rejected")
            }
          >
            <option value="pending_approval">{t("pages.joinRequestQueue.statusPendingApproval", { defaultValue: "Pending approval" })}</option>
            <option value="approved">{t("pages.joinRequestQueue.statusApproved", { defaultValue: "Approved" })}</option>
            <option value="rejected">{t("pages.joinRequestQueue.statusRejected", { defaultValue: "Rejected" })}</option>
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">{t("pages.joinRequestQueue.requestTypeLabel", { defaultValue: "Request type" })}</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={requestType}
            onChange={(event) =>
              setRequestType(event.target.value as "all" | "human" | "agent")
            }
          >
            <option value="all">{t("pages.joinRequestQueue.requestTypeAll", { defaultValue: "All" })}</option>
            <option value="human">{t("pages.joinRequestQueue.requestTypeHuman", { defaultValue: "Human" })}</option>
            <option value="agent">{t("pages.joinRequestQueue.requestTypeAgent", { defaultValue: "Agent" })}</option>
          </select>
        </label>
      </div>

      <div className="space-y-4">
        {(requestsQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
            {t("pages.joinRequestQueue.emptyState", { defaultValue: "No join requests match the current filters." })}
          </div>
        ) : (
          requestsQuery.data!.map((request) => (
            <div key={request.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={request.status === "pending_approval" ? "secondary" : request.status === "approved" ? "outline" : "destructive"}>
                      {request.status.replace("_", " ")}
                    </Badge>
                    <Badge variant="outline">{request.requestType}</Badge>
                    {request.adapterType ? <Badge variant="outline">{request.adapterType}</Badge> : null}
                  </div>
                  <div>
                    <div className="text-base font-medium">
                      {request.requestType === "human"
                        ? request.requesterUser?.name || request.requestEmailSnapshot || request.requestingUserId || t("pages.joinRequestQueue.unknownHumanRequester", { defaultValue: "Unknown human requester" })
                        : request.agentName || t("pages.joinRequestQueue.unknownAgentRequester", { defaultValue: "Unknown agent requester" })}
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
                    >
                      {t("pages.joinRequestQueue.rejectButton", { defaultValue: "Reject" })}
                    </Button>
                    <Button
                      onClick={() => approveMutation.mutate(request.id)}
                      disabled={approveMutation.isPending}
                    >
                      {t("pages.joinRequestQueue.approveButton", { defaultValue: "Approve" })}
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">{t("pages.joinRequestQueue.inviteContextTitle", { defaultValue: "Invite context" })}</div>
                  <div className="mt-2">
                    {request.invite
                      ? request.invite.humanRole
                        ? t("pages.joinRequestQueue.inviteSummaryWithRole", { allowedJoinTypes: request.invite.allowedJoinTypes, humanRole: request.invite.humanRole, defaultValue: "{{allowedJoinTypes}} join invite • default role {{humanRole}}" })
                        : t("pages.joinRequestQueue.inviteSummary", { allowedJoinTypes: request.invite.allowedJoinTypes, defaultValue: "{{allowedJoinTypes}} join invite" })
                      : t("pages.joinRequestQueue.inviteMetadataUnavailable", { defaultValue: "Invite metadata unavailable" })}
                  </div>
                  {request.invite?.inviteMessage ? (
                    <div className="mt-2 text-foreground">{request.invite.inviteMessage}</div>
                  ) : null}
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">{t("pages.joinRequestQueue.requestDetailsTitle", { defaultValue: "Request details" })}</div>
                  <div className="mt-2">{t("pages.joinRequestQueue.submittedAt", { date: new Date(request.createdAt).toLocaleString(), defaultValue: "Submitted {{date}}" })}</div>
                  <div>{t("pages.joinRequestQueue.sourceIp", { ip: request.requestIp, defaultValue: "Source IP {{ip}}" })}</div>
                  {request.requestType === "agent" && request.capabilities ? <div>{request.capabilities}</div> : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
