import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import commonEn from "../locales/en/common.json";
import dashboardEn from "../locales/en/pages/dashboard.json";
import issuesEn from "../locales/en/pages/issues.json";
import agentsEn from "../locales/en/pages/agents.json";
import projectsEn from "../locales/en/pages/projects.json";
import commonFr from "../locales/fr/common.json";
import dashboardFr from "../locales/fr/pages/dashboard.json";
import issuesFr from "../locales/fr/pages/issues.json";
import agentsFr from "../locales/fr/pages/agents.json";
import projectsFr from "../locales/fr/pages/projects.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: commonEn, dashboard: dashboardEn, issues: issuesEn, agents: agentsEn, projects: projectsEn },
      fr: { common: commonFr, dashboard: dashboardFr, issues: issuesFr, agents: agentsFr, projects: projectsFr },
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
