import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { UserPlus2 } from "lucide-react";
import i18n from "@/i18n";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

export function JoinRequestQueue() {
  const { t } = useTranslation("settings");
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"pending_approval" | "approved" | "rejected">("pending_approval");
  const [requestType, setRequestType] = useState<"all" | "human" | "agent">("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("joinRequests.breadcrumbCompany", { defaultValue: "Company" }), href: "/dashboard" },
      { label: t("joinRequests.breadcrumbInbox", { defaultValue: "Inbox" }), href: "/inbox" },
      { label: t("joinRequests.breadcrumbJoinRequests", { defaultValue: "Join Requests" }) },
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
      pushToast({ title: i18n.t("settings:joinRequests.toastApproved", { defaultValue: "Join request approved" }), tone: "success" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      pushToast({ title: i18n.t("settings:joinRequests.toastRejected", { defaultValue: "Join request rejected" }), tone: "success" });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{i18n.t("settings:joinRequests.selectCompany", { defaultValue: "Select a company to review join requests." })}</div>;
  }

  if (requestsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{i18n.t("settings:joinRequests.loading", { defaultValue: "Loading join requests\u2026" })}</div>;
  }

  if (requestsQuery.error) {
    const message =
      requestsQuery.error instanceof ApiError && requestsQuery.error.status === 403
        ? i18n.t("settings:joinRequests.noPermission", { defaultValue: "You do not have permission to review join requests for this company." })
        : requestsQuery.error instanceof Error
          ? requestsQuery.error.message
          : i18n.t("settings:joinRequests.loadFailed", { defaultValue: "Failed to load join requests." });
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("joinRequests.heading", { defaultValue: "Join Request Queue" })}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("joinRequests.description", { defaultValue: "Review human and agent join requests outside the mixed inbox feed. This queue uses the same approval mutations as the inline inbox cards." })}
        </p>
      </div>

      <div className="flex flex-wrap gap-3 rounded-xl border border-border bg-card p-4">
        <label className="space-y-2 text-sm">
          <span className="font-medium">{t("joinRequests.statusLabel", { defaultValue: "Status" })}</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "pending_approval" | "approved" | "rejected")
            }
          >
            <option value="pending_approval">{t("joinRequests.statusPendingApproval", { defaultValue: "Pending approval" })}</option>
            <option value="approved">{t("joinRequests.statusApproved", { defaultValue: "Approved" })}</option>
            <option value="rejected">{t("joinRequests.statusRejected", { defaultValue: "Rejected" })}</option>
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">{t("joinRequests.requestTypeLabel", { defaultValue: "Request type" })}</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={requestType}
            onChange={(event) =>
              setRequestType(event.target.value as "all" | "human" | "agent")
            }
          >
            <option value="all">{t("joinRequests.requestTypeAll", { defaultValue: "All" })}</option>
            <option value="human">{t("joinRequests.requestTypeHuman", { defaultValue: "Human" })}</option>
            <option value="agent">{t("joinRequests.requestTypeAgent", { defaultValue: "Agent" })}</option>
          </select>
        </label>
      </div>

      <div className="space-y-4">
        {(requestsQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
            {t("joinRequests.noResults", { defaultValue: "No join requests match the current filters." })}
          </div>
        ) : (
          requestsQuery.data!.map((request) => (
            <div key={request.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={request.status === "pending_approval" ? "secondary" : request.status === "approved" ? "outline" : "destructive"}>
                      {t(`joinRequests.status.${request.status}`, { defaultValue: request.status.replace("_", " ") })}
                    </Badge>
                    <Badge variant="outline">{t(`joinRequests.type.${request.requestType}`, { defaultValue: request.requestType })}</Badge>
                    {request.adapterType ? <Badge variant="outline">{request.adapterType}</Badge> : null}
                  </div>
                  <div>
                    <div className="text-base font-medium">
                      {request.requestType === "human"
                        ? request.requesterUser?.name || request.requestEmailSnapshot || request.requestingUserId || t("joinRequests.unknownHumanRequester", { defaultValue: "Unknown human requester" })
                        : request.agentName || t("joinRequests.unknownAgentRequester", { defaultValue: "Unknown agent requester" })}
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
                      {t("joinRequests.reject", { defaultValue: "Reject" })}
                    </Button>
                    <Button
                      onClick={() => approveMutation.mutate(request.id)}
                      disabled={approveMutation.isPending}
                    >
                      {t("joinRequests.approve", { defaultValue: "Approve" })}
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">{t("joinRequests.inviteContextLabel", { defaultValue: "Invite context" })}</div>
                  <div className="mt-2">
                    {request.invite
                      ? t("joinRequests.inviteContext", { defaultValue: "{{joinTypes}} join invite", joinTypes: request.invite.allowedJoinTypes }) + (request.invite.humanRole ? ` \u2022 ${t("joinRequests.defaultRole", { defaultValue: "default role {{role}}", role: request.invite.humanRole })}` : "")
                      : t("joinRequests.inviteMetadataUnavailable", { defaultValue: "Invite metadata unavailable" })}
                  </div>
                  {request.invite?.inviteMessage ? (
                    <div className="mt-2 text-foreground">{request.invite.inviteMessage}</div>
                  ) : null}
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">{t("joinRequests.requestDetailsLabel", { defaultValue: "Request details" })}</div>
                  <div className="mt-2">{t("joinRequests.submitted", { defaultValue: "Submitted {{date}}", date: new Date(request.createdAt).toLocaleString() })}</div>
                  <div>{t("joinRequests.sourceIp", { defaultValue: "Source IP {{ip}}", ip: request.requestIp })}</div>
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
