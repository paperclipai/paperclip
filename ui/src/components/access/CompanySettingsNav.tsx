import { useMemo } from "react";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useCompany } from "@/context/CompanyContext";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { useLocation, useNavigate } from "@/lib/router";
import { usePluginSlots } from "@/plugins/slots";

interface CompanySettingsPluginSlotLike {
  id: string;
  pluginKey: string;
  displayName: string;
  routePath?: string | null;
}

interface CompanySettingsNavItem {
  value: string;
  label: string;
  href: string;
  hiddenKey?: string;
  hideOnCloud?: boolean;
}

const builtInPrefixItems: readonly CompanySettingsNavItem[] = [
  { value: "general", label: "General", href: "/company/settings" },
  { value: "instance-profile", label: "Profile", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/profile`, hiddenKey: "instance.profile" },
  { value: "members", label: "Members", href: "/company/settings/members", hiddenKey: "company.members" },
];

const builtInSuffixItems: readonly CompanySettingsNavItem[] = [
  { value: "secrets", label: "Secrets", href: "/company/settings/secrets", hiddenKey: "company.secrets" },
  { value: "instance-environments", label: "Environments", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/environments`, hiddenKey: "instance.environments" },
  { value: "connections", label: "Connections", href: "/company/settings/connections" },
  { value: "instance-access", label: "Access", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/access`, hiddenKey: "instance.access" },
  { value: "export", label: "Export", href: "/company/export", hiddenKey: "company.export" },
  { value: "import", label: "Import", href: "/company/import", hiddenKey: "company.import", hideOnCloud: true },
  { value: "instance-experimental", label: "Experimental", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`, hiddenKey: "instance.experimental" },
  { value: "instance-plugins", label: "System plugins", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`, hiddenKey: "instance.plugins" },
  { value: "instance-adapters", label: "Adapters", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/adapters`, hiddenKey: "instance.adapters" },
];

export type CompanySettingsTab =
  | "general"
  | "export"
  | "import"
  | "members"
  | "secrets"
  | "instance-profile"
  | "instance-environments"
  | "connections"
  | "instance-access"
  | "instance-experimental"
  | "instance-plugins"
  | "instance-adapters"
  | `plugin:${string}:${string}`;

function normalizePluginRoutePath(routePath: string | null | undefined): string {
  return routePath?.replace(/^\/+|\/+$/g, "") ?? "";
}

export function getCompanySettingsTab(
  pathname: string,
  pluginSlots?: readonly CompanySettingsPluginSlotLike[],
): CompanySettingsTab {
  if (pathname.includes("/company/settings/connections")) {
    return "connections";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/profile`)) {
    return "instance-profile";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/environments`)) {
    return "instance-environments";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/access`)) {
    return "instance-access";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`)) {
    return "instance-experimental";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`)) {
    return "instance-plugins";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/adapters`)) {
    return "instance-adapters";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/general`)) {
    return "general";
  }

  if (pathname.includes("/company/settings/environments")) {
    return "instance-environments";
  }

  if (pathname.includes("/company/export")) {
    return "export";
  }

  if (pathname.includes("/company/import")) {
    return "import";
  }

  if (pathname.includes("/company/settings/members") || pathname.includes("/company/settings/access")) {
    return "members";
  }

  if (pathname.includes("/company/settings/invites")) {
    // Invites live on the Members page now; the old URL redirects there.
    return "members";
  }

  if (pathname.includes("/company/settings/secrets")) {
    return "secrets";
  }

  if (pluginSlots && pluginSlots.length > 0) {
    const normalizedPath = pathname.replace(/\/+$/, "");
    for (const slot of pluginSlots) {
      const routePath = normalizePluginRoutePath(slot.routePath);
      if (!routePath) continue;
      const suffix = `/company/settings/${routePath}`;
      if (normalizedPath.endsWith(suffix) || normalizedPath.includes(`${suffix}/`)) {
        return `plugin:${slot.pluginKey}:${slot.id}`;
      }
    }
  }

  return "general";
}

export function CompanySettingsNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { hidden: hiddenSettings } = useHiddenSettings();
  // Import is floored server-side on cloud-managed instances (403 cloud_managed), so the
  // tab is suppressed there rather than dead-ending.
  const isCloud = Boolean(useCloudInstance());
  const { slots: companySettingsPluginSlots } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  const visibleItems = useMemo<CompanySettingsNavItem[]>(() => {
    const pluginItems: CompanySettingsNavItem[] = companySettingsPluginSlots
      .filter((slot) => Boolean(normalizePluginRoutePath(slot.routePath)))
      .map((slot) => {
        const routePath = normalizePluginRoutePath(slot.routePath);
        return {
          value: `plugin:${slot.pluginKey}:${slot.id}`,
          label: slot.displayName,
          href: `/company/settings/${routePath}`,
        };
      });

    return [...builtInPrefixItems, ...pluginItems, ...builtInSuffixItems].filter((item) => {
      if (item.hideOnCloud && isCloud) return false;
      return !item.hiddenKey || !hiddenSettings.has(item.hiddenKey);
    });
  }, [companySettingsPluginSlots, hiddenSettings, isCloud]);

  const activeTab = getCompanySettingsTab(location.pathname, companySettingsPluginSlots);

  function handleTabChange(value: string) {
    const nextTab = visibleItems.find((item) => item.value === value);
    if (!nextTab || nextTab.value === activeTab) return;
    navigate(nextTab.href);
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <PageTabBar
        items={visibleItems.map(({ value, label }) => ({ value, label }))}
        value={activeTab}
        onValueChange={handleTabChange}
        align="start"
      />
    </Tabs>
  );
}
