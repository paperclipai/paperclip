import { ChevronsUpDown, Plus, Settings } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

function statusDotColor(status?: string): string {
  switch (status) {
    case "active":
      return "bg-green-400";
    case "paused":
      return "bg-yellow-400";
    case "archived":
      return "bg-neutral-400";
    default:
      return "bg-green-400";
  }
}

export function CompanySwitcher() {
  const { companies, selectedCompany, parentCompany, isHolding, setSelectedCompanyId } = useCompany();
  const sidebarCompanies = companies.filter((company) => company.status !== "archived");

  // Group: holding companies (no parent) and their subsidiaries
  const holdings = sidebarCompanies.filter((c) => !c.parentCompanyId);
  const childrenOf = (parentId: string) =>
    sidebarCompanies.filter((c) => c.parentCompanyId === parentId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between px-2 py-1.5 h-auto text-left"
        >
          <div className="flex items-center gap-2 min-w-0">
            {selectedCompany && (
              <span className={`h-2 w-2 rounded-full shrink-0 ${statusDotColor(selectedCompany.status)}`} />
            )}
            <span className="text-sm font-medium truncate">
              {selectedCompany?.name ?? "Select company"}
            </span>
            {parentCompany && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                ↑ {parentCompany.name}
              </span>
            )}
            {isHolding && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                Holding
              </span>
            )}
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px]">
        {holdings.map((holding) => {
          const subs = childrenOf(holding.id);
          return (
            <div key={holding.id}>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {subs.length > 0 ? `${holding.name} (Holding)` : holding.name}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => setSelectedCompanyId(holding.id)}
                className={holding.id === selectedCompany?.id ? "bg-accent" : ""}
              >
                <span className={`h-2 w-2 rounded-full shrink-0 mr-2 ${statusDotColor(holding.status)}`} />
                <span className="truncate font-medium">{holding.name}</span>
              </DropdownMenuItem>
              {subs.map((sub) => (
                <DropdownMenuItem
                  key={sub.id}
                  onClick={() => setSelectedCompanyId(sub.id)}
                  className={sub.id === selectedCompany?.id ? "bg-accent pl-6" : "pl-6"}
                >
                  <span className={`h-2 w-2 rounded-full shrink-0 mr-2 ${statusDotColor(sub.status)}`} />
                  <span className="truncate">{sub.name}</span>
                </DropdownMenuItem>
              ))}
              {holdings.length > 1 && <DropdownMenuSeparator />}
            </div>
          );
        })}
        {sidebarCompanies.length === 0 && (
          <DropdownMenuItem disabled>No companies</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/company/settings" className="no-underline text-inherit">
            <Settings className="h-4 w-4 mr-2" />
            Company Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/companies" className="no-underline text-inherit">
            <Plus className="h-4 w-4 mr-2" />
            Manage Companies
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
