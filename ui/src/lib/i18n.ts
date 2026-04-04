import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import commonEn from "../locales/en/common.json";
import dashboardEn from "../locales/en/pages/dashboard.json";
import issuesEn from "../locales/en/pages/issues.json";
import agentsEn from "../locales/en/pages/agents.json";
import projectsEn from "../locales/en/pages/projects.json";
import routinesEn from "../locales/en/pages/routines.json";
import goalsEn from "../locales/en/pages/goals.json";
import approvalsEn from "../locales/en/pages/approvals.json";
import costsEn from "../locales/en/pages/costs.json";
import activityEn from "../locales/en/pages/activity.json";
import companySettingsEn from "../locales/en/pages/companySettings.json";
import pluginManagerEn from "../locales/en/pages/pluginManager.json";
import pluginSettingsEn from "../locales/en/pages/pluginSettings.json";
import instanceSettingsEn from "../locales/en/pages/instanceSettings.json";
import instanceHeartbeatsEn from "../locales/en/pages/instanceHeartbeats.json";
import instanceExperimentalEn from "../locales/en/pages/instanceExperimental.json";
import layoutEn from "../locales/en/pages/layout.json";
import onboardingEn from "../locales/en/pages/onboarding.json";
import appEn from "../locales/en/pages/app.json";
import commonFr from "../locales/fr/common.json";
import dashboardFr from "../locales/fr/pages/dashboard.json";
import issuesFr from "../locales/fr/pages/issues.json";
import agentsFr from "../locales/fr/pages/agents.json";
import projectsFr from "../locales/fr/pages/projects.json";
import routinesFr from "../locales/fr/pages/routines.json";
import goalsFr from "../locales/fr/pages/goals.json";
import approvalsFr from "../locales/fr/pages/approvals.json";
import costsFr from "../locales/fr/pages/costs.json";
import activityFr from "../locales/fr/pages/activity.json";
import companySettingsFr from "../locales/fr/pages/companySettings.json";
import pluginManagerFr from "../locales/fr/pages/pluginManager.json";
import pluginSettingsFr from "../locales/fr/pages/pluginSettings.json";
import instanceSettingsFr from "../locales/fr/pages/instanceSettings.json";
import instanceHeartbeatsFr from "../locales/fr/pages/instanceHeartbeats.json";
import instanceExperimentalFr from "../locales/fr/pages/instanceExperimental.json";
import layoutFr from "../locales/fr/pages/layout.json";
import onboardingFr from "../locales/fr/pages/onboarding.json";
import appFr from "../locales/fr/pages/app.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: commonEn, dashboard: dashboardEn, issues: issuesEn, agents: agentsEn, projects: projectsEn, routines: routinesEn, goals: goalsEn, approvals: approvalsEn, costs: costsEn, activity: activityEn, companySettings: companySettingsEn, pluginManager: pluginManagerEn, pluginSettings: pluginSettingsEn, instanceSettings: instanceSettingsEn, instanceHeartbeats: instanceHeartbeatsEn, instanceExperimental: instanceExperimentalEn, layout: layoutEn, onboarding: onboardingEn, app: appEn },
      fr: { common: commonFr, dashboard: dashboardFr, issues: issuesFr, agents: agentsFr, projects: projectsFr, routines: routinesFr, goals: goalsFr, approvals: approvalsFr, costs: costsFr, activity: activityFr, companySettings: companySettingsFr, pluginManager: pluginManagerFr, pluginSettings: pluginSettingsFr, instanceSettings: instanceSettingsFr, instanceHeartbeats: instanceHeartbeatsFr, instanceExperimental: instanceExperimentalFr, layout: layoutFr, onboarding: onboardingFr, app: appFr },
    },
    defaultNS: "common",
    fallbackLng: "en",
    interpolation: { escapeValue: true },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "paperclip-language",
    },
  });

export default i18n;
