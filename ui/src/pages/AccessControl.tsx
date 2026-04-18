import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PERMISSION_KEYS,
  type CompanyRoleWithPermissions,
  type CompanyMembershipAccessSummary,
  type PermissionGrantInput,
  type PermissionScope,
} from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { departmentsApi } from "../api/departments";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Shield, Sparkles } from "lucide-react";

type ScopeDraft = {
  mode: "company" | "departments";
  departmentIds: string[];
  includeDescendants: boolean;
};

type GrantDraft = ScopeDraft & {
  permissionKey: string;
  enabled: boolean;
};

type RoleDraft = {
  key: string;
  name: string;
  description: string;
  permissionKeys: string[];
};

type PermissionGroup = {
  id: string;
  label: string;
  description: string;
  permissionKeys: ReadonlyArray<(typeof PERMISSION_KEYS)[number]>;
};

type EffectivePermissionEntry = CompanyMembershipAccessSummary["effectivePermissions"][number];

const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "organization",
    label: "Organization & Access",
    description: "Visibility, role administration, and company permission controls.",
    permissionKeys: ["org:view", "roles:view", "roles:manage", "users:invite", "users:manage_permissions"],
  },
  {
    id: "structure",
    label: "Departments & Teams",
    description: "Org-structure permissions for departments, teams, and membership boundaries.",
    permissionKeys: ["departments:view", "departments:manage", "teams:view", "teams:manage"],
  },
  {
    id: "delivery",
    label: "Projects & Issues",
    description: "Planning and execution access across projects, issues, and delivery workflows.",
    permissionKeys: ["projects:view", "projects:manage", "issues:view", "issues:manage"],
  },
  {
    id: "agents",
    label: "Agents & Operations",
    description: "Agent lifecycle, join approvals, and task assignment controls.",
    permissionKeys: ["agents:create", "agents:view", "agents:manage", "tasks:assign", "tasks:assign_scope", "joins:approve"],
  },
];

const FALLBACK_PERMISSION_GROUP: PermissionGroup = {
  id: "other",
  label: "Other Permissions",
  description: "Permissions that are not yet mapped into an operator-facing category.",
  permissionKeys: [],
};

const permissionOrderByKey = new Map(PERMISSION_KEYS.map((permissionKey, index) => [permissionKey, index] as const));
const permissionGroupByKey = new Map(
  PERMISSION_GROUPS.flatMap((group) => group.permissionKeys.map((permissionKey) => [permissionKey, group] as const)),
);

