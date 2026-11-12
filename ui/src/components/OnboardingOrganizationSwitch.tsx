import { Check, ChevronsUpDown } from "lucide-react";
import type { Company } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

export type OnboardingSwitchCompany = Pick<Company, "id" | "name" | "issuePrefix" | "status" | "logoUrl">;

/**
 * Organizations the onboarding overlay can still send the operator to.
 *
 * An empty result means there is nowhere else to go: the first company, or a
 * list that is only the company this run is already setting up. The overlay
 * stays a gate in that case. Any other live organization is enough to show
 * the switch, including while this run is naming a new one.
 */
export function onboardingSwitchCompanies(
  companies: OnboardingSwitchCompany[],
  selectedCompanyId: string | null,
): OnboardingSwitchCompany[] {
  const open = companies.filter((company) => company.status !== "archived");
  if (!open.some((company) => company.id !== selectedCompanyId)) return [];
  return open;
}

export function OnboardingOrganizationSwitch({
  companies,
  selectedCompanyId,
  onSelect,
}: {
  companies: OnboardingSwitchCompany[];
  selectedCompanyId: string | null;
  onSelect: (company: OnboardingSwitchCompany) => void;
}) {
  const choices = onboardingSwitchCompanies(companies, selectedCompanyId);
  if (choices.length === 0) return null;
  const current = choices.find((company) => company.id === selectedCompanyId) ?? null;

  return (
    <div className="pointer-events-auto fixed top-4 left-4 z-[200] max-w-56">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-9 max-w-56 justify-start gap-2 bg-background px-2.5 shadow-xs"
            aria-label="Switch organization"
            data-testid="onboarding-organization-switch"
          >
            {current ? (
              <CompanyPatternIcon
                companyName={current.name}
                logoUrl={current.logoUrl}
                className="size-5 shrink-0 rounded-md text-(length:--text-micro)"
              />
            ) : null}
            <span className="min-w-0 truncate text-sm font-medium">
              {current?.name ?? "Organizations"}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={8} className="z-[250] w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Organizations</DropdownMenuLabel>
          {choices.map((company) => (
            <DropdownMenuItem
              key={company.id}
              onSelect={() => {
                if (company.id === selectedCompanyId) return;
                onSelect(company);
              }}
            >
              <CompanyPatternIcon
                companyName={company.name}
                logoUrl={company.logoUrl}
                className="size-5 shrink-0 rounded-md text-(length:--text-micro)"
              />
              <span className="min-w-0 flex-1 truncate">{company.name}</span>
              <span className="text-xs text-muted-foreground">{company.issuePrefix}</span>
              {company.id === selectedCompanyId ? <Check className="size-4 shrink-0" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
