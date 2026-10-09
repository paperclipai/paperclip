import { useState, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { PluginOrganizationSwitcherProps } from "@paperclipai/plugin-sdk/ui";
import { useAccountIdentity, useCompanyListQuery } from "@/api/companies-query";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useSignOut } from "@/hooks/useSignOut";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { CompanyPatternIcon } from "./CompanyPatternIcon";
import { Skeleton } from "./ui/skeleton";

/** Reserve the trigger's space until its owner is known. Never flash another name. */
function OrganizationSwitcherLoading({ collapsed }: { collapsed: boolean }) {
  return <div role="status" aria-label="Loading organization" aria-busy="true"
    className="flex h-9 min-w-0 flex-1 items-center gap-2 px-4">
    <Skeleton className="size-5 shrink-0" />
    {!collapsed && <>
      <span className="min-w-0 flex-1"><Skeleton className="h-4 w-20 max-w-full" /></span>
      <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </>}
  </div>;
}

/** Optional replacement; use the built-in menu when discovery or rendering fails. */
export function PluginOrganizationSwitcher({ children, open: controlledOpen, onOpenChange }: {
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { userId, settled, failed } = useAccountIdentity();
  const { selectedCompanyId } = useCompany();
  const companyList = useCompanyListQuery();
  // Selection is component state and can outlive its account until an effect
  // clears it. Resolve it against this account's query before mounting plugins.
  const selectedCompany = companyList.data?.companies.find(company => company.id === selectedCompanyId) ?? null;
  const contextSettled = settled && companyList.isSuccess && !companyList.data?.unauthorized
    && (selectedCompanyId === null || selectedCompany !== null);
  const contextLoading = !contextSettled && !failed && !companyList.isError && !companyList.data?.unauthorized;
  return (
    <OrganizationSwitcher key={JSON.stringify([userId, selectedCompanyId])}
      settled={contextSettled} loading={contextLoading} companyId={selectedCompanyId}
      company={selectedCompany} open={controlledOpen} onOpenChange={onOpenChange}>
      {children}
    </OrganizationSwitcher>
  );
}

function OrganizationSwitcher({ children, settled, loading, companyId, company, open: controlledOpen, onOpenChange }: {
  children: ReactNode; settled: boolean; loading: boolean; companyId: string | null;
  company: { name: string; issuePrefix: string; logoUrl?: string | null } | null;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  function closeNavigation() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }
  const signOut = useSignOut({ onSignedOut: closeNavigation });
  const { slots, isLoading, errorMessage } = usePluginSlots({ slotTypes: ["organizationSwitcher"], companyId, enabled: settled });
  if (loading || (settled && isLoading && !errorMessage)) {
    return <OrganizationSwitcherLoading collapsed={collapsed && !peeking} />;
  }
  // Never choose an arbitrary winner for a replacement surface.
  if (!settled || errorMessage || slots.length !== 1) return children;
  const props: PluginOrganizationSwitcherProps = {
    organizationSwitcher: {
      currentCompany: company ? { name: company.name, logoUrl: company.logoUrl ?? null } : null,
      collapsed: collapsed && !peeking, open, onOpenChange: setOpen,
      onNavigate: closeNavigation, onSignOut: () => signOut.mutate(), signingOut: signOut.isPending,
      renderIcon: (name, logoUrl, inMenu) => <CompanyPatternIcon companyName={name} logoUrl={logoUrl}
        className={inMenu
          ? "size-(--organization-popover-avatar-size) shrink-0 rounded-lg text-(length:--text-micro)"
          : "size-5 shrink-0 rounded-md text-(length:--text-micro)"} />,
    },
  };
  return <PluginSlotMount slot={slots[0]!}
    context={{ companyId, companyPrefix: company?.issuePrefix ?? null }}
    componentProps={{ ...props }} fallback={children} />;
}
