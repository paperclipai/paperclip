import { useState } from "react";
import { Building2, Check, Settings } from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOrg } from "@/context/OrgContext";
import { useSidebar } from "../context/SidebarContext";
import { cn } from "@/lib/utils";

interface SidebarOrgMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function orgInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

export function SidebarOrgMenu({ open: controlledOpen, onOpenChange }: SidebarOrgMenuProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { activeOrganizations, selectedOrg, setSelectedOrgId, loading } = useOrg();
  const { isMobile, setSidebarOpen } = useSidebar();
  const navigate = useNavigate();

  const label = selectedOrg?.name ?? (loading ? "…" : "Org");
  const initials = orgInitials(label);

  function handleSelect(orgId: string) {
    setSelectedOrgId(orgId);
    setOpen(false);
  }

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  function goManage() {
    closeNavigationChrome();
    navigate("/organizations");
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 shrink-0 rounded-md border border-border/60 bg-muted/30 px-0 text-[10px] font-semibold text-foreground hover:bg-muted/60"
              aria-label={selectedOrg ? `Switch organization (current: ${selectedOrg.name})` : "Select organization"}
            >
              {initials}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          <p>{selectedOrg ? `Org: ${selectedOrg.name}` : "Organizations"}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={8} className="w-64 p-1">
        <DropdownMenuLabel className="px-2 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
          Switch organization
        </DropdownMenuLabel>
        <div className="max-h-80 overflow-y-auto">
          {activeOrganizations.length === 0 ? (
            <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
          ) : (
            activeOrganizations.map((org) => {
              const isSelected = org.id === selectedOrg?.id;
              return (
                <DropdownMenuItem
                  key={org.id}
                  onSelect={() => handleSelect(org.id)}
                  className={cn(
                    "min-w-0 gap-2 py-2",
                    isSelected && "bg-accent text-accent-foreground",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                    {orgInitials(org.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{org.name}</span>
                  {isSelected ? <Check className="size-4 text-muted-foreground" /> : null}
                </DropdownMenuItem>
              );
            })
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/organizations"
            onClick={(event) => {
              event.preventDefault();
              goManage();
            }}
          >
            <Building2 className="size-4" />
            <span>Manage organizations</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            to="/instance/settings"
            onClick={closeNavigationChrome}
          >
            <Settings className="size-4" />
            <span>Instance settings</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
