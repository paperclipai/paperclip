import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS,
  hidesCompanyPage,
  type Agent,
} from "@paperclipai/shared";
import { Shield, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { cloudApi } from "@/api/cloud";
import { issuesApi } from "@/api/issues";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link, Navigate, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { cloudStackInviteUrl } from "@/lib/cloudLinks";
import { usePluginSlots } from "@/plugins/slots";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { InvitesSection } from "@/components/access/InvitesSection";
import { describeError } from "@/api/errors";

const reassignmentIssueStatuses = "backlog,todo,in_progress,in_review,blocked,failed,timed_out";
type EditableMemberStatus = "pending" | "active" | "suspended";

export function CompanyAccess() {
  const { t, i18n } = useTranslation("settings");
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const cloud = useCloudInstance();
  const cloudStacksQuery = useQuery({
    queryKey: queryKeys.cloud.stacks,
    queryFn: () => cloudApi.listStacks(),
    enabled: Boolean(cloud && selectedCompanyId),
    staleTime: 30_000,
  });
  const cloudStacksView = useQueryView(cloudStacksQuery);
  const currentStack = cloudStacksQuery.data?.stacks.find((stack) => stack.isCurrent);
  // Company roles can differ from Cloud roles. Only the current stack's
  // owner/admin may invite, even if another portfolio entry grants ownership.
  const cloudInviteUrl = cloud && cloudStacksView.kind !== "error" &&
    (currentStack?.role === "owner" || currentStack?.role === "admin")
    ? cloudStackInviteUrl(cloud.cloudBaseUrl, currentStack.stackSlug)
    : null;
  // Invites render as a tab of this page; `company.invites` hides just that
  // tab while `company.members` (the route gate) hides the whole page.
  const { hidden: hiddenSettings } = useHiddenSettings();
  const hideInvitesTab = hidesCompanyPage(hiddenSettings, "company.invites");
  const requestedTab = searchParams.get("tab") === "invites" ? "invites" : "members";
  const activeTab = hideInvitesTab ? "members" : requestedTab;
  const handleTabChange = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "invites") {
          next.set("tab", "invites");
        } else {
          next.delete("tab");
        }
        return next;
      },
      { replace: true },
    );
  };
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [reassignmentTarget, setReassignmentTarget] = useState<string>("__unassigned");
  const [draftRole, setDraftRole] = useState<CompanyMember["membershipRole"]>(null);
  const [draftStatus, setDraftStatus] = useState<EditableMemberStatus>("active");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("companyAccess.organization"), href: "/dashboard" },
      { label: t("companyAccess.settings"), href: "/company/settings" },
      { label: t("companyAccess.members") },
    ]);
  }, [t, selectedCompany?.name, setBreadcrumbs]);

  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const membersView = useQueryView(membersQuery);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const joinRequestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId ?? "", "pending_approval"),
    queryFn: () => accessApi.listJoinRequests(selectedCompanyId!, "pending_approval"),
    enabled: !!selectedCompanyId && !!membersQuery.data?.access.canApproveJoinRequests,
  });

  const refreshAccessData = async () => {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(selectedCompanyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId, "pending_approval") });
  };

  const updateMemberMutation = useMutation({
    mutationFn: async (input: { memberId: string; membershipRole: CompanyMember["membershipRole"]; status: EditableMemberStatus }) => {
      return accessApi.updateMember(selectedCompanyId!, input.memberId, {
        membershipRole: input.membershipRole,
        status: input.status,
      });
    },
    onSuccess: async () => {
      setEditingMemberId(null);
      await refreshAccessData();
      pushToast({
        title: t("companyAccess.member_updated"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyAccess.failed_to_update_member"),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const approveJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: t("companyAccess.join_request_approved"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyAccess.failed_to_approve_join_request"),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: t("companyAccess.join_request_rejected"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyAccess.failed_to_reject_join_request"),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const editingMember = useMemo(
    () => membersQuery.data?.members.find((member) => member.id === editingMemberId) ?? null,
    [editingMemberId, membersQuery.data?.members],
  );
  const removingMember = useMemo(
    () => membersQuery.data?.members.find((member) => member.id === removingMemberId) ?? null,
    [removingMemberId, membersQuery.data?.members],
  );

  const assignedIssuesQuery = useQuery({
    queryKey: ["access", "member-assigned-issues", selectedCompanyId ?? "", removingMember?.principalId ?? ""],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        assigneeUserId: removingMember!.principalId,
        status: reassignmentIssueStatuses,
      }),
    enabled: !!selectedCompanyId && !!removingMember,
  });

  const archiveMemberMutation = useMutation({
    mutationFn: async (input: { memberId: string; target: string }) => {
      const reassignment =
        input.target.startsWith("agent:")
          ? { assigneeAgentId: input.target.slice("agent:".length), assigneeUserId: null }
          : input.target.startsWith("user:")
            ? { assigneeAgentId: null, assigneeUserId: input.target.slice("user:".length) }
            : null;
      return accessApi.archiveMember(selectedCompanyId!, input.memberId, { reassignment });
    },
    onSuccess: async (result) => {
      setRemovingMemberId(null);
      setReassignmentTarget("__unassigned");
      await refreshAccessData();
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.issues.listAssignedToMe(selectedCompanyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      }
      pushToast({
        title: t("companyAccess.member_removed"),
        body:
          result.reassignedIssueCount > 0
            ? t("companyAccess.cleaned", { count: result.reassignedIssueCount })
            : undefined,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyAccess.failed_to_remove_member"),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!editingMember) return;
    setDraftRole(editingMember.membershipRole);
    setDraftStatus(isEditableMemberStatus(editingMember.status) ? editingMember.status : "suspended");
  }, [editingMember]);

  useEffect(() => {
    if (!removingMember) return;
    setReassignmentTarget("__unassigned");
  }, [removingMember]);

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("companyAccess.select_an_organization_to_manage_access")}</div>;
  }

  if (membersQuery.isLoading || membersView.kind === "reconnecting") {
    return <div className="text-sm text-muted-foreground">{t("companyAccess.loading_organization_access")}</div>;
  }

  if (membersView.kind === "error") {
    if (membersView.errorKind === "forbidden") {
      return <div className="text-sm text-destructive">{t("companyAccess.you_do_not_have_permission_to_manage_organization_members")}</div>;
    }
    return (
      <QueryErrorState
        size="page"
        error={membersQuery.error}
        action={t("companyAccess.load_organization_members")}
        onRetry={membersView.retry}
        retrying={membersView.isFetching}
      />
    );
  }

  const members = membersQuery.data?.members ?? [];
  const access = membersQuery.data?.access;
  const pendingHumanJoinRequests =
    joinRequestsQuery.data?.filter((request) => request.requestType === "human") ?? [];
  const joinRequestActionPending =
    approveJoinRequestMutation.isPending || rejectJoinRequestMutation.isPending;
  const activeReassignmentUsers = members.filter(
    (member) =>
      member.status === "active" &&
      member.principalType === "user" &&
      member.id !== removingMemberId,
  );
  const activeReassignmentAgents = (agentsQuery.data ?? []).filter(isAssignableAgent);
  const assignedIssues = assignedIssuesQuery.data ?? [];

  return (
    <div className="max-w-6xl space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("companyAccess.organization_members")}</h1>
        </div>
        {cloudInviteUrl && (
          <Button asChild>
            <a href={cloudInviteUrl}><UserPlus />{t("companyAccess.invite_people")}</a>
          </Button>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col gap-4">
        {!hideInvitesTab && (
          <PageTabBar
            items={[
              { value: "members", label: t("companyAccess.members") },
              { value: "invites", label: t("companyAccess.invites") },
            ]}
            align="start"
            value={activeTab}
            onValueChange={handleTabChange}
          />
        )}
        <TabsContent value="members" className="space-y-8">

      {access && !access.currentUserRole && (
        <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">{t("companyAccess.this_account_can_manage_access_here_through_instance_admin")}</div>
      )}

      <section className="space-y-4">
        {access?.canApproveJoinRequests && pendingHumanJoinRequests.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{t("companyAccess.pending_human_joins")}</h3>
                <p className="text-sm text-muted-foreground">{t("companyAccess.review_pending_join_requests_before_they_become_active_organization")}</p>
              </div>
              <Badge variant="outline">{t("companyAccess.pendingCount", { count: pendingHumanJoinRequests.length })}</Badge>
            </div>
            <div className="space-y-3">
              {pendingHumanJoinRequests.map((request) => (
                <PendingJoinRequestCard
                  key={request.id}
                  title={
                    request.requesterUser?.name ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    t("companyAccess.unknown_human_requester")
                  }
                  subtitle={
                    request.requesterUser?.email ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    t("companyAccess.no_email_available")
                  }
                  context={
                    request.invite
                      ? t(request.invite.humanRole ? "companyAccess.joinInviteRole" : "companyAccess.joinInvite", { type: t(`joinTypes.${request.invite.allowedJoinTypes}`), role: request.invite.humanRole ? t(`roles.${request.invite.humanRole}`) : "" })
                      : t("companyAccess.invite_metadata_unavailable")
                  }
                  detail={t("companyAccess.submitted", { date: new Date(request.createdAt).toLocaleString(i18n.language) })}
                  approveLabel={t("companyAccess.approve_human")}
                  rejectLabel={t("companyAccess.reject_human")}
                  disabled={joinRequestActionPending}
                  onApprove={() => approveJoinRequestMutation.mutate(request.id)}
                  onReject={() => rejectJoinRequestMutation.mutate(request.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-(--sz-44rem) text-left text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t("companyAccess.name")}</th>
                <th className="px-3 py-2 font-medium">{t("companyAccess.email")}</th>
                <th className="px-3 py-2 font-medium">{t("companyAccess.role")}</th>
                <th className="px-3 py-2 font-medium">{t("companyAccess.status")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("companyAccess.action")}</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-muted-foreground">{t("companyAccess.no_user_memberships_found_for_this_organization_yet")}</td>
                </tr>
              ) : members.map((member) => {
                const rawRemovalReason = member.removal?.reason;
                const removalReasonKeys = {
                  "Only human company members can be removed.": "companyAccess.removalReason0",
                  "Board access is required to remove members.": "companyAccess.removalReason1",
                  "You cannot remove yourself.": "companyAccess.removalReason2",
                  "Instance admins cannot be removed from company access.": "companyAccess.removalReason3",
                  "Board owners cannot be removed from company access.": "companyAccess.removalReason4",
                  "Company admins cannot be removed from company access.": "companyAccess.removalReason5",
                  "Only active company members can remove users.": "companyAccess.removalReason6",
                  "You can only remove users below your company role.": "companyAccess.removalReason7",
                } as Record<string, string>;
                const removalReason = rawRemovalReason ? t(removalReasonKeys[rawRemovalReason] ?? "companyAccess.unknownRemovalReason", { defaultValue: rawRemovalReason }) : null;
                const canArchive = member.removal?.canArchive ?? true;
                const displayName = memberDisplayName(member);
                return (
                  <tr key={member.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar size="sm">
                          {member.user?.image ? <AvatarImage src={member.user.image} alt={displayName} /> : null}
                          <AvatarFallback>{memberInitials(member)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate font-medium">{displayName}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {member.user?.email || member.principalId}
                    </td>
                    <td className="px-3 py-3">
                      {member.membershipRole
                        ? t(`roles.${member.membershipRole}`, { defaultValue: HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[member.membershipRole] })
                        : t("companyAccess.unset")}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={member.status === "active" ? "secondary" : member.status === "suspended" ? "destructive" : "outline"}>
                        {t(`statuses.${member.status}`, { defaultValue: member.status.replace("_", " ") })}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditingMemberId(member.id)}>{t("companyAccess.edit")}</Button>
                        <span
                          className="inline-flex"
                          title={!canArchive ? removalReason ?? undefined : undefined}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setRemovingMemberId(member.id)}
                            disabled={!canArchive}
                            title={!canArchive ? removalReason ?? undefined : undefined}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />{t("companyAccess.remove")}</Button>
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMemberId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("companyAccess.edit_member")}</DialogTitle>
            <DialogDescription>{t("companyAccess.editDescription", { name: editingMember?.user?.name || editingMember?.user?.email || editingMember?.principalId || t("companyAccess.thisMember") })}
            </DialogDescription>
          </DialogHeader>
          {editingMember && (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">{t("companyAccess.organization_role")}</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftRole ?? ""}
                    onChange={(event) =>
                      setDraftRole((event.target.value || null) as CompanyMember["membershipRole"])
                    }
                  >
                    <option value="">{t("companyAccess.unset")}</option>
                    {Object.entries(HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {t(`roles.${value}`, { defaultValue: label })}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">{t("companyAccess.membership_status")}</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftStatus}
                    onChange={(event) =>
                      setDraftStatus(event.target.value as EditableMemberStatus)
                    }
                  >
                    <option value="active">{t("companyAccess.active")}</option>
                    <option value="pending">{t("companyAccess.pending_1459")}</option>
                    <option value="suspended">{t("companyAccess.suspended")}</option>
                  </select>
                </label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMemberId(null)}>{t("companyAccess.cancel")}</Button>
            <Button
              onClick={() => {
                if (!editingMember) return;
                updateMemberMutation.mutate({
                  memberId: editingMember.id,
                  membershipRole: draftRole,
                  status: draftStatus,
                });
              }}
              disabled={updateMemberMutation.isPending}
            >
              {updateMemberMutation.isPending ? t("companyAccess.saving") : t("companyAccess.save_member")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removingMember} onOpenChange={(open) => !open && setRemovingMemberId(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("companyAccess.remove_member")}</DialogTitle>
            <DialogDescription>{t("companyAccess.removeDescription", { name: memberDisplayName(removingMember) || t("companyAccess.thisMember") })}</DialogDescription>
          </DialogHeader>
          {removingMember && (
            <div className="space-y-5">
              <div className="rounded-lg border border-border px-3 py-3">
                <div className="text-sm font-medium">{memberDisplayName(removingMember)}</div>
                <div className="text-sm text-muted-foreground">{removingMember.user?.email || removingMember.principalId}</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  {assignedIssuesQuery.isLoading
                    ? t("companyAccess.checking_assigned_tasks")
                    : t("companyAccess.openAssigned", { count: assignedIssues.length })}
                </div>
              </div>

              {assignedIssues.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t("companyAccess.task_reassignment")}</div>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={reassignmentTarget}
                    onChange={(event) => setReassignmentTarget(event.target.value)}
                  >
                    <option value="__unassigned">{t("companyAccess.leave_unassigned")}</option>
                    {activeReassignmentUsers.length > 0 ? (
                      <optgroup label={t("companyAccess.humans")}>
                        {activeReassignmentUsers.map((member) => (
                          <option key={member.id} value={`user:${member.principalId}`}>
                            {memberDisplayName(member)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {activeReassignmentAgents.length > 0 ? (
                      <optgroup label={t("companyAccess.agents")}>
                        {activeReassignmentAgents.map((agent) => (
                          <option key={agent.id} value={`agent:${agent.id}`}>
                            {agent.name} ({agent.role})
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </select>
                  <div className="max-h-36 overflow-auto rounded-lg border border-border">
                    {assignedIssues.slice(0, 6).map((issue) => (
                      <div key={issue.id} className="border-b border-border px-3 py-2 text-sm last:border-b-0">
                        <div className="font-medium">{issue.identifier ?? issue.id.slice(0, 8)}</div>
                        <div className="truncate text-muted-foreground">{issue.title}</div>
                      </div>
                    ))}
                    {assignedIssues.length > 6 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        {t("companyAccess.moreTasks", { count: assignedIssues.length - 6 })}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovingMemberId(null)}>{t("companyAccess.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!removingMember) return;
                archiveMemberMutation.mutate({
                  memberId: removingMember.id,
                  target: reassignmentTarget,
                });
              }}
              disabled={archiveMemberMutation.isPending || assignedIssuesQuery.isLoading}
            >
              {archiveMemberMutation.isPending ? t("companyAccess.removing") : t("companyAccess.remove_member")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        </TabsContent>
        {!hideInvitesTab && (
          <TabsContent value="invites">
            <InvitesSection />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export function CompanyAccessLegacyRoute() {
  const { t, i18n } = useTranslation("settings");
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { slots, isLoading, errorMessage } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("companyAccess.settings"), href: "/company/settings" },
      { label: t("companyAccess.access") },
    ]);
  }, [t, setBreadcrumbs]);

  const permissionsSlot = slots.find((slot) => slot.routePath === "permissions");
  if (permissionsSlot) {
    return <Navigate to="/company/settings/permissions" replace />;
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">{t("companyAccess.checking_for_advanced_permission_extensions")}</div>;
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("companyAccess.advanced_permissions")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("companyAccess.advanced_access_scoped_assignment_and_explicit_grant_controls_are")}</p>
      </div>

      <div className="space-y-4 rounded-xl border border-border px-5 py-5">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">{t("companyAccess.advanced_permissions_unavailable")}</h2>
          <p className="text-sm text-muted-foreground">{t("companyAccess.core_paperclip_keeps_enforcing_organization_boundaries_and_any_existing")}</p>
          {errorMessage ? (
            <p className="text-sm text-destructive">{t("companyAccess.pluginError", { error: errorMessage })}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/company/settings/members">{t("companyAccess.open_members")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/company/settings/members?tab=invites">{t("companyAccess.open_invites")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function memberDisplayName(member: CompanyMember | null) {
  if (!member) return "";
  return member.user?.name?.trim() || member.user?.email || member.principalId;
}

function memberInitials(member: CompanyMember) {
  const value = memberDisplayName(member).trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return value.slice(0, 2).toUpperCase();
}

function isAssignableAgent(agent: Agent) {
  return agent.status !== "terminated" && agent.status !== "pending_approval";
}

function isEditableMemberStatus(status: CompanyMember["status"]): status is EditableMemberStatus {
  return status === "pending" || status === "active" || status === "suspended";
}

function PendingJoinRequestCard({
  title,
  subtitle,
  context,
  detail,
  detailSecondary,
  approveLabel,
  rejectLabel,
  disabled,
  onApprove,
  onReject,
}: {
  title: string;
  subtitle: string;
  context: string;
  detail: string;
  detailSecondary?: string;
  approveLabel: string;
  rejectLabel: string;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div>
            <div className="font-medium">{title}</div>
            <div className="text-sm text-muted-foreground">{subtitle}</div>
          </div>
          <div className="text-sm text-muted-foreground">{context}</div>
          <div className="text-sm text-muted-foreground">{detail}</div>
          {detailSecondary ? <div className="text-sm text-muted-foreground">{detailSecondary}</div> : null}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onReject} disabled={disabled}>
            {rejectLabel}
          </Button>
          <Button type="button" onClick={onApprove} disabled={disabled}>
            {approveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}