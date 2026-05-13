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
    <div className="min-h-screen" style={{ background: "linear-gradient(160deg, #fdf4ef 0%, #f0f4ff 50%, #f5f0ff 100%)" }}>
      <header className="border-b border-border/40 bg-white/60 backdrop-blur-md sticky top-0 z-10">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-base font-semibold tracking-tight">Paperclip</span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{userName}</span>
            <Link
              to="/instance/settings/profile"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Account
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-10 space-y-8">
        {/* Hero card — peach-to-lavender gradient */}
        <div
          className="rounded-3xl px-8 py-10 shadow-md"
          style={{ background: "linear-gradient(135deg, #fde8d8 0%, #fce4f0 55%, #e8e4fc 100%)" }}
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-rose-400/80 mb-2">
            {new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening"}
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-6">
            Welcome back, {userName.split(" ")[0]}
          </h1>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Building2 className="size-4 text-muted-foreground/70" />
              {organizations.length > 0 ? (
                <select
                  className="rounded-xl border border-white/60 bg-white/70 backdrop-blur-sm px-3 py-1.5 text-sm outline-none shadow-sm"
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
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" className="rounded-xl bg-white/60 backdrop-blur-sm border-white/70 shadow-sm" asChild>
                <Link to="/organizations">
                  <Settings2 className="size-4" />
                  Manage
                </Link>
              </Button>
              <Button
                size="sm"
                className="rounded-xl shadow-sm"
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
        </div>

        {loading ? (
          <div className="rounded-2xl border border-border/50 bg-white/60 backdrop-blur-sm shadow-sm p-8 text-sm text-muted-foreground">
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
          <section>
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground/70 px-1">
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
            className="group flex w-full items-center gap-4 rounded-2xl border border-border/50 bg-white/70 backdrop-blur-sm p-5 text-left shadow-sm transition-all hover:shadow-md hover:border-border/80 hover:bg-white/80 active:scale-[0.98]"
          >
            {company.brandColor ? (
              <span
                className="size-10 shrink-0 rounded-xl shadow-sm"
                style={{ backgroundColor: company.brandColor }}
              />
            ) : (
              <span className="size-10 shrink-0 rounded-xl border border-border/60 bg-muted/30" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{company.name}</span>
              <span className="block truncate text-xs text-muted-foreground mt-0.5">
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
    <div className="rounded-2xl border border-border/50 bg-white/60 backdrop-blur-sm shadow-sm p-12 text-center">
      <Building2 className="mx-auto size-10 text-muted-foreground/50" />
      <h2 className="mt-5 text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">{message}</p>
      <Button className="mt-6 rounded-xl" onClick={onAction}>
        <Plus className="size-4" />
        {actionLabel}
      </Button>
    </div>
  );
}
