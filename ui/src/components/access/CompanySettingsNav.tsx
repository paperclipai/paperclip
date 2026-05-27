import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useLocation, useNavigate } from "@/lib/router";
import { useLocalizedCopy } from "@/i18n/ui-copy";

const items = [
  { value: "general", labelKey: "general", english: "General", korean: "일반", href: "/company/settings" },
  { value: "environments", labelKey: "environments", english: "Environments", korean: "환경", href: "/company/settings/environments" },
  { value: "cloud-upstream", labelKey: "cloudUpstream", english: "Cloud upstream", korean: "클라우드 연동", href: "/company/settings/cloud-upstream" },
  { value: "members", labelKey: "members", english: "Members", korean: "멤버", href: "/company/settings/members" },
  { value: "invites", labelKey: "invites", english: "Invites", korean: "초대", href: "/company/settings/invites" },
  { value: "secrets", labelKey: "secrets", english: "Secrets", korean: "시크릿", href: "/company/settings/secrets" },
] as const;

type CompanySettingsTab = (typeof items)[number]["value"];

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
  const location = useLocation();
  const navigate = useNavigate();
  const copy = useLocalizedCopy();
  const activeTab = getCompanySettingsTab(location.pathname);

  function handleTabChange(value: string) {
    const nextTab = items.find((item) => item.value === value);
    if (!nextTab || nextTab.value === activeTab) return;
    navigate(nextTab.href);
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <PageTabBar
        items={items.map(({ value, labelKey, english, korean }) => ({
          value,
          label: copy(`companySettings.nav.${labelKey}`, english, korean),
        }))}
        value={activeTab}
        onValueChange={handleTabChange}
        align="start"
      />
    </Tabs>
  );
}
