import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, LogOut, Plus, Settings, UserPlus } from "lucide-react";
import type { Company } from "@paperclipai/shared";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

interface SidebarCompanyMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function WorkspaceIcon({ company }: { company: Company }) {
  return (
    <CompanyPatternIcon
      companyName={company.name}
      logoUrl={company.logoUrl}
      brandColor={company.brandColor}
      className="size-5 shrink-0 rounded-md text-[11px]"
    />
  );
}

export function SidebarCompanyMenu({ open: controlledOpen, onOpenChange }: SidebarCompanyMenuProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { companies, selectedCompany, setSelectedCompanyId } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const sidebarCompanies = companies.filter((company) => company.status !== "archived");
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      if (isMobile) setSidebarOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  function selectCompany(company: Company) {
    const pathPrefix = location.pathname.split("/")[1]?.toUpperCase();
    const isCompanyRoute = sidebarCompanies.some((sidebarCompany) => (
      sidebarCompany.issuePrefix.toUpperCase() === pathPrefix
    ));
    const shouldLeaveCurrentRoute = company.id !== selectedCompany?.id
      && (location.pathname.startsWith("/instance/") || isCompanyRoute);

    setSelectedCompanyId(company.id);
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    if (shouldLeaveCurrentRoute) {
      navigate(`/${company.issuePrefix}/dashboard`);
    }
  }

  function addCompany() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    openOnboarding();
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-9 flex-1 justify-start gap-2 px-2 text-left"
          aria-label={selectedCompany ? `Open ${selectedCompany.name} workspace switcher` : "Open workspace switcher"}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selectedCompany ? <WorkspaceIcon company={selectedCompany} /> : null}
            <span className="truncate text-sm font-bold text-foreground">
              {selectedCompany?.name ?? "Select workspace"}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-64 p-1">
        <DropdownMenuLabel className="px-2 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
          Switch workspace
        </DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {sidebarCompanies.map((company) => {
            const isSelected = company.id === selectedCompany?.id;
            return (
              <DropdownMenuItem
                key={company.id}
                onClick={() => selectCompany(company)}
                className={cn(
                  "min-w-0 gap-2 py-2",
                  isSelected && "bg-accent text-accent-foreground",
                )}
              >
                <WorkspaceIcon company={company} />
                <span className="min-w-0 flex-1 truncate">{company.name}</span>
                {isSelected ? <Check className="size-4 text-muted-foreground" /> : null}
              </DropdownMenuItem>
            );
          })}
          {sidebarCompanies.length === 0 ? (
            <DropdownMenuItem disabled>No workspaces</DropdownMenuItem>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={addCompany} className="gap-2 py-2 text-muted-foreground">
          <Plus className="size-4" />
          <span>Add company...</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/company/settings/invites" onClick={closeNavigationChrome}>
            <UserPlus className="size-4" />
            <span className="truncate">
              {selectedCompany ? `Invite people to ${selectedCompany.name}` : "Invite people"}
            </span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/company/settings" onClick={closeNavigationChrome}>
            <Settings className="size-4" />
            <span>Company settings</span>
          </Link>
        </DropdownMenuItem>
        {session?.session ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => signOutMutation.mutate()}
              disabled={signOutMutation.isPending}
            >
              <LogOut className="size-4" />
              <span>{signOutMutation.isPending ? "Signing out..." : "Sign out"}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
