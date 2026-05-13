import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus, Settings2 } from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useOrg } from "@/context/OrgContext";
import { useDialog } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import type { Company } from "@paperclipai/shared";

export function HomePage() {
  const navigate = useNavigate();
  const { openOnboarding } = useDialog();
  const { organizations, selectedOrg, setSelectedOrgId, loading: orgsLoading } = useOrg();
  const { companies, loading: companiesLoading, setSelectedCompanyId } = useCompany();

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const { orgCompanies, unassigned } = useMemo(() => {
    const inOrg: Company[] = [];
    const loose: Company[] = [];
    for (const company of companies) {
      if (company.status === "archived") continue;
      if (selectedOrg && company.organizationId === selectedOrg.id) {
        inOrg.push(company);
      } else if (!company.organizationId) {
        loose.push(company);
      }
    }
    return { orgCompanies: inOrg, unassigned: loose };
  }, [companies, selectedOrg]);

  function enterCompany(company: Company) {
    if (company.organizationId) setSelectedOrgId(company.organizationId);
    setSelectedCompanyId(company.id, { source: "manual" });
    navigate(`/${company.issuePrefix}/dashboard`);
  }

  const userName = session?.user?.name ?? session?.user?.email ?? "there";
  const loading = orgsLoading || companiesLoading;

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-base font-semibold">Paperclip</span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{userName}</span>
            <Link
              to="/instance/settings/profile"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Account
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Welcome back</h1>
            <div className="mt-2 flex items-center gap-2">
              <Building2 className="size-4 text-muted-foreground" />
              {organizations.length > 0 ? (
                <select
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm outline-none"
                  value={selectedOrg?.id ?? ""}
                  onChange={(e) => setSelectedOrgId(e.target.value)}
                >
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                      {org.archivedAt ? " (archived)" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-muted-foreground">No organization selected</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" asChild>
              <Link to="/organizations">
                <Settings2 className="size-4" />
                Manage
              </Link>
            </Button>
            <Button
              onClick={() => {
                if (selectedOrg) setSelectedOrgId(selectedOrg.id);
                openOnboarding();
              }}
            >
              <Plus className="size-4" />
              New company
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="rounded-lg border border-border bg-background p-6 text-sm text-muted-foreground">
            Loading...
          </div>
        ) : !selectedOrg ? (
          <EmptyState
            title="Create your first organization"
            message="Organizations group companies together. Create one to get started."
            actionLabel="Manage organizations"
            onAction={() => navigate("/organizations")}
          />
        ) : orgCompanies.length === 0 ? (
          <EmptyState
            title={`No companies in ${selectedOrg.name} yet`}
            message="Add a company to start tracking issues, projects, and agents."
            actionLabel="New company"
            onAction={() => openOnboarding()}
          />
        ) : (
          <CompanyGrid companies={orgCompanies} onEnter={enterCompany} />
        )}

        {unassigned.length > 0 ? (
          <section className="mt-10">
            <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
              Not attached to any organization
            </h2>
            <CompanyGrid companies={unassigned} onEnter={enterCompany} />
          </section>
        ) : null}
      </main>
    </div>
  );
}

function CompanyGrid({
  companies,
  onEnter,
}: {
  companies: Company[];
  onEnter: (company: Company) => void;
}) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {companies.map((company) => (
        <li key={company.id}>
          <button
            type="button"
            onClick={() => onEnter(company)}
            className="group flex w-full items-center gap-3 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
          >
            {company.brandColor ? (
              <span
                className="size-8 shrink-0 rounded-md"
                style={{ backgroundColor: company.brandColor }}
              />
            ) : (
              <span className="size-8 shrink-0 rounded-md border border-border" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{company.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {company.issuePrefix}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-10 text-center">
      <Building2 className="mx-auto size-8 text-muted-foreground" />
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button className="mt-4" onClick={onAction}>
        <Plus className="size-4" />
        {actionLabel}
      </Button>
    </div>
  );
}
