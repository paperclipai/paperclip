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
  const { companies, selectedCompany, setSelectedCompanyId } = useCompany();
  const sidebarCompanies = companies.filter((company) => company.status !== "archived");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-between rounded-[0.9rem] px-2 py-2 text-left hover:bg-accent/65"
        >
          <div className="flex items-center gap-2 min-w-0">
            {selectedCompany && (
              <span className={`h-2 w-2 rounded-full shrink-0 ${statusDotColor(selectedCompany.status)}`} />
            )}
            <span className="text-sm font-medium truncate">
              {selectedCompany?.name ?? "Select system"}
            </span>
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px] rounded-[1rem] border-border bg-popover/95 backdrop-blur">
        <DropdownMenuLabel className="section-kicker px-2 py-2 text-muted-foreground">Systems</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sidebarCompanies.map((company) => (
          <DropdownMenuItem
            key={company.id}
            onClick={() => setSelectedCompanyId(company.id)}
            className={company.id === selectedCompany?.id ? "bg-accent" : ""}
          >
            <span className={`h-2 w-2 rounded-full shrink-0 mr-2 ${statusDotColor(company.status)}`} />
            <span className="truncate">{company.name}</span>
          </DropdownMenuItem>
        ))}
        {sidebarCompanies.length === 0 && (
          <DropdownMenuItem disabled>No systems</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/company/settings" className="no-underline text-inherit">
            <Settings className="h-4 w-4 mr-2" />
            System Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/companies" className="no-underline text-inherit">
            <Plus className="h-4 w-4 mr-2" />
            Manage Systems
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
