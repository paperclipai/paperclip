import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus } from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { authApi } from "@/api/auth";
import { companiesApi } from "@/api/companies";
import { organizationsApi } from "@/api/organizations";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useOrg } from "@/context/OrgContext";
import { useDialog } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import type { Company } from "@paperclipai/shared";

export function HomePage() {
  const navigate = useNavigate();
  const { openOnboarding } = useDialog();
  const { organizations, loading: orgsLoading } = useOrg();
  const { setSelectedCompanyId } = useCompany();
  const { setSelectedOrgId } = useOrg();

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const { data: companies = [], isLoading: companiesLoading } = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: () => companiesApi.list(),
  });

  const companiesByOrg = useMemo(() => {
    const map = new Map<string, Company[]>();
    const unassigned: Company[] = [];
    for (const company of companies) {
      if (company.status === "archived") continue;
      if (company.organizationId) {
        const list = map.get(company.organizationId) ?? [];
        list.push(company);
        map.set(company.organizationId, list);
      } else {
        unassigned.push(company);
      }
    }
    return { map, unassigned };
  }, [companies]);

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
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">Paperclip</span>
          </div>
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
          <div>
            <h1 className="text-2xl font-semibold">Welcome back</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a company to enter.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link to="/organizations">Manage organizations</Link>
            </Button>
            <Button onClick={() => openOnboarding()}>
              <Plus className="size-4" />
              New company
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="rounded-lg border border-border bg-background p-6 text-sm text-muted-foreground">
            Loading...
          </div>
        ) : organizations.length === 0 && companiesByOrg.unassigned.length === 0 ? (
          <EmptyState onCreate={() => openOnboarding()} />
        ) : (
          <div className="flex flex-col gap-6">
            {organizations.map((org) => {
              const orgCompanies = companiesByOrg.map.get(org.id) ?? [];
              return (
                <OrgCard
                  key={org.id}
                  name={org.name}
                  companies={orgCompanies}
                  onEnter={enterCompany}
                  onAddCompany={() => {
                    setSelectedOrgId(org.id);
                    openOnboarding();
                  }}
                />
              );
            })}
            {companiesByOrg.unassigned.length > 0 ? (
              <OrgCard
                name="Unassigned"
                hint="Companies not yet attached to an organization"
                companies={companiesByOrg.unassigned}
                onEnter={enterCompany}
              />
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

function OrgCard({
  name,
  hint,
  companies,
  onEnter,
  onAddCompany,
}: {
  name: string;
  hint?: string;
  companies: Company[];
  onEnter: (company: Company) => void;
  onAddCompany?: () => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-background">
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 className="size-4 text-muted-foreground shrink-0" />
          <h2 className="text-sm font-semibold truncate">{name}</h2>
          {hint ? <span className="text-xs text-muted-foreground truncate">{hint}</span> : null}
        </div>
        {onAddCompany ? (
          <Button variant="ghost" size="sm" onClick={onAddCompany}>
            <Plus className="size-4" />
            Add company
          </Button>
        ) : null}
      </header>
      {companies.length === 0 ? (
        <div className="px-5 py-4 text-sm text-muted-foreground">
          No companies in this organization yet.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {companies.map((company) => (
            <li key={company.id}>
              <button
                type="button"
                onClick={() => onEnter(company)}
                className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-accent/40 transition-colors"
              >
                {company.brandColor ? (
                  <span
                    className="size-5 shrink-0 rounded-sm"
                    style={{ backgroundColor: company.brandColor }}
                  />
                ) : (
                  <span className="size-5 shrink-0 rounded-sm border border-border" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{company.name}</span>
                  {company.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {company.description}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {company.issuePrefix}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-background p-10 text-center">
      <Building2 className="mx-auto size-8 text-muted-foreground" />
      <h2 className="mt-4 text-base font-semibold">Create your first company</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Set up a company to start tracking issues, projects, and agents.
      </p>
      <Button className="mt-4" onClick={onCreate}>
        <Plus className="size-4" />
        New company
      </Button>
    </div>
  );
}
