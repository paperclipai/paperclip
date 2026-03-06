import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, Pause, Play, Plus, Settings } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
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
  const queryClient = useQueryClient();
  const sidebarCompanies = companies.filter((company) => company.status !== "archived");
  const selectedCompanyId = selectedCompany?.id ?? null;

  const statusMutation = useMutation({
    mutationFn: ({ companyId, action }: { companyId: string; action: "pause" | "resume" }) =>
      action === "pause" ? companiesApi.pause(companyId) : companiesApi.resume(companyId),
    onSuccess: async (_updatedCompany, vars) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(vars.companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(vars.companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(vars.companyId) });
    },
  });

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
        {selectedCompany && selectedCompany.status === "active" && (
          <DropdownMenuItem
            disabled={statusMutation.isPending || !selectedCompanyId}
            onClick={() => {
              if (!selectedCompanyId) return;
              const confirmed = window.confirm(
                `Pause all agent heartbeats for "${selectedCompany.name}"? Active runs will be cancelled.`,
              );
              if (!confirmed) return;
              statusMutation.mutate({ companyId: selectedCompanyId, action: "pause" });
            }}
          >
            <Pause className="h-4 w-4 mr-2" />
            {statusMutation.isPending ? "Pausing..." : "Pause Heartbeats"}
          </DropdownMenuItem>
        )}
        {selectedCompany && selectedCompany.status === "paused" && (
          <DropdownMenuItem
            disabled={statusMutation.isPending || !selectedCompanyId}
            onClick={() => {
              if (!selectedCompanyId) return;
              statusMutation.mutate({ companyId: selectedCompanyId, action: "resume" });
            }}
          >
            <Play className="h-4 w-4 mr-2" />
            {statusMutation.isPending ? "Resuming..." : "Resume Heartbeats"}
          </DropdownMenuItem>
        )}
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
