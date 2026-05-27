import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useLocation, useNavigate } from "@/lib/router";
import { useTranslation } from "@/i18n";

const ITEMS_DEFINITION = [
  { value: "general", label: "General", href: "/company/settings" },
  { value: "environments", label: "Environments", href: "/company/settings/environments" },
  { value: "cloud-upstream", label: "Cloud upstream", href: "/company/settings/cloud-upstream" },
  { value: "members", label: "Members", href: "/company/settings/members" },
  { value: "invites", label: "Invites", href: "/company/settings/invites" },
  { value: "secrets", label: "Secrets", href: "/company/settings/secrets" },
] as const;

type CompanySettingsTab = (typeof ITEMS_DEFINITION)[number]["value"];

export function getCompanySettingsTab(pathname: string): CompanySettingsTab {
  if (pathname.includes("/company/settings/environments")) {
    return "environments";
  }

  if (pathname.includes("/company/settings/cloud-upstream")) {
    return "cloud-upstream";
  }

  if (pathname.includes("/company/settings/members") || pathname.includes("/company/settings/access")) {
    return "members";
  }

  if (pathname.includes("/company/settings/invites")) {
    return "invites";
  }

  if (pathname.includes("/company/settings/secrets")) {
    return "secrets";
  }

  return "general";
}

export function CompanySettingsNav() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = getCompanySettingsTab(location.pathname);

  const items = [
    { value: "general", label: t("nav.sidebar.companySettings.general"), href: "/company/settings" },
    { value: "environments", label: t("nav.sidebar.companySettings.environments"), href: "/company/settings/environments" },
    { value: "access", label: t("nav.sidebar.companySettings.access"), href: "/company/settings/access" },
    { value: "invites", label: t("nav.sidebar.companySettings.invites"), href: "/company/settings/invites" },
  ] as const;

  function handleTabChange(value: string) {
    const nextTab = items.find((item) => item.value === value);
    if (!nextTab || nextTab.value === activeTab) return;
    navigate(nextTab.href);
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <PageTabBar
        items={items.map(({ value, label }) => ({ value, label }))}
        value={activeTab}
        onValueChange={handleTabChange}
        align="start"
      />
    </Tabs>
  );
}