function sortStrings(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortPermissionEntries<T extends { permissionKey: string }>(entries: readonly T[]) {
  return [...entries].sort(
    (left, right) =>
      (permissionOrderByKey.get(left.permissionKey as (typeof PERMISSION_KEYS)[number]) ?? Number.MAX_SAFE_INTEGER) -
      (permissionOrderByKey.get(right.permissionKey as (typeof PERMISSION_KEYS)[number]) ?? Number.MAX_SAFE_INTEGER),
  );
}

function scopeToDraft(scope: PermissionScope | null | undefined): ScopeDraft {
  if (!scope || scope.kind !== "departments") {
    return { mode: "company", departmentIds: [], includeDescendants: false };
  }
  return {
    mode: "departments",
    departmentIds: sortStrings(scope.departmentIds),
    includeDescendants: scope.includeDescendants,
  };
}

function scopeDraftToScope(draft: ScopeDraft): PermissionScope {
  if (draft.mode === "company") return null;
  return {
    kind: "departments",
    departmentIds: sortStrings(draft.departmentIds),
    includeDescendants: draft.includeDescendants,
  };
}

function createGrantDrafts(member: CompanyMembershipAccessSummary | null): GrantDraft[] {
  const grantByPermission = new Map(
    (member?.directGrants ?? []).map((grant) => [grant.permissionKey, grant]),
  );

  return PERMISSION_KEYS.map((permissionKey) => {
    const directGrant = grantByPermission.get(permissionKey) ?? null;
    const scope = scopeToDraft(directGrant?.scope ?? null);
    return {
      permissionKey,
      enabled: Boolean(directGrant),
      ...scope,
    };
  });
}

function grantDraftsToPayload(drafts: GrantDraft[]): PermissionGrantInput[] {
  return drafts
    .filter((draft) => draft.enabled)
    .map((draft) => ({
      permissionKey: draft.permissionKey as PermissionGrantInput["permissionKey"],
      scope: scopeDraftToScope(draft),
    }));
}

function humanizePermissionKey(permissionKey: string) {
  const [domain, action] = permissionKey.split(":");
  return `${domain.replace(/_/g, " ")} ${action?.replace(/_/g, " ") ?? ""}`.trim();
}

function normalizeRoleKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function createRoleDraft(role?: CompanyRoleWithPermissions | null): RoleDraft {
  return {
    key: role?.key ?? "",
    name: role?.name ?? "",
    description: role?.description ?? "",
    permissionKeys: role?.permissionKeys ?? [],
  };
}

function renderScopeLabel(
  scope: PermissionScope | null | undefined,
  departmentById: Map<string, { id: string; name: string }>,
) {
  if (!scope || scope.kind !== "departments") return "Company-wide";
  const labels = scope.departmentIds.map((departmentId) => departmentById.get(departmentId)?.name ?? departmentId);
  const suffix = scope.includeDescendants ? " + descendants" : "";
  return `${labels.join(", ")}${suffix}`;
}

function groupEffectivePermissions(effectivePermissions: EffectivePermissionEntry[]) {
  const permissionsByGroup = new Map(PERMISSION_GROUPS.map((group) => [group.id, [] as EffectivePermissionEntry[]]));
  const unmappedPermissions: EffectivePermissionEntry[] = [];

  for (const permission of effectivePermissions) {
    const group = permissionGroupByKey.get(permission.permissionKey);
    if (!group) {
      unmappedPermissions.push(permission);
      continue;
    }
    permissionsByGroup.get(group.id)?.push(permission);
  }

  const groupedPermissions = PERMISSION_GROUPS.map((group) => ({
    ...group,
    permissions: sortPermissionEntries(permissionsByGroup.get(group.id) ?? []),
  }));

  if (unmappedPermissions.length > 0) {
    groupedPermissions.push({
      ...FALLBACK_PERMISSION_GROUP,
      permissions: sortPermissionEntries(unmappedPermissions),
    });
  }

  return groupedPermissions;
}

function renderEffectivePermissionScopeLabel(
  permission: EffectivePermissionEntry,
  departmentById: Map<string, { id: string; name: string }>,
) {
  if (permission.companyWide) return "Company-wide";
  if (permission.departmentIds.length === 0) return "Department-scoped";
  return renderScopeLabel(
    {
      kind: "departments",
      departmentIds: permission.departmentIds,
      includeDescendants: false,
    },
    departmentById,
  );
}

export function AccessControl() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [principalTypeFilter, setPrincipalTypeFilter] = useState<"all" | "user" | "agent">("all");
  const [grantEditorMember, setGrantEditorMember] = useState<CompanyMembershipAccessSummary | null>(null);
  const [grantDrafts, setGrantDrafts] = useState<GrantDraft[]>(createGrantDrafts(null));
  const [roleEditorMember, setRoleEditorMember] = useState<CompanyMembershipAccessSummary | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [roleScopeDraft, setRoleScopeDraft] = useState<ScopeDraft>({
    mode: "company",
    departmentIds: [],
    includeDescendants: false,
  });
  const [roleDraft, setRoleDraft] = useState<RoleDraft>(createRoleDraft());
  const [roleDialogMode, setRoleDialogMode] = useState<"create" | "edit" | null>(null);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Access Control" }]);
  }, [setBreadcrumbs]);

  const rolesQuery = useQuery({
    queryKey: queryKeys.access.roles(selectedCompanyId!),
    queryFn: () => accessApi.listRoles(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
  });

  const membersQuery = useQuery({
    queryKey: queryKeys.access.accessSummary(selectedCompanyId!),
    queryFn: () => accessApi.listMemberAccessSummary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
  });

  const departmentsQuery = useQuery({
    queryKey: queryKeys.departments.list(selectedCompanyId!),
    queryFn: () => departmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
  });

  const departmentById = useMemo(
    () => new Map((departmentsQuery.data ?? []).map((department) => [department.id, department])),
    [departmentsQuery.data],
  );

  const activeRoles = useMemo(
    () => (rolesQuery.data ?? []).filter((role) => role.status === "active"),
    [rolesQuery.data],
  );
  const archivedRoles = useMemo(
    () => (rolesQuery.data ?? []).filter((role) => role.status === "archived"),
    [rolesQuery.data],
  );

  const openCreateRoleDialog = () => {
    setRoleDialogMode("create");
    setEditingRoleId(null);
    setRoleDraft(createRoleDraft());
  };

  const openEditRoleDialog = (role: CompanyRoleWithPermissions) => {
    setRoleDialogMode("edit");
    setEditingRoleId(role.id);
    setRoleDraft(createRoleDraft(role));
  };

  const filteredMembers = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (membersQuery.data ?? []).filter((member) => {
      if (principalTypeFilter !== "all" && member.principalType !== principalTypeFilter) return false;
      if (!normalizedSearch) return true;
      const haystack = [
        member.principal.name,
        member.principal.email,
        member.principal.title,
        member.principalId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [membersQuery.data, principalTypeFilter, search]);

  const seedRolesMutation = useMutation({
    mutationFn: () => accessApi.seedSystemRoles(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.roles(selectedCompanyId!) });
      pushToast({ title: "System roles ready", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Failed to seed roles", body: error.message, tone: "error" });
    },
  });

  const createRoleMutation = useMutation({
    mutationFn: () =>
      accessApi.createRole(selectedCompanyId!, {
        key: roleDraft.key,
        name: roleDraft.name.trim(),
        description: roleDraft.description.trim() || null,
        permissionKeys: roleDraft.permissionKeys as Array<(typeof PERMISSION_KEYS)[number]>,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.roles(selectedCompanyId!) });
      setRoleDialogMode(null);
      setEditingRoleId(null);
      setRoleDraft(createRoleDraft());
      pushToast({ title: "Role created", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Failed to create role", body: error.message, tone: "error" });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: () =>
      accessApi.updateRole(selectedCompanyId!, editingRoleId!, {
        name: roleDraft.name.trim(),
        description: roleDraft.description.trim() || null,
        permissionKeys: roleDraft.permissionKeys as Array<(typeof PERMISSION_KEYS)[number]>,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.roles(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.access.accessSummary(selectedCompanyId!) });
      setRoleDialogMode(null);
      setEditingRoleId(null);
      setRoleDraft(createRoleDraft());
      pushToast({ title: "Role updated", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Failed to update role", body: error.message, tone: "error" });
    },
  });

  const archiveRoleMutation = useMutation({
    mutationFn: (roleId: string) => accessApi.archiveRole(selectedCompanyId!, roleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.roles(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.access.accessSummary(selectedCompanyId!) });
      pushToast({ title: "Role archived", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Failed to archive role", body: error.message, tone: "error" });
    },
  });

  const saveMemberPermissionsMutation = useMutation({
    mutationFn: (input: { memberId: string; grants: PermissionGrantInput[] }) =>
      accessApi.setMemberPermissions(selectedCompanyId!, input.memberId, input.grants),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.accessSummary(selectedCompanyId!) });
      setGrantEditorMember(null);
      pushToast({ title: "Advanced grants updated", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Failed to update advanced grants", body: error.message, tone: "error" });
    },
  });

  const assignRoleMutation = useMutation({
    mutationFn: (input: { principalType: "user" | "agent"; principalId: string; roleId: string; scope: PermissionScope }) =>
      accessApi.assignRole(selectedCompanyId!, input.principalType, input.principalId, {
        roleId: input.roleId,
        scope: input.scope,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.accessSummary(selectedCompanyId!) });
      setRoleEditorMember(null);
      setSelectedRoleId("");
      setRoleScopeDraft({ mode: "company", departmentIds: [], includeDescendants: false });
      pushToast({ title: "Role assigned", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Failed to assign role", body: error.message, tone: "error" });
    },
  });

  const removeRoleMutation = useMutation({
    mutationFn: (assignmentId: string) => accessApi.removeRoleAssignment(selectedCompanyId!, assignmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.accessSummary(selectedCompanyId!) });
      pushToast({ title: "Role removed", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Failed to remove role", body: error.message, tone: "error" });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Shield} message="Select a company to manage access control." />;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Access Control</h1>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Start with reusable roles and scoped role assignments. Keep direct grants for rare exceptions and one-off
            overrides.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => seedRolesMutation.mutate()}
          disabled={seedRolesMutation.isPending}
        >
          <Sparkles className="mr-2 h-4 w-4" />
          Seed System Roles
        </Button>
      </div>

      {(rolesQuery.error || membersQuery.error) ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">
            {(rolesQuery.error ?? membersQuery.error)?.message ?? "Failed to load access control data."}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.05fr_1.95fr]">
        <Card className="gap-4">
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <CardTitle>Roles</CardTitle>
                <CardDescription>
                  {activeRoles.length > 0
                    ? `${activeRoles.length} active roles available for assignment.`
                    : "No active roles yet. Seed the system roles to bootstrap department RBAC."}
                </CardDescription>
              </div>
              <Button size="sm" onClick={openCreateRoleDialog}>
                Create Custom Role
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {rolesQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading roles...</p>
            ) : activeRoles.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                System roles have not been seeded for this company yet.
              </div>
            ) : (
              activeRoles.map((role) => (
                <div key={role.id} className="rounded-lg border border-border bg-card/50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium">{role.name}</h3>
                        {role.isSystem ? <Badge variant="secondary">System</Badge> : null}
                      </div>
                      <p className="text-xs text-muted-foreground">{role.description ?? "No description."}</p>
                    </div>
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {role.key}
                    </Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {role.permissionKeys.map((permissionKey) => (
                      <Badge key={permissionKey} variant="secondary" className="text-[11px]">
                        {permissionKey}
                      </Badge>
                    ))}
                  </div>
                  {!role.isSystem ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => openEditRoleDialog(role)}>
                        Edit Role
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => archiveRoleMutation.mutate(role.id)}
                        disabled={archiveRoleMutation.isPending}
                      >
                        Archive
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
            {archivedRoles.length > 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                {archivedRoles.length} archived {archivedRoles.length === 1 ? "role" : "roles"} hidden from assignment.
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Principals</CardTitle>
            <CardDescription>
              Assign roles first. Use advanced grants only when a principal needs a temporary or exceptional override.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, email, title, or principal id"
              />
              <Select value={principalTypeFilter} onValueChange={(value) => setPrincipalTypeFilter(value as "all" | "user" | "agent")}>
                <SelectTrigger className="w-full lg:w-44">
                  <SelectValue placeholder="All principals" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All principals</SelectItem>
                  <SelectItem value="user">Users</SelectItem>
                  <SelectItem value="agent">Agents</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {membersQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading principals...</p>
            ) : filteredMembers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
                No principals matched the current filter.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredMembers.map((member) => (
                  <div key={member.id} className="rounded-lg border border-border bg-card/50 p-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div className="space-y-2 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-medium">{member.principal.name}</h3>
                          <Badge variant="outline">{member.principalType}</Badge>
                          {member.membershipRole ? <Badge variant="secondary">{member.membershipRole}</Badge> : null}
                        </div>
                        <div className="space-y-1 text-xs text-muted-foreground">
                          {member.principal.email ? <p>{member.principal.email}</p> : null}
                          {member.principal.title ? <p>{member.principal.title}</p> : null}
                          <p className="font-mono">{member.principalId}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            setRoleEditorMember(member);
                            setSelectedRoleId(activeRoles[0]?.id ?? "");
                            setRoleScopeDraft({ mode: "company", departmentIds: [], includeDescendants: false });
                          }}
                          disabled={activeRoles.length === 0}
                        >
                          Assign Role
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setGrantEditorMember(member);
                            setGrantDrafts(createGrantDrafts(member));
                          }}
                        >
                          Advanced Grants
                        </Button>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-3">
                      <div className="space-y-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Role Assignments</p>
                        <div className="space-y-2">
                          {member.roleAssignments.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No assigned roles.</span>
                          ) : member.roleAssignments.map((assignment) => (
                            <div
                              key={assignment.id}
                              className="flex items-start justify-between gap-3 rounded-md border border-border bg-background/70 px-3 py-2"
                            >
                              <div className="min-w-0">
                                <p className="text-xs font-medium">{assignment.role.name}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  {renderScopeLabel(assignment.scope, departmentById)}
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => removeRoleMutation.mutate(assignment.id)}
                              >
                                Remove
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Effective Access</p>
                        <div className="flex flex-wrap gap-2">
                          {member.effectivePermissions.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No effective permissions.</span>
                          ) : member.effectivePermissions.map((permission) => (
                            <Badge key={permission.permissionKey} variant="outline" className="text-[11px]">
                              {permission.permissionKey}
                              <span className="ml-1 text-muted-foreground">
                                {permission.companyWide
                                  ? "Company-wide"
                                  : renderScopeLabel(
                                    {
                                      kind: "departments",
                                      departmentIds: permission.departmentIds,
                                      includeDescendants: false,
                                    },
                                    departmentById,
                                  )}
                              </span>
                            </Badge>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Advanced Grants</p>
                        <div className="flex flex-wrap gap-2">
                          {member.directGrants.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No direct grant overrides.</span>
                          ) : member.directGrants.map((grant) => (
                            <Badge key={grant.id} variant="secondary" className="text-[11px]">
                              {grant.permissionKey}
                              <span className="ml-1 text-muted-foreground">
                                {renderScopeLabel(grant.scope, departmentById)}
                              </span>
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Permission Matrix</CardTitle>
          <CardDescription>
            A grouped view of who currently has access to what based on role assignments and direct grants.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {membersQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading permission matrix...</p>
          ) : filteredMembers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
              No principals matched the current filter.
            </div>
          ) : (
            filteredMembers.map((member) => {
              const groupedPermissions = groupEffectivePermissions(member.effectivePermissions);
              return (
                <div key={`${member.id}-matrix`} className="rounded-lg border border-border bg-card/50 p-4">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium">{member.principal.name}</h3>
                        <Badge variant="outline">{member.principalType}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {member.principal.email ?? member.principalId}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {member.roleAssignments.length === 0 ? (
                        <Badge variant="outline" className="text-[11px]">
                          No role assignments
                        </Badge>
                      ) : (
                        member.roleAssignments.map((assignment) => (
                          <Badge key={assignment.id} variant="secondary" className="text-[11px]">
                            {assignment.role.name}
                            <span className="ml-1 text-muted-foreground">
                              {renderScopeLabel(assignment.scope, departmentById)}
                            </span>
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 xl:grid-cols-4">
                    {groupedPermissions.map((group) => (
                      <div
                        key={`${member.id}-${group.id}`}
                        className="rounded-md border border-border bg-background/70 p-3"
                      >
                        <div className="space-y-1">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {group.label}
                          </p>
                          <p className="text-[11px] text-muted-foreground">{group.description}</p>
                        </div>

                        <div className="mt-3 space-y-2">
                          {group.permissions.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No access</p>
                          ) : (
                            group.permissions.map((permission) => (
                              <div
                                key={`${member.id}-${group.id}-${permission.permissionKey}`}
                                className="rounded-md border border-border px-2 py-2"
                              >
                                <p className="text-xs font-medium">{humanizePermissionKey(permission.permissionKey)}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  {renderEffectivePermissionScopeLabel(permission, departmentById)}
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Dialog
        open={roleDialogMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRoleDialogMode(null);
            setEditingRoleId(null);
            setRoleDraft(createRoleDraft());
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{roleDialogMode === "edit" ? "Edit role" : "Create custom role"}</DialogTitle>
            <DialogDescription>
              Bundle permissions into a reusable role. Assignment scope is configured when the role is granted to a
              principal.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="role-name">Name</Label>
                <Input
                  id="role-name"
                  value={roleDraft.name}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setRoleDraft((current) => ({
                      ...current,
                      name: nextName,
                      key: roleDialogMode === "create" ? normalizeRoleKey(nextName) : current.key,
                    }));
                  }}
                  placeholder="Department QA Lead"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="role-key">Key</Label>
                <Input
                  id="role-key"
                  value={roleDraft.key}
                  onChange={(event) =>
                    setRoleDraft((current) => ({ ...current, key: normalizeRoleKey(event.target.value) }))
                  }
                  disabled={roleDialogMode === "edit"}
                  placeholder="department_qa_lead"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="role-description">Description</Label>
              <textarea
                id="role-description"
                className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
                value={roleDraft.description}
                onChange={(event) => setRoleDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder="Describe when this role should be used."
              />
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Permissions</Label>
                <p className="text-xs text-muted-foreground">
                  Choose the permissions bundled into this role. Scope is applied during assignment.
                </p>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {PERMISSION_GROUPS.map((group) => {
                  const selectedCount = group.permissionKeys.filter((permissionKey) =>
                    roleDraft.permissionKeys.includes(permissionKey),
                  ).length;

                  return (
                    <div key={group.id} className="rounded-lg border border-border bg-background/70 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <h3 className="text-sm font-medium">{group.label}</h3>
                          <p className="text-xs text-muted-foreground">{group.description}</p>
                        </div>
                        <Badge variant="outline" className="text-[11px]">
                          {selectedCount}/{group.permissionKeys.length}
                        </Badge>
                      </div>

                      <div className="mt-3 space-y-2">
                        {group.permissionKeys.map((permissionKey) => {
                          const checked = roleDraft.permissionKeys.includes(permissionKey);
                          return (
                            <label
                              key={permissionKey}
                              className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(nextChecked) =>
                                  setRoleDraft((current) => ({
                                    ...current,
                                    permissionKeys: nextChecked
                                      ? sortStrings([...current.permissionKeys, permissionKey])
                                      : current.permissionKeys.filter((entry) => entry !== permissionKey),
                                  }))
                                }
                              />
                              <div className="min-w-0">
                                <p className="text-sm font-medium">{humanizePermissionKey(permissionKey)}</p>
                                <p className="text-[11px] text-muted-foreground font-mono">{permissionKey}</p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRoleDialogMode(null);
                setEditingRoleId(null);
                setRoleDraft(createRoleDraft());
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (roleDialogMode === "edit") {
                  if (!editingRoleId) return;
                  updateRoleMutation.mutate();
                  return;
                }
                createRoleMutation.mutate();
              }}
              disabled={
                createRoleMutation.isPending ||
                updateRoleMutation.isPending ||
                !roleDraft.name.trim() ||
                (roleDialogMode !== "edit" && !roleDraft.key.trim()) ||
                roleDraft.permissionKeys.length === 0
              }
            >
              {roleDialogMode === "edit" ? "Save Role" : "Create Role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(grantEditorMember)} onOpenChange={(open) => !open && setGrantEditorMember(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              Advanced grants for {grantEditorMember?.principal.name ?? "principal"}
            </DialogTitle>
            <DialogDescription>
              Use direct grants only for exceptions that should not be encoded as reusable roles.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-2">
            {grantDrafts.map((draft, index) => (
              <div key={draft.permissionKey} className="rounded-lg border border-border p-4">
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={draft.enabled}
                    onCheckedChange={(checked) => {
                      setGrantDrafts((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, enabled: Boolean(checked) } : entry,
                        ),
                      );
                    }}
                  />
                  <div>
                    <p className="text-sm font-medium">{humanizePermissionKey(draft.permissionKey)}</p>
                    <p className="text-xs text-muted-foreground font-mono">{draft.permissionKey}</p>
                  </div>
                </div>

                {draft.enabled ? (
                  <div className="mt-4 space-y-4 pl-8">
                    <div className="space-y-2">
                      <Label>Scope</Label>
                      <Select
                        value={draft.mode}
                        onValueChange={(value) => {
                          setGrantDrafts((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? {
                                    ...entry,
                                    mode: value as ScopeDraft["mode"],
                                    departmentIds: value === "company" ? [] : entry.departmentIds,
                                  }
                                : entry,
                            ),
                          );
                        }}
                      >
                        <SelectTrigger className="w-full sm:w-60">
                          <SelectValue placeholder="Choose scope" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="company">Company-wide</SelectItem>
                          <SelectItem value="departments">Department-scoped</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {draft.mode === "departments" ? (
                      <div className="space-y-3">
                        <div className="grid gap-2 sm:grid-cols-2">
                          {(departmentsQuery.data ?? []).map((department) => {
                            const checked = draft.departmentIds.includes(department.id);
                            return (
                              <label
                                key={department.id}
                                className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(nextChecked) => {
                                    setGrantDrafts((current) =>
                                      current.map((entry, entryIndex) => {
                                        if (entryIndex !== index) return entry;
                                        const nextDepartmentIds = nextChecked
                                          ? sortStrings([...entry.departmentIds, department.id])
                                          : entry.departmentIds.filter((departmentId) => departmentId !== department.id);
                                        return { ...entry, departmentIds: nextDepartmentIds };
                                      }),
                                    );
                                  }}
                                />
                                <span>{department.name}</span>
                              </label>
                            );
                          })}
                        </div>
                        <label className="flex items-center gap-3 text-sm">
                          <Checkbox
                            checked={draft.includeDescendants}
                            onCheckedChange={(checked) => {
                              setGrantDrafts((current) =>
                                current.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, includeDescendants: Boolean(checked) } : entry,
                                ),
                              );
                            }}
                          />
                          <span>Include descendant departments</span>
                        </label>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setGrantEditorMember(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!grantEditorMember) return;
                saveMemberPermissionsMutation.mutate({
                  memberId: grantEditorMember.id,
                  grants: grantDraftsToPayload(grantDrafts),
                });
              }}
              disabled={saveMemberPermissionsMutation.isPending}
            >
              Save Advanced Grants
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(roleEditorMember)} onOpenChange={(open) => !open && setRoleEditorMember(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Assign role to {roleEditorMember?.principal.name ?? "principal"}
            </DialogTitle>
            <DialogDescription>
              Choose the reusable role first, then apply a company-wide or department-scoped assignment.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={selectedRoleId} onValueChange={setSelectedRoleId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectContent>
                  {activeRoles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Scope</Label>
              <Select
                value={roleScopeDraft.mode}
                onValueChange={(value) =>
                  setRoleScopeDraft((current) => ({
                    ...current,
                    mode: value as ScopeDraft["mode"],
                    departmentIds: value === "company" ? [] : current.departmentIds,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="company">Company-wide</SelectItem>
                  <SelectItem value="departments">Department-scoped</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {roleScopeDraft.mode === "departments" ? (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  {(departmentsQuery.data ?? []).map((department) => {
                    const checked = roleScopeDraft.departmentIds.includes(department.id);
                    return (
                      <label
                        key={department.id}
                        className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(nextChecked) => {
                            setRoleScopeDraft((current) => ({
                              ...current,
                              departmentIds: nextChecked
                                ? sortStrings([...current.departmentIds, department.id])
                                : current.departmentIds.filter((departmentId) => departmentId !== department.id),
                            }));
                          }}
                        />
                        <span>{department.name}</span>
                      </label>
                    );
                  })}
                </div>
                <label className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={roleScopeDraft.includeDescendants}
                    onCheckedChange={(checked) =>
                      setRoleScopeDraft((current) => ({ ...current, includeDescendants: Boolean(checked) }))
                    }
                  />
                  <span>Include descendant departments</span>
                </label>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleEditorMember(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                assignRoleMutation.isPending ||
                !roleEditorMember ||
                !selectedRoleId ||
                (roleScopeDraft.mode === "departments" && roleScopeDraft.departmentIds.length === 0)
              }
              onClick={() => {
                if (!roleEditorMember || !selectedRoleId) return;
                assignRoleMutation.mutate({
                  principalType: roleEditorMember.principalType,
                  principalId: roleEditorMember.principalId,
                  roleId: selectedRoleId,
                  scope: scopeDraftToScope(roleScopeDraft),
                });
              }}
            >
              Assign Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
