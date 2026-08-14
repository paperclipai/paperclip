import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { useLocation, useNavigate } from "@/lib/router";
import { t } from "@/i18n";

const items = [
  { value: "general", label: t("companySettingsNav.general"), href: "/company/settings" },
  { value: "export", label: t("companySettingsNav.export"), href: "/company/export" },
  { value: "import", label: t("companySettingsNav.import"), href: "/company/import" },
  { value: "members", label: t("companySettingsNav.members"), href: "/company/settings/members" },
  { value: "invites", label: t("companySettingsNav.invites"), href: "/company/settings/invites" },
  { value: "secrets", label: t("companySettingsNav.secrets"), href: "/company/settings/secrets" },
  { value: "instance-profile", label: t("companySettingsNavTabs.instanceProfile"), href: `${INSTANCE_SETTINGS_PATH_PREFIX}/profile` },
  { value: "instance-general", label: t("companySettingsNavTabs.instanceGeneral"), href: `${INSTANCE_SETTINGS_PATH_PREFIX}/general` },
  { value: "instance-environments", label: t("companySettingsNavTabs.instanceEnvironments"), href: `${INSTANCE_SETTINGS_PATH_PREFIX}/environments` },
  { value: "instance-access", label: t("companySettingsNavTabs.instanceAccess"), href: `${INSTANCE_SETTINGS_PATH_PREFIX}/access` },
  { value: "instance-heartbeats", label: t("companySettingsNavTabs.instanceHeartbeats"), href: `${INSTANCE_SETTINGS_PATH_PREFIX}/heartbeats` },
  { value: "instance-experimental", label: t("companySettingsNavTabs.instanceExperimental"), href: `${INSTANCE_SETTINGS_PATH_PREFIX}/experimental` },
  { value: "instance-plugins", label: t("companySettingsNavTabs.instancePlugins"), href: `${INSTANCE_SETTINGS_PATH_PREFIX}/plugins` },
  { value: "instance-adapters", label: t("companySettingsNavTabs.instanceAdapters"), href: `${INSTANCE_SETTINGS_PATH_PREFIX}/adapters` },
] as const;

type CompanySettingsTab = (typeof items)[number]["value"];

export function getCompanySettingsTab(pathname: string): CompanySettingsTab {
  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/profile`)) {
    return "instance-profile";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/access`)) {
    return "instance-access";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/environments`)) {
    return "instance-environments";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/heartbeats`)) {
    return "instance-heartbeats";
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
    return "instance-general";
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
  const activeTab = getCompanySettingsTab(location.pathname);

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
