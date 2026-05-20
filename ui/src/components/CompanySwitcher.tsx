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
import { useState } from "react";

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

interface CompanySwitcherProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CompanySwitcher({ open: controlledOpen, onOpenChange }: CompanySwitcherProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const { companies, selectedCompany, setSelectedCompanyId } = useCompany();
  const sidebarCompanies = companies.filter((company) => company.status !== "archived");
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
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
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel>Companies</DropdownMenuLabel>
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
