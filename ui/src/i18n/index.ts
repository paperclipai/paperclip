import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enNavigation from "./locales/en/navigation.json";
import enAgents from "./locales/en/agents.json";
import enIssues from "./locales/en/issues.json";
import enApprovals from "./locales/en/approvals.json";
import enSettings from "./locales/en/settings.json";
import enAdapters from "./locales/en/adapters.json";
import enDashboard from "./locales/en/dashboard.json";
import enInbox from "./locales/en/inbox.json";
import enActivity from "./locales/en/activity.json";
import enInvites from "./locales/en/invites.json";
import enRoutines from "./locales/en/routines.json";
import enGoals from "./locales/en/goals.json";
import enWorkspaces from "./locales/en/workspaces.json";
import enCompanies from "./locales/en/companies.json";
import enProjects from "./locales/en/projects.json";
import enAuth from "./locales/en/auth.json";
import enCosts from "./locales/en/costs.json";
import enPlugins from "./locales/en/plugins.json";
import enSkills from "./locales/en/skills.json";
import enOnboarding from "./locales/en/onboarding.json";

import zhCommon from "./locales/zh/common.json";
import zhNavigation from "./locales/zh/navigation.json";
import zhAgents from "./locales/zh/agents.json";
import zhIssues from "./locales/zh/issues.json";
import zhApprovals from "./locales/zh/approvals.json";
import zhSettings from "./locales/zh/settings.json";
import zhAdapters from "./locales/zh/adapters.json";
import zhDashboard from "./locales/zh/dashboard.json";
import zhInbox from "./locales/zh/inbox.json";
import zhActivity from "./locales/zh/activity.json";
import zhInvites from "./locales/zh/invites.json";
import zhRoutines from "./locales/zh/routines.json";
import zhGoals from "./locales/zh/goals.json";
import zhWorkspaces from "./locales/zh/workspaces.json";
import zhCompanies from "./locales/zh/companies.json";
import zhProjects from "./locales/zh/projects.json";
import zhAuth from "./locales/zh/auth.json";
import zhCosts from "./locales/zh/costs.json";
import zhPlugins from "./locales/zh/plugins.json";
import zhSkills from "./locales/zh/skills.json";
import zhOnboarding from "./locales/zh/onboarding.json";

const resources = {
  en: {
    common: enCommon,
    navigation: enNavigation,
    agents: enAgents,
    issues: enIssues,
    approvals: enApprovals,
    settings: enSettings,
    adapters: enAdapters,
    dashboard: enDashboard,
    inbox: enInbox,
    activity: enActivity,
    invites: enInvites,
    routines: enRoutines,
    goals: enGoals,
    workspaces: enWorkspaces,
    companies: enCompanies,
    projects: enProjects,
    auth: enAuth,
    costs: enCosts,
    plugins: enPlugins,
    skills: enSkills,
    onboarding: enOnboarding,
  },
  zh: {
    common: zhCommon,
    navigation: zhNavigation,
    agents: zhAgents,
    issues: zhIssues,
    approvals: zhApprovals,
    settings: zhSettings,
    adapters: zhAdapters,
    dashboard: zhDashboard,
    inbox: zhInbox,
    activity: zhActivity,
    invites: zhInvites,
    routines: zhRoutines,
    goals: zhGoals,
    workspaces: zhWorkspaces,
    companies: zhCompanies,
    projects: zhProjects,
    auth: zhAuth,
    costs: zhCosts,
    plugins: zhPlugins,
    skills: zhSkills,
    onboarding: zhOnboarding,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "paperclip.locale",
    },
    react: {
      useSuspense: false,
    },
  });

export default i18n;
