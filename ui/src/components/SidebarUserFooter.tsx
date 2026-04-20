import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Check,
  ChevronDown,
  Home,
  LogOut,
  Settings,
  UserPlus,
} from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { authApi } from "@/api/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCompany } from "@/context/CompanyContext";
import { useOrg } from "@/context/OrgContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";

export function SidebarUserFooter() {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border px-3 py-2 shrink-0">
      <OrgSwitcher />
      <CompanySwitcher />
      <UserChip />
    </div>
  );
}

function OrgSwitcher() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { organizations, selectedOrg, setSelectedOrgId, loading } = useOrg();
  const { isMobile, setSidebarOpen } = useSidebar();

  function handleSelect(orgId: string) {
    setSelectedOrgId(orgId);
    setOpen(false);
  }

  function handleManage() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    navigate("/organizations");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-start gap-1.5 px-2 text-xs text-muted-foreground"
          aria-label={selectedOrg ? `Switch organization (current: ${selectedOrg.name})` : "Select organization"}
          disabled={loading && organizations.length === 0}
        >
          <Building2 className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedOrg?.name ?? (loading ? "Loading..." : "Select organization")}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search organizations..." />
          <CommandList>
            <CommandEmpty>No organizations found.</CommandEmpty>
            {organizations.length > 0 ? (
              <CommandGroup heading="Organizations">
                {organizations.map((org) => (
                  <CommandItem
                    key={org.id}
                    value={org.name}
                    onSelect={() => handleSelect(org.id)}
                  >
                    <Building2 className="size-4 text-muted-foreground" />
                    <span className="truncate">{org.name}</span>
                    {selectedOrg?.id === org.id ? (
                      <Check className="ml-auto size-4" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__manage" onSelect={handleManage}>
                <Settings className="size-4 text-muted-foreground" />
                <span>Manage organizations</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CompanySwitcher() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const navigate = useNavigate();
  const { selectedCompany, companiesInOrg, setSelectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();

  function handleSwitch(companyId: string) {
    setSelectedCompanyId(companyId);
    setSwitcherOpen(false);
  }

  function closeActions() {
    setMenuOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  const switchableCompanies = companiesInOrg.filter((c) => c.status !== "archived");

  return (
    <div className="flex items-center gap-1">
      <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto min-w-0 flex-1 justify-start gap-1 px-2 py-1.5 text-left"
            aria-label={selectedCompany ? `Switch company (current: ${selectedCompany.name})` : "Select company"}
            disabled={!selectedCompany && switchableCompanies.length === 0}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {selectedCompany?.brandColor ? (
                <span
                  className="size-4 shrink-0 rounded-sm"
                  style={{ backgroundColor: selectedCompany.brandColor }}
                />
              ) : null}
              <span className="truncate text-sm font-semibold text-foreground">
                {selectedCompany?.name ?? "Select company"}
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Search companies..." />
            <CommandList>
              <CommandEmpty>No companies in this organization.</CommandEmpty>
              {switchableCompanies.length > 0 ? (
                <CommandGroup heading="Companies">
                  {switchableCompanies.map((company) => (
                    <CommandItem
                      key={company.id}
                      value={company.name}
                      onSelect={() => handleSwitch(company.id)}
                    >
                      {company.brandColor ? (
                        <span
                          className="size-4 shrink-0 rounded-sm"
                          style={{ backgroundColor: company.brandColor }}
                        />
                      ) : (
                        <span className="size-4 shrink-0 rounded-sm border border-border" />
                      )}
                      <span className="truncate">{company.name}</span>
                      {selectedCompany?.id === company.id ? (
                        <Check className="ml-auto size-4" />
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  value="__manage-companies"
                  onSelect={() => {
                    setSwitcherOpen(false);
                    if (isMobile) setSidebarOpen(false);
                    navigate("/companies");
                  }}
                >
                  <Settings className="size-4 text-muted-foreground" />
                  <span>Manage companies</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            aria-label="Company actions"
            disabled={!selectedCompany}
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-64">
          <DropdownMenuItem asChild>
            <Link to="/company/settings/invites" onClick={closeActions}>
              <UserPlus className="size-4" />
              <span className="truncate">
                {selectedCompany ? `Invite people to ${selectedCompany.name}` : "Invite people"}
              </span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/company/settings" onClick={closeActions}>
              <Settings className="size-4" />
              <span>Company settings</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function UserChip() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { isMobile, setSidebarOpen } = useSidebar();

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

  function closeAndClosePanel() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  const user = session?.user ?? null;
  const displayName = user?.name ?? user?.email ?? "Guest";
  const initials =
    (user?.name ?? user?.email ?? "?")
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
          aria-label="User menu"
        >
          <Avatar className="size-6">
            {user?.image ? <AvatarImage src={user.image} alt={displayName} /> : null}
            <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
            {displayName}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        {user?.email ? (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              <span className="block truncate">{user.name ?? "Signed in"}</span>
              <span className="block truncate text-[11px]">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem asChild>
          <Link to="/home" onClick={closeAndClosePanel}>
            <Home className="size-4" />
            <span>Home</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/instance/settings/profile" onClick={closeAndClosePanel}>
            <Settings className="size-4" />
            <span>Account settings</span>
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
