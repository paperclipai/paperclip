import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CompanyMembership } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { departmentsApi, type DepartmentMembership } from "../api/departments";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { InlineEntitySelector } from "../components/InlineEntitySelector";
import { queryKeys } from "../lib/queryKeys";
import {
  buildAgentMemberOptions,
  buildUserMemberOptions,
  resolvePrincipalLabel,
  resolvePrincipalSubtitle,
} from "../lib/principal-members";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Archive, ArrowLeft, Building2, Pencil, Plus, Trash2, Users } from "lucide-react";

export function DepartmentDetail() {
  const { departmentId } = useParams<{ departmentId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberPrincipalType, setMemberPrincipalType] = useState<"agent" | "user">("agent");
  const [memberPrincipalId, setMemberPrincipalId] = useState("");
  const [memberRole, setMemberRole] = useState("member");

  const { data: department, isLoading } = useQuery({
    queryKey: queryKeys.departments.detail(departmentId!),
    queryFn: () => departmentsApi.getById(departmentId!),
    enabled: !!departmentId,
  });
  const resolvedCompanyId = department?.companyId ?? selectedCompanyId;

  const { data: members } = useQuery({
    queryKey: queryKeys.departments.members(departmentId!),
    queryFn: () => departmentsApi.listMembers(departmentId!),
    enabled: !!departmentId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const companyMembersQuery = useQuery({
    queryKey: queryKeys.access.members(resolvedCompanyId!),
    queryFn: () => accessApi.listMembers(resolvedCompanyId!),
    enabled: !!resolvedCompanyId && showAddMember && memberPrincipalType === "user",
    retry: false,
  });

  useEffect(() => {
    if (!department?.companyId || department.companyId === selectedCompanyId) return;
    setSelectedCompanyId(department.companyId, { source: "route_sync" });
  }, [department?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    if (!department) return;
    setBreadcrumbs([{ label: "Departments", href: "/departments" }, { label: department.name }]);
  }, [department, setBreadcrumbs]);

  useEffect(() => {
    if (!showAddMember) {
      setMemberPrincipalType("agent");
      setMemberPrincipalId("");
      setMemberRole("member");
      return;
    }
    setMemberPrincipalId("");
  }, [memberPrincipalType, showAddMember]);

  const agentById = useMemo(() => {
    const map = new Map<string, (typeof agents)[number]>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const existingMemberKeys = useMemo(
    () => new Set((members ?? []).map((member) => `${member.principalType}:${member.principalId}`)),
    [members],
  );

  const agentOptions = useMemo(() => buildAgentMemberOptions(agents), [agents]);
  const userOptions = useMemo(
    () => buildUserMemberOptions((companyMembersQuery.data ?? []) as CompanyMembership[]),
    [companyMembersQuery.data],
  );

  const availableAgentOptions = useMemo(
    () => agentOptions.filter((option) => !existingMemberKeys.has(`agent:${option.id}`)),
    [agentOptions, existingMemberKeys],
  );
  const availableUserOptions = useMemo(
    () => userOptions.filter((option) => !existingMemberKeys.has(`user:${option.id}`)),
    [existingMemberKeys, userOptions],
  );

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; description?: string | null }) =>
      departmentsApi.update(departmentId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.detail(departmentId!) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.departments.tree(resolvedCompanyId) });
      }
      setEditing(false);
      pushToast({ title: "Department updated", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "Failed to update department", body: error.message, tone: "error" }),
  });

  const archiveMutation = useMutation({
    mutationFn: () => departmentsApi.archive(departmentId!),
    onSuccess: () => {
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.departments.tree(resolvedCompanyId) });
      }
      pushToast({ title: "Department archived", tone: "success" });
      navigate("/departments");
    },
    onError: (error: Error) => pushToast({ title: "Failed to archive department", body: error.message, tone: "error" }),
  });

  const addMemberMutation = useMutation({
    mutationFn: (data: { principalType: string; principalId: string; role?: string }) =>
      departmentsApi.addMember(departmentId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.members(departmentId!) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.departments.tree(resolvedCompanyId) });
      }
      setShowAddMember(false);
      pushToast({ title: "Member added", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "Failed to add member", body: error.message, tone: "error" }),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (membership: DepartmentMembership) =>
      departmentsApi.removeMember(departmentId!, membership.principalType, membership.principalId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.members(departmentId!) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.departments.tree(resolvedCompanyId) });
      }
      pushToast({ title: "Member removed", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "Failed to remove member", body: error.message, tone: "error" }),
  });

  if (isLoading || !department) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-muted/50" />
          <div className="h-4 w-96 rounded bg-muted/50" />
        </div>
      </div>
    );
  }

  const memberOptions = memberPrincipalType === "agent" ? availableAgentOptions : availableUserOptions;
  const selectorIsLoading = memberPrincipalType === "user" && companyMembersQuery.isLoading;
  const selectorHasFallback = memberPrincipalType === "user" && Boolean(companyMembersQuery.error);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => navigate("/departments")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Building2 className="h-5 w-5 text-muted-foreground shrink-0" />
            <h1 className="text-lg font-semibold truncate">{department.name}</h1>
            <Badge variant={department.status === "active" ? "default" : "secondary"}>{department.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {department.description ?? "No description yet."}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditName(department.name);
              setEditDescription(department.description ?? "");
              setEditing(true);
            }}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (window.confirm("Archive this department?")) archiveMutation.mutate();
            }}
          >
            <Archive className="mr-1 h-3.5 w-3.5" />
            Archive
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Members</h2>
            <Badge variant="secondary" className="text-xs">
              {members?.length ?? 0}
            </Badge>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowAddMember(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add Member
          </Button>
        </div>

        {members && members.length > 0 ? (
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {members.map((member) => {
              const principalLabel = resolvePrincipalLabel(member, agentById);
              const principalSubtitle = resolvePrincipalSubtitle(member, agentById);
              return (
                <div key={member.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant="outline" className="text-xs shrink-0">
                      {member.principalType}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{principalLabel}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">{member.principalId}</p>
                      {principalSubtitle ? (
                        <p className="text-xs text-muted-foreground truncate">{principalSubtitle}</p>
                      ) : null}
                    </div>
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {member.role}
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeMemberMutation.mutate(member)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No members yet. Add agents or users to this department.
          </div>
        )}
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Department</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              updateMutation.mutate({
                name: editName,
                description: editDescription || null,
              });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input value={editName} onChange={(event) => setEditName(event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!editName.trim() || updateMutation.isPending}>
                {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              addMemberMutation.mutate({
                principalType: memberPrincipalType,
                principalId: memberPrincipalId,
                role: memberRole,
              });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <label className="text-sm font-medium">Type</label>
              <Select value={memberPrincipalType} onValueChange={(value: "agent" | "user") => setMemberPrincipalType(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Member</label>
              {selectorIsLoading ? (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  Loading company members...
                </div>
              ) : selectorHasFallback ? (
                <>
                  <Input
                    value={memberPrincipalId}
                    onChange={(event) => setMemberPrincipalId(event.target.value)}
                    placeholder="Paste the user ID"
                  />
                  <p className="text-xs text-muted-foreground">
                    Could not load the company user list. You can still add a user by ID.
                  </p>
                </>
              ) : (
                <>
                  <InlineEntitySelector
                    value={memberPrincipalId}
                    options={memberOptions}
                    placeholder={memberPrincipalType === "agent" ? "Select an agent" : "Select a user"}
                    noneLabel="No selection"
                    searchPlaceholder={memberPrincipalType === "agent" ? "Search agents..." : "Search users..."}
                    emptyMessage={
                      memberPrincipalType === "agent"
                        ? "No eligible agents available."
                        : "No eligible users available."
                    }
                    onChange={setMemberPrincipalId}
                    disablePortal
                    className="w-full justify-between px-3 py-2"
                  />
                  <p className="text-xs text-muted-foreground">
                    {memberPrincipalType === "agent"
                      ? "Only active company agents that are not already in this department are listed."
                      : "Only active company users that are not already in this department are listed."}
                  </p>
                </>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Role</label>
              <Select value={memberRole} onValueChange={setMemberRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowAddMember(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!memberPrincipalId.trim() || addMemberMutation.isPending}>
                {addMemberMutation.isPending ? "Adding..." : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
