import { PageTabBar } from "@/components/PageTabBar";
import { useI18n } from "@/context/LocaleContext";
import { Tabs } from "@/components/ui/tabs";
import { useLocation, useNavigate } from "@/lib/router";

const itemDefs = [
  { value: "general", labelKey: "companySettings.general", href: "/company/settings" },
  { value: "access", labelKey: "companySettings.access", href: "/company/settings/access" },
  { value: "invites", labelKey: "companySettings.invites", href: "/company/settings/invites" },
] as const;

type CompanySettingsTab = (typeof itemDefs)[number]["value"];

export function getCompanySettingsTab(pathname: string): CompanySettingsTab {
  if (pathname.includes("/company/settings/access")) {
    return "access";
  }

  if (pathname.includes("/company/settings/invites")) {
    return "invites";
  }

  return "general";
}

export function CompanySettingsNav() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = getCompanySettingsTab(location.pathname);
  const items = itemDefs.map((item) => ({ ...item, label: t(item.labelKey) }));

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
