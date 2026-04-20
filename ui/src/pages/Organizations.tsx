import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Trash2, Users, Building as BuildingIcon } from "lucide-react";
import { organizationsApi } from "../api/organizations";
import { companiesApi } from "../api/companies";
import { useToastActions } from "../context/ToastContext";
import { useOrg } from "../context/OrgContext";
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
  const [attachCompanyId, setAttachCompanyId] = useState("");

  const selectedOrgId = selectedOrg?.id ?? null;

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

  const attachableCompanies = useMemo(
    () =>
      (allCompaniesQuery.data ?? []).filter(
        (company) => !company.organizationId && company.status !== "archived",
      ),
    [allCompaniesQuery.data],
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
              onChange={(e) => setSelectedOrgId(e.target.value)}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
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

        {!selectedOrg ? (
          <div className="rounded-lg border border-border bg-background px-6 py-10 text-center text-sm text-muted-foreground">
            Create an organization to manage members and companies.
          </div>
        ) : (
          <>
            <Section
              icon={<Users className="size-4 text-muted-foreground" />}
              title="Members"
              count={orgMembersQuery.data?.length}
            >
              <div className="flex items-center gap-2">
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
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {member.role}
                        </span>
                      </div>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
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
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
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
                        aria-label="Detach company"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
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
