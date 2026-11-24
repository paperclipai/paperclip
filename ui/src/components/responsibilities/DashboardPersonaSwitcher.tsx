import { useMemo } from "react";
import { Users } from "lucide-react";
import { deriveInitials } from "@/components/Identity";
import { useCompany } from "@/context/CompanyContext";
import { dashboardDemoPersonas, parseDashboardDemoPersona } from "@/lib/dashboard-demo-personas";
import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * Design exploration only, not a product feature: "whose dashboard". A toggle
 * between the demo organizations seeded by `scripts/seed-persona-dashboards.mjs`
 * (one per person) so their Dashboards can be compared with one click. Every
 * person is visible at once, each with their initials, so it reads as a choice
 * of person and not as the layout switch on the other side of the header. It
 * goes the way the sidebar's organization menu does: select the organization,
 * then open its Dashboard. The layout choice is stored per browser, so it
 * carries over. Shows only when at least two organizations carry the demo marker.
 */
export function DashboardPersonaSwitcher() {
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const personas = useMemo(() => dashboardDemoPersonas(companies ?? []), [companies]);
  if (personas.length < 2) return null;
  const current = personas.find((persona) => persona.companyId === selectedCompanyId) ?? null;

  const choose = (companyId: string) => {
    const persona = personas.find((candidate) => candidate.companyId === companyId);
    if (!persona || persona.companyId === selectedCompanyId) return;
    setSelectedCompanyId(persona.companyId);
    navigate(`/${persona.issuePrefix}/responsibilities`);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-dashboard-persona-switcher="">
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Users aria-hidden="true" className="size-3.5" />
        Whose dashboard
      </span>
      <div
        role="radiogroup"
        aria-label="Whose dashboard"
        className="inline-flex items-center gap-0.5 rounded-full border border-border p-0.5"
      >
        {personas.map((persona) => {
          const checked = persona.companyId === current?.companyId;
          return (
            <button
              key={persona.companyId}
              type="button"
              role="radio"
              aria-checked={checked}
              title={persona.role ?? undefined}
              onClick={() => choose(persona.companyId)}
              className={cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-0.5 pr-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                checked && "bg-accent text-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-5 items-center justify-center rounded-full bg-muted text-xs",
                  checked && "bg-foreground text-background",
                )}
              >
                {deriveInitials(persona.name).slice(0, 1)}
              </span>
              {persona.name}
              {persona.role ? <span className="sr-only">, {persona.role}</span> : null}
            </button>
          );
        })}
      </div>
      {current?.role ? <span className="text-xs text-muted-foreground">{current.role}</span> : null}
    </div>
  );
}

/** The demo person the selected organization stands for, for the Outline's person header; null outside the comparison. */
export function useDashboardDemoPerson() {
  const { selectedCompany } = useCompany();
  return useMemo(() => parseDashboardDemoPersona(selectedCompany?.description), [selectedCompany?.description]);
}
