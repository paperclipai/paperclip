/**
 * i18n initialization — configures i18next with react-i18next for the UI.
 *
 * Namespace strategy: one JSON file per product area (e.g. "agents", "issues").
 * All namespace files live under `locales/{lang}/`.
 *
 * Adding a new language:
 *   1. Create `locales/{lang}/` folder with a copy of every JSON file from `locales/en/`.
 *   2. Translate the values (keys must stay identical).
 *   3. Import each file here and add an `{lang}: { ... }` entry to the `resources` object.
 *
 * Using translations in components:
 *   import { useTranslation } from "react-i18next";
 *   const { t } = useTranslation("agents");  // pass the namespace
 *   return <span>{t("title")}</span>;
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import common from "./locales/en/common.json";
import navigation from "./locales/en/navigation.json";
import dashboard from "./locales/en/dashboard.json";
import agents from "./locales/en/agents.json";
import issues from "./locales/en/issues.json";
import approvals from "./locales/en/approvals.json";
import goals from "./locales/en/goals.json";
import projects from "./locales/en/projects.json";
import costs from "./locales/en/costs.json";
import settings from "./locales/en/settings.json";
import auth from "./locales/en/auth.json";
import onboarding from "./locales/en/onboarding.json";
import inbox from "./locales/en/inbox.json";
import activity from "./locales/en/activity.json";
import notFound from "./locales/en/notFound.json";
import plugins from "./locales/en/plugins.json";

export const defaultNS = "common";

export const resources = {
  en: {
    common,
    navigation,
    dashboard,
    agents,
    issues,
    approvals,
    goals,
    projects,
    costs,
    settings,
    auth,
    onboarding,
    inbox,
    activity,
    notFound,
    plugins,
  },
} as const;

i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  defaultNS,
  resources,
  interpolation: {
    escapeValue: false, // React already escapes
  },
});

export default i18n;
