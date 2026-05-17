import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useExperimentalFeaturesAccess } from "@/hooks/useExperimentalFeaturesAccess";
import { useLocation, useNavigate } from "@/lib/router";

const items = [
  { value: "general", label: "General", href: "/company/settings" },
  { value: "experimental-features", label: "Experimental", href: "/company/settings/experimental-features" },
  { value: "environments", label: "Environments", href: "/company/settings/environments" },
  { value: "access", label: "Access", href: "/company/settings/access" },
  { value: "invites", label: "Invites", href: "/company/settings/invites" },
] as const;

type CompanySettingsTab = (typeof items)[number]["value"];

export function getCompanySettingsTab(pathname: string): CompanySettingsTab {
  if (pathname.includes("/company/settings/experimental-features")) {
    return "experimental-features";
  }

  if (pathname.includes("/company/settings/environments")) {
    return "environments";
  }

  if (pathname.includes("/company/settings/access")) {
    return "access";
  }

  if (pathname.includes("/company/settings/invites")) {
    return "invites";
  }

  return "general";
}

export function CompanySettingsNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { canViewExperimentalFeatures } = useExperimentalFeaturesAccess();
  const visibleItems = canViewExperimentalFeatures
    ? items
    : items.filter((item) => item.value !== "experimental-features");
  const activeTab = getCompanySettingsTab(location.pathname);

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
