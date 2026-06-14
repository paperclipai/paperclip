import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS,
  type Agent,
} from "@paperclipai/shared";
import { Shield, ShieldCheck, Trash2, Users } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
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
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link, Navigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { usePluginSlots } from "@/plugins/slots";

const reassignmentIssueStatuses = "backlog,todo,in_progress,in_review,blocked,failed,timed_out";
type EditableMemberStatus = "pending" | "active" | "suspended";

export function CompanyAccess() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [reassignmentTarget, setReassignmentTarget] = useState<string>("__unassigned");
  const [draftRole, setDraftRole] = useState<CompanyMember["membershipRole"]>(null);
  const [draftStatus, setDraftStatus] = useState<EditableMemberStatus>("active");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Members" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

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
        title: "Member updated",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update member",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const approveJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: "Join request approved",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to approve join request",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: "Join request rejected",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to reject join request",
        body: error instanceof Error ? error.message : "Unknown error",
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
        title: "Member removed",
        body:
          result.reassignedIssueCount > 0
            ? `${result.reassignedIssueCount} assigned task${result.reassignedIssueCount === 1 ? "" : "s"} cleaned up.`
            : undefined,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to remove member",
        body: error instanceof Error ? error.message : "Unknown error",
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
    return <div className="text-sm text-muted-foreground">Select a company to manage access.</div>;
  }

  if (membersQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading company access…</div>;
  }

  if (membersQuery.error) {
    const message =
      membersQuery.error instanceof ApiError && membersQuery.error.status === 403
        ? "You do not have permission to manage company members."
        : membersQuery.error instanceof Error
          ? membersQuery.error.message
          : "Failed to load company members.";
    return <div className="text-sm text-destructive">{message}</div>;
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
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Company Members</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Manage the people who can work in {selectedCompany?.name}. Members can collaborate across the company by default.
        </p>
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Core keeps this page focused on membership, invite approvals, and safe member removal.
        </div>
      </div>

      {access && !access.currentUserRole && (
        <div className="rounded-xl border border-amber-500/40 px-4 py-3 text-sm text-amber-200">
          This account can manage access here through instance-admin privileges, but it does not currently hold an active company membership.
        </div>
      )}

      <section className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Humans</h2>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Manage human company memberships and status here.
          </p>
        </div>

        {access?.canApproveJoinRequests && pendingHumanJoinRequests.length > 0 ? (
          <div className="space-y-3 rounded-xl border border-border px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Pending human joins</h3>
                <p className="text-sm text-muted-foreground">
                  Review pending join requests before they become active company members.
                </p>
              </div>
              <Badge variant="outline">{pendingHumanJoinRequests.length} pending</Badge>
            </div>
            <div className="space-y-3">
              {pendingHumanJoinRequests.map((request) => (
                <PendingJoinRequestCard
                  key={request.id}
                  title={
                    request.requesterUser?.name ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    "Unknown human requester"
                  }
                  subtitle={
                    request.requesterUser?.email ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    "No email available"
                  }
                  context={
                    request.invite
                      ? `${request.invite.allowedJoinTypes} join invite${request.invite.humanRole ? ` • default role ${request.invite.humanRole}` : ""}`
                      : "Invite metadata unavailable"
                  }
                  detail={`Submitted ${new Date(request.createdAt).toLocaleString()}`}
                  approveLabel="Approve human"
                  rejectLabel="Reject human"
                  disabled={joinRequestActionPending}
                  onApprove={() => approveJoinRequestMutation.mutate(request.id)}
                  onReject={() => rejectJoinRequestMutation.mutate(request.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-[minmax(0,1.5fr)_120px_120px_180px] gap-3 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <div>User account</div>
            <div>Role</div>
            <div>Status</div>
            <div className="text-right">Action</div>
          </div>
          {members.length === 0 ? (
            <div className="px-4 py-8 text-sm text-muted-foreground">No user memberships found for this company yet.</div>
          ) : (
            members.map((member) => {
              const removalReason = member.removal?.reason ?? null;
              const canArchive = member.removal?.canArchive ?? true;
              return (
                <div
                  key={member.id}
                  className="grid grid-cols-[minmax(0,1.5fr)_120px_120px_180px] gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{member.user?.name?.trim() || member.user?.email || member.principalId}</div>
                    <div className="truncate text-xs text-muted-foreground">{member.user?.email || member.principalId}</div>
                  </div>
                  <div className="text-sm">
                    {member.membershipRole
                      ? HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[member.membershipRole]
                      : "Unset"}
                  </div>
                  <div>
                    <Badge variant={member.status === "active" ? "secondary" : member.status === "suspended" ? "destructive" : "outline"}>
                      {member.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <div className="space-y-1 text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditingMemberId(member.id)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRemovingMemberId(member.id)}
                        disabled={!canArchive}
                        title={removalReason ?? undefined}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Remove
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
            <DialogTitle>Edit member</DialogTitle>
            <DialogDescription>
              Update company role and membership status for {editingMember?.user?.name || editingMember?.user?.email || editingMember?.principalId}.
            </DialogDescription>
          </DialogHeader>
          {editingMember && (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Company role</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftRole ?? ""}
                    onChange={(event) =>
                      setDraftRole((event.target.value || null) as CompanyMember["membershipRole"])
                    }
                  >
                    <option value="">Unset</option>
                    {Object.entries(HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Membership status</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftStatus}
                    onChange={(event) =>
                      setDraftStatus(event.target.value as EditableMemberStatus)
                    }
                  >
                    <option value="active">Active</option>
                    <option value="pending">Pending</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </label>
              </div>
              {selectedCompany?.issueVisibilityMode === "project_scoped" ? (
                <div
                  className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
                  data-testid="member-project-scope-note"
                >
                  {draftRole === "owner" || draftRole === "admin" ? (
                    <span>
                      Owners and admins always see every issue in this company.
                    </span>
                  ) : (
                    <span>
                      This company uses project-scoped issue visibility. With this role,
                      the member only sees issues in projects they belong to, plus issues
                      assigned to them. Manage project membership from the{" "}
                      <Link to="/projects" className="underline hover:text-foreground">
                        Projects
                      </Link>{" "}
                      page, or grant cross-project visibility with an{" "}
                      <code>issues:read_scope</code> grant.
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMemberId(null)}>
              Cancel
            </Button>
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
              {updateMemberMutation.isPending ? "Saving…" : "Save member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removingMember} onOpenChange={(open) => !open && setRemovingMemberId(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Remove member</DialogTitle>
            <DialogDescription>
              Archive {memberDisplayName(removingMember)} and move active assignments before hiding this user from assignment fields.
            </DialogDescription>
          </DialogHeader>
          {removingMember && (
            <div className="space-y-5">
              <div className="rounded-lg border border-border px-3 py-3">
                <div className="text-sm font-medium">{memberDisplayName(removingMember)}</div>
                <div className="text-sm text-muted-foreground">{removingMember.user?.email || removingMember.principalId}</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  {assignedIssuesQuery.isLoading
                    ? "Checking assigned tasks..."
                    : `${assignedIssues.length} open assigned task${assignedIssues.length === 1 ? "" : "s"}`}
                </div>
              </div>

              {assignedIssues.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Task reassignment</div>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={reassignmentTarget}
                    onChange={(event) => setReassignmentTarget(event.target.value)}
                  >
                    <option value="__unassigned">Leave unassigned</option>
                    {activeReassignmentUsers.length > 0 ? (
                      <optgroup label="Humans">
                        {activeReassignmentUsers.map((member) => (
                          <option key={member.id} value={`user:${member.principalId}`}>
                            {memberDisplayName(member)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {activeReassignmentAgents.length > 0 ? (
                      <optgroup label="Agents">
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
                        {assignedIssues.length - 6} more task{assignedIssues.length - 6 === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovingMemberId(null)}>
              Cancel
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
              {archiveMemberMutation.isPending ? "Removing..." : "Remove member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function CompanyAccessLegacyRoute() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { slots, isLoading, errorMessage } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Access" },
    ]);
  }, [setBreadcrumbs]);

  const permissionsSlot = slots.find((slot) => slot.routePath === "permissions");
  if (permissionsSlot) {
    return <Navigate to="/company/settings/permissions" replace />;
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Checking for advanced permission extensions...</div>;
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Advanced Permissions</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Advanced access, scoped assignment, and explicit grant controls are provided by installed company settings extensions.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border px-5 py-5">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Advanced permissions unavailable</h2>
          <p className="text-sm text-muted-foreground">
            Core Paperclip keeps enforcing company boundaries and any existing restrictive policy data, but editing advanced permissions requires an installed extension.
          </p>
          {errorMessage ? (
            <p className="text-sm text-destructive">Plugin extensions unavailable: {errorMessage}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/company/settings/members">Open Members</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/company/settings/invites">Open Invites</Link>
          </Button>
        </div>
      </div>
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
