import { ChevronsUpDown, Plus, Settings, Pause, Play } from "lucide-react";
import { Link } from "@/lib/router";
import { useBulkCompanyAgentMutations } from "../hooks/useBulkCompanyAgentMutations";
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

function CompanyRow({
  company,
  isSelected,
  onSelect,
}: {
  company: { id: string; name: string; status?: string };
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { bulkPause, bulkResume } = useBulkCompanyAgentMutations(company.id);
  const busy = bulkPause.isPending || bulkResume.isPending;
  return (
    <div
      className={`flex items-center gap-1 px-2 py-1.5 rounded-sm text-sm cursor-pointer hover:bg-accent group ${isSelected ? "bg-accent" : ""}`}
      onClick={onSelect}
    >
      <span className={`h-2 w-2 rounded-full shrink-0 mr-1 ${statusDotColor(company.status)}`} />
      <span className="truncate flex-1">{company.name}</span>
      <button
        type="button"
        className="opacity-0 group-hover:opacity-100 flex items-center justify-center h-4 w-4 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-opacity"
        title="Pause all agents"
        onClick={(e) => { e.stopPropagation(); bulkPause.mutate(); }}
        disabled={busy}
      >
        <Pause className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        className="opacity-0 group-hover:opacity-100 flex items-center justify-center h-4 w-4 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-opacity"
        title="Resume all agents"
        onClick={(e) => { e.stopPropagation(); bulkResume.mutate(); }}
        disabled={busy}
      >
        <Play className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

export function CompanySwitcher() {
  const { companies, selectedCompany, setSelectedCompanyId } = useCompany();
  const sidebarCompanies = companies.filter((company) => company.status !== "archived");

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
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel>Companies</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sidebarCompanies.map((company) => (
          <CompanyRow
            key={company.id}
            company={company}
            isSelected={company.id === selectedCompany?.id}
            onSelect={() => setSelectedCompanyId(company.id)}
          />
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
