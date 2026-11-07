import { useTranslation, t } from "@/i18n";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { useLocation, useNavigate } from "@/lib/router";

const items = [
  { value: "general", get label() { return t("agent-config:general_9239ee2"); }, href: "/company/settings" },
  { value: "export", get label() { return t("agent-config:export_f3e4fad"); }, href: "/company/export" },
  { value: "import", get label() { return t("agent-config:import_d6fbc9d"); }, href: "/company/import" },
  { value: "members", get label() { return t("agent-config:members_1cb449c"); }, href: "/company/settings/members" },
  { value: "secrets", get label() { return t("agent-config:secrets_1e3732a"); }, href: "/company/settings/secrets" },
  { value: "instance-profile", get label() { return t("agent-config:profile_ff4fc02"); }, href: `${INSTANCE_SETTINGS_PATH_PREFIX}/profile` },
  { value: "instance-environments", get label() { return t("agent-config:environments_017b53c"); }, href: `${INSTANCE_SETTINGS_PATH_PREFIX}/environments` },
  { value: "connections", get label() { return t("agent-config:connections_8f3509b"); }, href: "/company/settings/connections" },
  { value: "instance-access", get label() { return t("agent-config:access_2f81a22"); }, href: `${INSTANCE_SETTINGS_PATH_PREFIX}/access` },
  { value: "instance-experimental", get label() { return t("agent-config:experimental_b718f8c"); }, href: `${INSTANCE_SETTINGS_PATH_PREFIX}/experimental` },
  { value: "instance-plugins", get label() { return t("agent-config:plugins_ab2e26d"); }, href: `${INSTANCE_SETTINGS_PATH_PREFIX}/plugins` },
  { value: "instance-adapters", get label() { return t("agent-config:adapters_e07a4ac"); }, href: `${INSTANCE_SETTINGS_PATH_PREFIX}/adapters` },
] as const;

type CompanySettingsTab = (typeof items)[number]["value"];

/** Tab values suppressed when their page is operator-hidden. */
const hiddenSettingKeyByTab: Partial<Record<CompanySettingsTab, string>> = {
  export: "company.export",
  import: "company.import",
  members: "company.members",
  secrets: "company.secrets",
  "instance-profile": "instance.profile",
  "instance-environments": "instance.environments",
  "instance-access": "instance.access",
  "instance-experimental": "instance.experimental",
  "instance-plugins": "instance.plugins",
  "instance-adapters": "instance.adapters",
};

export function getCompanySettingsTab(pathname: string): CompanySettingsTab {
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

  return "general";
}

export function CompanySettingsNav() {
  useTranslation("agent-config");
  const location = useLocation();
  const navigate = useNavigate();
  const { hidden: hiddenSettings } = useHiddenSettings();
  // Import is floored server-side on cloud-managed instances (403 cloud_managed), so the
  // tab is suppressed there rather than dead-ending.
  const isCloud = Boolean(useCloudInstance());
  const activeTab = getCompanySettingsTab(location.pathname);
  const visibleItems = items.filter((item) => {
    if (item.value === "import" && isCloud) return false;
    const hiddenKey = hiddenSettingKeyByTab[item.value];
    return !hiddenKey || !hiddenSettings.has(hiddenKey);
  });

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
