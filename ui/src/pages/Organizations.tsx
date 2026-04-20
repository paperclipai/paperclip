import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Trash2, Users, Building as BuildingIcon } from "lucide-react";
import { organizationsApi } from "../api/organizations";
import { companiesApi } from "../api/companies";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Organizations() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [addMemberEmail, setAddMemberEmail] = useState("");
  const [attachCompanyId, setAttachCompanyId] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Organizations" }]);
  }, [setBreadcrumbs]);

  const { data: organizations = [], isLoading: orgsLoading } = useQuery({
    queryKey: queryKeys.organizations.list,
    queryFn: () => organizationsApi.list(),
  });

  useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      setSelectedOrgId(organizations[0].id);
    }
    if (selectedOrgId && !organizations.some((o) => o.id === selectedOrgId)) {
      setSelectedOrgId(organizations[0]?.id ?? null);
    }
  }, [organizations, selectedOrgId]);

  const selectedOrg = useMemo(
    () => organizations.find((o) => o.id === selectedOrgId) ?? null,
    [organizations, selectedOrgId],
  );

  const createOrgMutation = useMutation({
    mutationFn: (name: string) => organizationsApi.create({ name }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.list });
      setSelectedOrgId(created.id);
      setNewOrgName("");
      setShowCreate(false);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to create organization",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const orgMembersQuery = useQuery({
    queryKey: selectedOrgId ? queryKeys.organizations.members(selectedOrgId) : ["organizations", "members", "__none__"],
    queryFn: () => organizationsApi.listMembers(selectedOrgId!),
    enabled: !!selectedOrgId,
  });

  const orgCompaniesQuery = useQuery({
    queryKey: selectedOrgId ? queryKeys.organizations.companies(selectedOrgId) : ["organizations", "companies", "__none__"],
    queryFn: () => organizationsApi.listCompanies(selectedOrgId!),
    enabled: !!selectedOrgId,
  });

  const allCompaniesQuery = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: () => companiesApi.list(),
  });

  const addMemberMutation = useMutation({
    mutationFn: (email: string) =>
      organizationsApi.addMember(selectedOrgId!, { email }),
    onSuccess: () => {
      if (!selectedOrgId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.members(selectedOrgId) });
      setAddMemberEmail("");
    },
    onError: (err) => {
      pushToast({
        title: "Failed to add member",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => organizationsApi.removeMember(selectedOrgId!, userId),
    onSuccess: () => {
      if (!selectedOrgId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.members(selectedOrgId) });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to remove member",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const attachCompanyMutation = useMutation({
    mutationFn: (companyId: string) =>
      organizationsApi.attachCompany(selectedOrgId!, companyId),
    onSuccess: () => {
      if (!selectedOrgId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.companies(selectedOrgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setAttachCompanyId("");
    },
    onError: (err) => {
      pushToast({
        title: "Failed to attach company",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const detachCompanyMutation = useMutation({
    mutationFn: (companyId: string) =>
      organizationsApi.detachCompany(selectedOrgId!, companyId),
    onSuccess: () => {
      if (!selectedOrgId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.companies(selectedOrgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to detach company",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const attachedCompanyIds = useMemo(
    () => new Set((orgCompaniesQuery.data ?? []).map((c) => c.id)),
    [orgCompaniesQuery.data],
  );

  const attachableCompanies = useMemo(
    () =>
      (allCompaniesQuery.data ?? []).filter(
        (company) => !attachedCompanyIds.has(company.id),
      ),
    [allCompaniesQuery.data, attachedCompanyIds],
  );

  function handleCreate() {
    const trimmed = newOrgName.trim();
    if (!trimmed) return;
    createOrgMutation.mutate(trimmed);
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-2">
        <Building2 className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Organizations</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6">
        {/* Sidebar: org list */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Your organizations
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => setShowCreate((s) => !s)}
              title="New organization"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          {showCreate && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
              <label className="text-xs text-muted-foreground mb-1 block">Name</label>
              <Input
                type="text"
                value={newOrgName}
                placeholder="Organization name"
                onChange={(e) => setNewOrgName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={createOrgMutation.isPending || !newOrgName.trim()}
                >
                  {createOrgMutation.isPending ? "Creating..." : "Create"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowCreate(false);
                    setNewOrgName("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-md border border-border overflow-hidden">
            {orgsLoading ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>
            ) : organizations.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No organizations yet.
              </div>
            ) : (
              organizations.map((org) => (
                <button
                  key={org.id}
                  onClick={() => setSelectedOrgId(org.id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                    org.id === selectedOrgId
                      ? "bg-accent text-foreground"
                      : "hover:bg-accent/50 text-muted-foreground"
                  }`}
                >
                  <Building2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{org.name}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Main: selected organization detail */}
        <div className="space-y-6 min-w-0">
          {!selectedOrg ? (
            <div className="rounded-md border border-border px-4 py-6 text-sm text-muted-foreground">
              Select an organization to manage members and companies, or create a new one.
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <h2 className="text-xl font-semibold">{selectedOrg.name}</h2>
                <p className="text-xs text-muted-foreground">
                  Created {new Date(selectedOrg.createdAt).toLocaleDateString()}
                </p>
              </div>

              {/* Members */}
              <div className="space-y-3">
                <div className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Members
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {orgMembersQuery.data?.length ?? 0}
                  </span>
                </div>

                <div className="rounded-md border border-border px-4 py-4 space-y-3">
                  <div className="flex items-end gap-2 flex-wrap">
                    <div className="flex-1 min-w-[240px]">
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Email
                      </label>
                      <Input
                        type="email"
                        placeholder="teammate@example.com"
                        value={addMemberEmail}
                        onChange={(e) => setAddMemberEmail(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && addMemberEmail.trim()) {
                            addMemberMutation.mutate(addMemberEmail.trim());
                          }
                        }}
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (addMemberEmail.trim()) {
                          addMemberMutation.mutate(addMemberEmail.trim());
                        }
                      }}
                      disabled={!addMemberEmail.trim() || addMemberMutation.isPending}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      {addMemberMutation.isPending ? "Adding..." : "Add member"}
                    </Button>
                  </div>

                  {orgMembersQuery.isLoading ? (
                    <p className="text-xs text-muted-foreground">Loading members...</p>
                  ) : (orgMembersQuery.data ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No members yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {(orgMembersQuery.data ?? []).map((member) => (
                        <div
                          key={member.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-medium truncate">
                              {member.displayName || member.email || member.userId}
                            </span>
                            {member.email && member.displayName && (
                              <span className="shrink-0 text-xs text-muted-foreground truncate max-w-[240px]">
                                {member.email}
                              </span>
                            )}
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {member.role}
                            </span>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10 h-7 text-xs px-2"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove ${member.displayName || member.email || "this member"} from ${selectedOrg.name}?`,
                                )
                              ) {
                                removeMemberMutation.mutate(member.userId);
                              }
                            }}
                            disabled={removeMemberMutation.isPending}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Companies */}
              <div className="space-y-3">
                <div className="flex items-center gap-1.5">
                  <BuildingIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Companies
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {orgCompaniesQuery.data?.length ?? 0}
                  </span>
                </div>

                <div className="rounded-md border border-border px-4 py-4 space-y-3">
                  <div className="flex items-end gap-2 flex-wrap">
                    <div className="flex-1 min-w-[240px]">
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Attach company
                      </label>
                      <select
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none"
                        value={attachCompanyId}
                        onChange={(e) => setAttachCompanyId(e.target.value)}
                      >
                        <option value="">Select a company...</option>
                        {attachableCompanies.map((company) => (
                          <option key={company.id} value={company.id}>
                            {company.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (attachCompanyId) {
                          attachCompanyMutation.mutate(attachCompanyId);
                        }
                      }}
                      disabled={!attachCompanyId || attachCompanyMutation.isPending}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      {attachCompanyMutation.isPending ? "Attaching..." : "Attach"}
                    </Button>
                  </div>

                  {orgCompaniesQuery.isLoading ? (
                    <p className="text-xs text-muted-foreground">Loading companies...</p>
                  ) : (orgCompaniesQuery.data ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No companies linked.</p>
                  ) : (
                    <div className="space-y-1">
                      {(orgCompaniesQuery.data ?? []).map((company) => (
                        <div
                          key={company.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <BuildingIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="text-sm font-medium truncate">
                              {company.name}
                            </span>
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {company.status}
                            </span>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10 h-7 text-xs px-2"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Detach "${company.name}" from ${selectedOrg.name}?`,
                                )
                              ) {
                                detachCompanyMutation.mutate(company.id);
                              }
                            }}
                            disabled={detachCompanyMutation.isPending}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Detach
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
