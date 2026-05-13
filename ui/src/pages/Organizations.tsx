import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Building2, Plus, Trash2, Users, Building as BuildingIcon } from "lucide-react";
import { organizationsApi } from "../api/organizations";
import { companiesApi } from "../api/companies";
import { authApi } from "../api/auth";
import { useToastActions } from "../context/ToastContext";
import { useOrg } from "../context/OrgContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/router";

export function Organizations() {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const { organizations, selectedOrg, setSelectedOrgId, loading: orgsLoading } = useOrg();

  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [addMemberEmail, setAddMemberEmail] = useState("");
  const [addMemberError, setAddMemberError] = useState<string | null>(null);
  const [attachCompanyId, setAttachCompanyId] = useState("");

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = sessionQuery.data?.user?.id ?? null;

  // Page-local selection so the user can inspect an archived org without
  // leaking that selection into the rest of the app.
  const [pageSelectedOrgId, setPageSelectedOrgId] = useState<string | null>(
    selectedOrg?.id ?? null,
  );
  const effectiveSelectedId =
    pageSelectedOrgId && organizations.some((o) => o.id === pageSelectedOrgId)
      ? pageSelectedOrgId
      : (selectedOrg?.id ?? organizations[0]?.id ?? null);
  const selectedOrgId = effectiveSelectedId;
  const pageSelectedOrg = useMemo(
    () => organizations.find((o) => o.id === effectiveSelectedId) ?? null,
    [organizations, effectiveSelectedId],
  );
  const isArchived = !!pageSelectedOrg?.archivedAt;
  const isOwner = !!pageSelectedOrg && !!currentUserId && pageSelectedOrg.ownerUserId === currentUserId;

  function selectOrg(orgId: string) {
    setPageSelectedOrgId(orgId);
    setSelectedOrgId(orgId);
  }

  function invalidateOrgLists() {
    queryClient.invalidateQueries({ queryKey: queryKeys.organizations.list });
  }

  const createOrgMutation = useMutation({
    mutationFn: (name: string) => organizationsApi.create({ name }),
    onSuccess: (created) => {
      invalidateOrgLists();
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

  const { companies: allCompanies } = useCompany();

  const addMemberMutation = useMutation({
    mutationFn: (email: string) =>
      organizationsApi.addMember(selectedOrgId!, { email }),
    onMutate: () => {
      setAddMemberError(null);
    },
    onSuccess: (member) => {
      if (!selectedOrgId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.members(selectedOrgId) });
      setAddMemberEmail("");
      pushToast({
        title: "Member added",
        body: `${member.displayName || member.email || "User"} is now in this organization.`,
        tone: "success",
      });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setAddMemberError(msg);
      pushToast({
        title: "Failed to add member",
        body: msg,
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

  const updateMemberRoleMutation = useMutation({
    mutationFn: (input: { userId: string; role: "owner" | "admin" | "member" }) =>
      organizationsApi.updateMember(selectedOrgId!, input.userId, { role: input.role }),
    onSuccess: () => {
      if (!selectedOrgId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.members(selectedOrgId) });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update member role",
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

  const archiveOrgMutation = useMutation({
    mutationFn: (orgId: string) => organizationsApi.archive(orgId),
    onSuccess: () => {
      invalidateOrgLists();
      pushToast({ title: "Organization archived", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to archive organization",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const unarchiveOrgMutation = useMutation({
    mutationFn: (orgId: string) => organizationsApi.unarchive(orgId),
    onSuccess: () => {
      invalidateOrgLists();
      pushToast({ title: "Organization restored", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to unarchive organization",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const archiveCompanyMutation = useMutation({
    mutationFn: (companyId: string) => companiesApi.archive(companyId),
    onSuccess: () => {
      if (!selectedOrgId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.companies(selectedOrgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      pushToast({ title: "Company archived", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to archive company",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const attachableCompanies = useMemo(
    () =>
      allCompanies.filter(
        (company) => !company.organizationId && company.status !== "archived",
      ),
    [allCompanies],
  );

  function handleCreate() {
    const trimmed = newOrgName.trim();
    if (!trimmed) return;
    createOrgMutation.mutate(trimmed);
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Building2 className="size-4 text-muted-foreground" />
            <span className="text-base font-semibold">Organizations</span>
          </div>
          <Link to="/home" className="text-sm text-muted-foreground hover:text-foreground">
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl space-y-6 px-6 py-10">
        <div className="flex items-center gap-3">
          {organizations.length > 0 ? (
            <select
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
              value={selectedOrgId ?? ""}
              onChange={(e) => selectOrg(e.target.value)}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                  {org.archivedAt ? " (archived)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
              {orgsLoading ? "Loading..." : "No organizations yet."}
            </div>
          )}
          <Button variant="outline" onClick={() => setShowCreate((s) => !s)}>
            <Plus className="size-4" />
            New organization
          </Button>
        </div>

        {showCreate ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-3">
            <Input
              autoFocus
              type="text"
              value={newOrgName}
              placeholder="Organization name"
              onChange={(e) => setNewOrgName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") {
                  setShowCreate(false);
                  setNewOrgName("");
                }
              }}
            />
            <Button
              onClick={handleCreate}
              disabled={createOrgMutation.isPending || !newOrgName.trim()}
            >
              {createOrgMutation.isPending ? "Creating..." : "Create"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowCreate(false);
                setNewOrgName("");
              }}
            >
              Cancel
            </Button>
          </div>
        ) : null}

        {!pageSelectedOrg ? (
          <div className="rounded-lg border border-border bg-background px-6 py-10 text-center text-sm text-muted-foreground">
            Create an organization to manage members and companies.
          </div>
        ) : (
          <>
            {isArchived ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Archive className="size-4" />
                  <span>This organization is archived.</span>
                </div>
                {isOwner ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => unarchiveOrgMutation.mutate(pageSelectedOrg.id)}
                    disabled={unarchiveOrgMutation.isPending}
                  >
                    <ArchiveRestore className="size-4" />
                    {unarchiveOrgMutation.isPending ? "Restoring..." : "Restore"}
                  </Button>
                ) : null}
              </div>
            ) : isOwner ? (
              <div className="flex items-center justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Archive "${pageSelectedOrg.name}"? Companies inside will keep working — archive them individually if needed.`,
                      )
                    ) {
                      archiveOrgMutation.mutate(pageSelectedOrg.id);
                    }
                  }}
                  disabled={archiveOrgMutation.isPending}
                >
                  <Archive className="size-4" />
                  {archiveOrgMutation.isPending ? "Archiving..." : "Archive organization"}
                </Button>
              </div>
            ) : null}

            <Section
              icon={<Users className="size-4 text-muted-foreground" />}
              title="Members"
              count={orgMembersQuery.data?.length}
            >
              <p className="text-xs text-muted-foreground">
                Organization members can see this org in their switcher.
                They don't automatically get access to the companies inside —
                add them to each company from its settings.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  type="email"
                  placeholder="teammate@example.com"
                  value={addMemberEmail}
                  onChange={(e) => {
                    setAddMemberEmail(e.target.value);
                    if (addMemberError) setAddMemberError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && addMemberEmail.trim()) {
                      addMemberMutation.mutate(addMemberEmail.trim());
                    }
                  }}
                  aria-invalid={!!addMemberError}
                />
                <Button
                  onClick={() => {
                    if (addMemberEmail.trim()) {
                      addMemberMutation.mutate(addMemberEmail.trim());
                    }
                  }}
                  disabled={!addMemberEmail.trim() || addMemberMutation.isPending}
                >
                  {addMemberMutation.isPending ? "Adding..." : "Add"}
                </Button>
              </div>
              {addMemberError ? (
                <p className="text-xs text-destructive">{addMemberError}</p>
              ) : null}

              {orgMembersQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : (orgMembersQuery.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No members yet.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {(orgMembersQuery.data ?? []).map((member) => (
                    <li
                      key={member.id}
                      className="flex items-center justify-between gap-2 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {member.displayName || member.email || member.userId}
                        </span>
                        {member.email && member.displayName ? (
                          <span className="max-w-[240px] shrink-0 truncate text-xs text-muted-foreground">
                            {member.email}
                          </span>
                        ) : null}
                        {isOwner && member.userId !== pageSelectedOrg.ownerUserId ? (
                          <select
                            className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium outline-none"
                            value={member.role}
                            disabled={updateMemberRoleMutation.isPending}
                            onChange={(e) =>
                              updateMemberRoleMutation.mutate({
                                userId: member.userId,
                                role: e.target.value as "owner" | "admin" | "member",
                              })
                            }
                          >
                            <option value="member">member</option>
                            <option value="admin">admin</option>
                            <option value="owner">owner</option>
                          </select>
                        ) : (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {member.role}
                          </span>
                        )}
                      </div>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${member.displayName || member.email || "this member"} from ${pageSelectedOrg.name}?`,
                            )
                          ) {
                            removeMemberMutation.mutate(member.userId);
                          }
                        }}
                        disabled={removeMemberMutation.isPending}
                        aria-label="Remove member"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              icon={<BuildingIcon className="size-4 text-muted-foreground" />}
              title="Companies"
              count={orgCompaniesQuery.data?.length}
            >
              <div className="flex items-center gap-2">
                <select
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
                  value={attachCompanyId}
                  onChange={(e) => setAttachCompanyId(e.target.value)}
                >
                  <option value="">Attach a company...</option>
                  {attachableCompanies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
                <Button
                  onClick={() => {
                    if (attachCompanyId) {
                      attachCompanyMutation.mutate(attachCompanyId);
                    }
                  }}
                  disabled={!attachCompanyId || attachCompanyMutation.isPending}
                >
                  {attachCompanyMutation.isPending ? "Attaching..." : "Attach"}
                </Button>
              </div>

              {orgCompaniesQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : (orgCompaniesQuery.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No companies linked.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {(orgCompaniesQuery.data ?? []).map((company) => (
                    <li
                      key={company.id}
                      className="flex items-center justify-between gap-2 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{company.name}</span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {company.status}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {company.status !== "archived" ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Archive company "${company.name}"? It will be hidden from the sidebar and paused.`,
                                )
                              ) {
                                archiveCompanyMutation.mutate(company.id);
                              }
                            }}
                            disabled={archiveCompanyMutation.isPending}
                            aria-label="Archive company"
                            title="Archive company"
                          >
                            <Archive className="size-3.5" />
                          </Button>
                        ) : null}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Detach "${company.name}" from ${pageSelectedOrg.name}? The company stays but will no longer belong to this organization.`,
                              )
                            ) {
                              detachCompanyMutation.mutate(company.id);
                            }
                          }}
                          disabled={detachCompanyMutation.isPending}
                          aria-label="Detach company"
                          title="Detach from organization"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </main>
    </div>
  );
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-semibold">{title}</h2>
        {typeof count === "number" ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
