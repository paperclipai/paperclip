import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { t } from "@/i18n";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { useLocation, useNavigate } from "@/lib/router";

function getItems() {
  return [
    { value: "general", label: t("components.companySettingsNav.general", { defaultValue: "General" }), href: "/company/settings" },
    {
      value: "cloud-upstream",
      label: t("components.companySettingsNav.cloudUpstream", { defaultValue: "Cloud upstream" }),
      href: "/company/settings/cloud-upstream",
    },
    { value: "members", label: t("components.companySettingsNav.members", { defaultValue: "Members" }), href: "/company/settings/members" },
    { value: "invites", label: t("components.companySettingsNav.invites", { defaultValue: "Invites" }), href: "/company/settings/invites" },
    { value: "secrets", label: t("components.companySettingsNav.secrets", { defaultValue: "Secrets" }), href: "/company/settings/secrets" },
    {
      value: "instance-profile",
      label: t("components.companySettingsNav.instanceProfile", { defaultValue: "Instance profile" }),
      href: `${INSTANCE_SETTINGS_PATH_PREFIX}/profile`,
    },
    {
      value: "instance-general",
      label: t("components.companySettingsNav.instanceGeneral", { defaultValue: "Instance general" }),
      href: `${INSTANCE_SETTINGS_PATH_PREFIX}/general`,
    },
    {
      value: "instance-environments",
      label: t("components.companySettingsNav.instanceEnvironments", { defaultValue: "Instance environments" }),
      href: `${INSTANCE_SETTINGS_PATH_PREFIX}/environments`,
    },
    {
      value: "instance-access",
      label: t("components.companySettingsNav.instanceAccess", { defaultValue: "Instance access" }),
      href: `${INSTANCE_SETTINGS_PATH_PREFIX}/access`,
    },
    {
      value: "instance-heartbeats",
      label: t("components.companySettingsNav.instanceHeartbeats", { defaultValue: "Instance heartbeats" }),
      href: `${INSTANCE_SETTINGS_PATH_PREFIX}/heartbeats`,
    },
    {
      value: "instance-experimental",
      label: t("components.companySettingsNav.instanceExperimental", { defaultValue: "Instance experimental" }),
      href: `${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`,
    },
    {
      value: "instance-plugins",
      label: t("components.companySettingsNav.instancePlugins", { defaultValue: "Instance plugins" }),
      href: `${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`,
    },
    {
      value: "instance-adapters",
      label: t("components.companySettingsNav.instanceAdapters", { defaultValue: "Instance adapters" }),
      href: `${INSTANCE_SETTINGS_PATH_PREFIX}/adapters`,
    },
  ] as const;
}

type CompanySettingsTab = ReturnType<typeof getItems>[number]["value"];

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
  const activeTab = getCompanySettingsTab(location.pathname);
  const items = getItems();

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
