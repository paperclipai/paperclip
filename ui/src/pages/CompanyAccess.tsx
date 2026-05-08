import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS,
  PERMISSION_KEYS,
  type Agent,
  type PermissionKey,
} from "@paperclipai/shared";
import { ShieldCheck, Trash2, Users } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

function formatGrantSummary(member: CompanyMember, t: (key: string) => string) {
  if (member.grants.length === 0) return t("companyAccess.noExplicitGrants");
  return member.grants.map((grant) => t(`companyAccess.permissionLabels.${grant.permissionKey}`)).join(", ");
}

const implicitRoleGrantMap: Record<NonNullable<CompanyMember["membershipRole"]>, PermissionKey[]> = {
  owner: ["agents:create", "users:invite", "users:manage_permissions", "tasks:assign", "joins:approve"],
  admin: ["agents:create", "users:invite", "tasks:assign", "joins:approve"],
  operator: ["tasks:assign"],
  viewer: [],
};

const reassignmentIssueStatuses = "backlog,todo,in_progress,in_review,blocked,failed,timed_out";
type EditableMemberStatus = "pending" | "active" | "suspended";

function getImplicitGrantKeys(role: CompanyMember["membershipRole"]) {
  return role ? implicitRoleGrantMap[role] : [];
}

export function CompanyAccess() {
  const { t } = useTranslation("settings");
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [reassignmentTarget, setReassignmentTarget] = useState<string>("__unassigned");
  const [draftRole, setDraftRole] = useState<CompanyMember["membershipRole"]>(null);
  const [draftStatus, setDraftStatus] = useState<EditableMemberStatus>("active");
  const [draftGrants, setDraftGrants] = useState<Set<PermissionKey>>(new Set());

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("companyAccess.breadcrumb.company"), href: "/dashboard" },
      { label: t("companyAccess.breadcrumb.settings"), href: "/company/settings" },
      { label: t("companyAccess.breadcrumb.access") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, t]);

  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

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
    mutationFn: async (input: { memberId: string; membershipRole: CompanyMember["membershipRole"]; status: EditableMemberStatus; grants: PermissionKey[] }) => {
      return accessApi.updateMemberAccess(selectedCompanyId!, input.memberId, {
        membershipRole: input.membershipRole,
        status: input.status,
        grants: input.grants.map((permissionKey) => ({ permissionKey })),
      });
    },
    onSuccess: async () => {
      setEditingMemberId(null);
      await refreshAccessData();
      pushToast({
        title: t("companyAccess.toast.memberUpdated"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyAccess.toast.updateFailed"),
        body: error instanceof Error ? error.message : t("companyAccess.toast.unknownError"),
        tone: "error",
      });
    },
  });

  const approveJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: t("companyAccess.toast.joinRequestApproved"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyAccess.toast.approveFailed"),
        body: error instanceof Error ? error.message : t("companyAccess.toast.unknownError"),
        tone: "error",
      });
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: t("companyAccess.toast.joinRequestRejected"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyAccess.toast.rejectFailed"),
        body: error instanceof Error ? error.message : t("companyAccess.toast.unknownError"),
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
        title: t("companyAccess.toast.memberRemoved"),
        body:
          result.reassignedIssueCount > 0
            ? t("companyAccess.toast.issuesCleanedUp", { count: result.reassignedIssueCount })
            : undefined,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyAccess.toast.removeFailed"),
        body: error instanceof Error ? error.message : t("companyAccess.toast.unknownError"),
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!editingMember) return;
    setDraftRole(editingMember.membershipRole);
    setDraftStatus(isEditableMemberStatus(editingMember.status) ? editingMember.status : "suspended");
    setDraftGrants(new Set(editingMember.grants.map((grant) => grant.permissionKey)));
  }, [editingMember]);

  useEffect(() => {
    if (!removingMember) return;
    setReassignmentTarget("__unassigned");
  }, [removingMember]);

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("companyAccess.selectCompany")}</div>;
  }

  if (membersQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("companyAccess.loading")}</div>;
  }

  if (membersQuery.error) {
    const message =
      membersQuery.error instanceof ApiError && membersQuery.error.status === 403
        ? t("companyAccess.permissionError")
        : membersQuery.error instanceof Error
          ? membersQuery.error.message
          : t("companyAccess.loadError");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  const members = membersQuery.data?.members ?? [];
  const access = membersQuery.data?.access;
  const pendingHumanJoinRequests =
    joinRequestsQuery.data?.filter((request) => request.requestType === "human") ?? [];
  const joinRequestActionPending =
    approveJoinRequestMutation.isPending || rejectJoinRequestMutation.isPending;
  const implicitGrantKeys = getImplicitGrantKeys(draftRole);
  const implicitGrantSet = new Set(implicitGrantKeys);
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
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("companyAccess.title")}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("companyAccess.description", { companyName: selectedCompany?.name })}
        </p>
      </div>

      {access && !access.currentUserRole && (
        <div className="rounded-xl border border-amber-500/40 px-4 py-3 text-sm text-amber-200">
          {t("companyAccess.instanceAdminNote")}
        </div>
      )}

      <section className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">{t("companyAccess.humans.title")}</h2>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {t("companyAccess.humans.description")}
          </p>
        </div>

        {access?.canApproveJoinRequests && pendingHumanJoinRequests.length > 0 ? (
          <div className="space-y-3 rounded-xl border border-border px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{t("companyAccess.pendingJoins.title")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("companyAccess.pendingJoins.description")}
                </p>
              </div>
              <Badge variant="outline">{t("companyAccess.pendingJoins.pending", { count: pendingHumanJoinRequests.length })}</Badge>
            </div>
            <div className="space-y-3">
              {pendingHumanJoinRequests.map((request) => (
                <PendingJoinRequestCard
                  key={request.id}
                  title={
                    request.requesterUser?.name ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    t("companyAccess.unknownHuman")
                  }
                  subtitle={
                    request.requesterUser?.email ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    t("companyAccess.noEmail")
                  }
                  context={
                    request.invite
                      ? `${request.invite.allowedJoinTypes} join invite${request.invite.humanRole ? ` • default role ${request.invite.humanRole}` : ""}`
                      : t("companyAccess.inviteUnavailable")
                  }
                  detail={t("companyAccess.submitted", { date: new Date(request.createdAt).toLocaleString() })}
                  approveLabel={t("companyAccess.approveHuman")}
                  rejectLabel={t("companyAccess.rejectHuman")}
                  disabled={joinRequestActionPending}
                  onApprove={() => approveJoinRequestMutation.mutate(request.id)}
                  onReject={() => rejectJoinRequestMutation.mutate(request.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-[minmax(0,1.5fr)_120px_120px_minmax(0,1.2fr)_180px] gap-3 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <div>{t("companyAccess.table.userAccount")}</div>
            <div>{t("companyAccess.table.role")}</div>
            <div>{t("companyAccess.table.status")}</div>
            <div>{t("companyAccess.table.grants")}</div>
            <div className="text-right">{t("companyAccess.table.action")}</div>
          </div>
          {members.length === 0 ? (
            <div className="px-4 py-8 text-sm text-muted-foreground">{t("companyAccess.noMemberships")}</div>
          ) : (
            members.map((member) => {
              const removalReason = member.removal?.reason ?? null;
              const canArchive = member.removal?.canArchive ?? true;
              return (
                <div
                  key={member.id}
                  className="grid grid-cols-[minmax(0,1.5fr)_120px_120px_minmax(0,1.2fr)_180px] gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{member.user?.name?.trim() || member.user?.email || member.principalId}</div>
                    <div className="truncate text-xs text-muted-foreground">{member.user?.email || member.principalId}</div>
                  </div>
                  <div className="text-sm">
                    {member.membershipRole
                      ? HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[member.membershipRole]
                      : t("companyAccess.unset")}
                  </div>
                  <div>
                    <Badge variant={member.status === "active" ? "secondary" : member.status === "suspended" ? "destructive" : "outline"}>
                      {t(`companyAccess.status.${member.status}`)}
                    </Badge>
                  </div>
                  <div className="min-w-0 text-sm text-muted-foreground">{formatGrantSummary(member, t)}</div>
                  <div className="space-y-1 text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditingMemberId(member.id)}>
                        {t("companyAccess.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRemovingMemberId(member.id)}
                        disabled={!canArchive}
                        title={removalReason ?? undefined}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        {t("companyAccess.remove")}
                      </Button>
                    </div>
                    {removalReason ? (
                      <div className="text-xs text-muted-foreground">{removalReason}</div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMemberId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("companyAccess.editMember.title")}</DialogTitle>
            <DialogDescription>
              {t("companyAccess.editMember.description", { name: editingMember?.user?.name || editingMember?.user?.email || editingMember?.principalId })}
            </DialogDescription>
          </DialogHeader>
          {editingMember && (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">{t("companyAccess.editMember.companyRole")}</span>
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
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">{t("companyAccess.editMember.membershipStatus")}</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftStatus}
                    onChange={(event) =>
                      setDraftStatus(event.target.value as EditableMemberStatus)
                    }
                  >
                    <option value="active">{t("companyAccess.editMember.statusOptions.active")}</option>
                    <option value="pending">{t("companyAccess.editMember.statusOptions.pending")}</option>
                    <option value="suspended">{t("companyAccess.editMember.statusOptions.suspended")}</option>
                  </select>
                </label>
              </div>

              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-medium">{t("companyAccess.editMember.grantsTitle")}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t("companyAccess.editMember.grantsDescription")}
                  </p>
                </div>
                <div className="rounded-lg border border-border px-3 py-3">
                  <div className="text-sm font-medium">{t("companyAccess.editMember.implicitGrantsTitle")}</div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {draftRole
                      ? t("companyAccess.editMember.implicitGrantsDescription", { role: HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[draftRole] })
                      : t("companyAccess.editMember.noImplicitGrants")}
                  </p>
                  {implicitGrantKeys.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {implicitGrantKeys.map((permissionKey) => (
                        <Badge key={permissionKey} variant="outline">
                          {t(`companyAccess.permissionLabels.${permissionKey}`)}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {PERMISSION_KEYS.map((permissionKey) => (
                    <label
                      key={permissionKey}
                      className="flex items-start gap-3 rounded-lg border border-border px-3 py-2"
                    >
                      <Checkbox
                        checked={draftGrants.has(permissionKey)}
                        onCheckedChange={(checked) => {
                          setDraftGrants((current) => {
                            const next = new Set(current);
                            if (checked) next.add(permissionKey);
                            else next.delete(permissionKey);
                            return next;
                          });
                        }}
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">{t(`companyAccess.permissionLabels.${permissionKey}`)}</span>
                        <span className="block text-xs text-muted-foreground">{permissionKey}</span>
                        {implicitGrantSet.has(permissionKey) ? (
                          <span className="block text-xs text-muted-foreground">
                            {t("companyAccess.editMember.includedImplicitly", { role: draftRole ? HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[draftRole] : t("companyAccess.editMember.selectedRoleFallback") })}
                          </span>
                        ) : null}
                        {draftGrants.has(permissionKey) ? (
                          <span className="block text-xs text-muted-foreground">
                            {t("companyAccess.editMember.storedExplicitly")}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMemberId(null)}>
              {t("companyAccess.editMember.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (!editingMember) return;
                updateMemberMutation.mutate({
                  memberId: editingMember.id,
                  membershipRole: draftRole,
                  status: draftStatus,
                  grants: [...draftGrants],
                });
              }}
              disabled={updateMemberMutation.isPending}
            >
              {updateMemberMutation.isPending ? t("companyAccess.editMember.saving") : t("companyAccess.editMember.saveAccess")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removingMember} onOpenChange={(open) => !open && setRemovingMemberId(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("companyAccess.removeMember.title")}</DialogTitle>
            <DialogDescription>
              {t("companyAccess.removeMember.description", { name: memberDisplayName(removingMember) })}
            </DialogDescription>
          </DialogHeader>
          {removingMember && (
            <div className="space-y-5">
              <div className="rounded-lg border border-border px-3 py-3">
                <div className="text-sm font-medium">{memberDisplayName(removingMember)}</div>
                <div className="text-sm text-muted-foreground">{removingMember.user?.email || removingMember.principalId}</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  {assignedIssuesQuery.isLoading
                    ? t("companyAccess.removeMember.checkingIssues")
                    : t("companyAccess.removeMember.openIssues", { count: assignedIssues.length })}
                </div>
              </div>

              {assignedIssues.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t("companyAccess.removeMember.reassignment")}</div>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={reassignmentTarget}
                    onChange={(event) => setReassignmentTarget(event.target.value)}
                  >
                    <option value="__unassigned">{t("companyAccess.removeMember.leaveUnassigned")}</option>
                    {activeReassignmentUsers.length > 0 ? (
                      <optgroup label={t("companyAccess.removeMember.humansGroup")}>
                        {activeReassignmentUsers.map((member) => (
                          <option key={member.id} value={`user:${member.principalId}`}>
                            {memberDisplayName(member)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {activeReassignmentAgents.length > 0 ? (
                      <optgroup label={t("companyAccess.removeMember.agentsGroup")}>
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
                        {t("companyAccess.removeMember.moreIssues", { count: assignedIssues.length - 6 })}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovingMemberId(null)}>
              {t("companyAccess.removeMember.cancel")}
            </Button>
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
              {archiveMemberMutation.isPending ? t("companyAccess.removeMember.removing") : t("companyAccess.removeMember.removeMember")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function memberDisplayName(member: CompanyMember | null) {
  if (!member) return "this member";
  return member.user?.name?.trim() || member.user?.email || member.principalId;
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
    <div className="rounded-xl border border-border px-4 py-4">
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
