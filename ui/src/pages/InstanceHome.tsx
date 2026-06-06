import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { formatCents } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Plus, ArrowRight, Users, CircleDot, Settings } from "lucide-react";

/**
 * Instance-owner home / tenant chooser.
 *
 * Post-login landing for an instance owner: instead of silently auto-redirecting
 * into the first company OR forcing the create-company wizard, this lets the owner
 * either open an existing tenant's dashboard or add a new company. It lists the
 * companies the API returns for the actor (all tenants when the actor is an
 * instance admin; otherwise their membership companies).
 *
 * GLASSHOUSE: serif masthead + mono eyebrow + Sodium primary CTA + tabular spend.
 * Card chrome matches the current (pre-token-migration) app styling for
 * consistency; the square hairline-blotter migration is a separate visual pass.
 */
export function InstanceHome() {
  const { companies, setSelectedCompanyId, loading } = useCompany();
  const { openOnboarding } = useDialogActions();
  const navigate = useNavigate();

  const { data: stats } = useQuery({
    queryKey: queryKeys.companies.stats,
    queryFn: () => companiesApi.stats(),
    enabled: companies.length > 0,
  });

  useEffect(() => {
    document.title = "ValAdrien OS — Companies";
  }, []);

  function enterCompany(companyId: string, issuePrefix: string) {
    setSelectedCompanyId(companyId);
    navigate(`/${issuePrefix}/dashboard`);
  }

  const hasCompanies = companies.length > 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      {/* Masthead */}
      <header className="mb-8">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Instance
        </p>
        <h1 className="font-serif text-3xl font-medium tracking-tight mt-1">Companies</h1>
        <p className="font-serif italic text-base text-muted-foreground mt-1">
          {loading
            ? "Loading your companies…"
            : hasCompanies
              ? `${companies.length} ${companies.length === 1 ? "company" : "companies"} — open a dashboard, or add a new tenant.`
              : "No companies yet — add your first tenant to get started."}
        </p>
        <div className="mt-4 h-px w-full bg-border" />
      </header>

      {/* Tenant list */}
      {hasCompanies && (
        <div className="grid gap-3">
          {companies.map((company) => {
            const companyStats = stats?.[company.id];
            const agentCount = companyStats?.agentCount ?? 0;
            const issueCount = companyStats?.issueCount ?? 0;
            return (
              <div
                key={company.id}
                role="button"
                tabIndex={0}
                onClick={() => enterCompany(company.id, company.issuePrefix)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    enterCompany(company.id, company.issuePrefix);
                  }
                }}
                className="group flex items-center justify-between gap-4 bg-card border border-border rounded-lg p-5 transition-colors cursor-pointer hover:border-primary/50"
              >
                <div className="min-w-0">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    {company.issuePrefix}
                  </p>
                  <h2 className="font-serif text-lg font-medium truncate mt-0.5">{company.name}</h2>
                  <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      {agentCount} {agentCount === 1 ? "agent" : "agents"}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <CircleDot className="h-3.5 w-3.5" />
                      {issueCount} {issueCount === 1 ? "issue" : "issues"}
                    </span>
                    <span className="inline-flex items-center gap-1.5 tabular-nums font-mono text-xs">
                      {formatCents(company.spentMonthlyCents)}
                      {company.budgetMonthlyCents > 0
                        ? ` / ${formatCents(company.budgetMonthlyCents)}`
                        : ""}
                    </span>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
              </div>
            );
          })}
        </div>
      )}

      {/* Add company */}
      <div className="mt-6 flex items-center gap-3">
        <Button onClick={() => openOnboarding()}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          {hasCompanies ? "Add company" : "Add your first company"}
        </Button>
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => navigate("/instance/settings/general")}
        >
          <Settings className="h-3.5 w-3.5 mr-1.5" />
          Instance settings
        </Button>
      </div>
    </div>
  );
}
