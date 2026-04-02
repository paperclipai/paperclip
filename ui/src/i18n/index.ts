import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import commonEn from "./locales/en/common.json";
import navEn from "./locales/en/nav.json";
import dashboardEn from "./locales/en/dashboard.json";
import agentsEn from "./locales/en/agents.json";
import issuesEn from "./locales/en/issues.json";
import settingsEn from "./locales/en/settings.json";
import activityEn from "./locales/en/activity.json";
import adaptersEn from "./locales/en/adapters.json";
import costsEn from "./locales/en/costs.json";
import errorsEn from "./locales/en/errors.json";

import commonRu from "./locales/ru/common.json";
import navRu from "./locales/ru/nav.json";
import dashboardRu from "./locales/ru/dashboard.json";
import agentsRu from "./locales/ru/agents.json";
import issuesRu from "./locales/ru/issues.json";
import settingsRu from "./locales/ru/settings.json";
import activityRu from "./locales/ru/activity.json";
import adaptersRu from "./locales/ru/adapters.json";
import costsRu from "./locales/ru/costs.json";
import errorsRu from "./locales/ru/errors.json";

import commonZh from "./locales/zh/common.json";
import navZh from "./locales/zh/nav.json";
import dashboardZh from "./locales/zh/dashboard.json";
import agentsZh from "./locales/zh/agents.json";
import issuesZh from "./locales/zh/issues.json";
import settingsZh from "./locales/zh/settings.json";
import activityZh from "./locales/zh/activity.json";
import adaptersZh from "./locales/zh/adapters.json";
import costsZh from "./locales/zh/costs.json";
import errorsZh from "./locales/zh/errors.json";

import commonEs from "./locales/es/common.json";
import navEs from "./locales/es/nav.json";
import dashboardEs from "./locales/es/dashboard.json";
import agentsEs from "./locales/es/agents.json";
import issuesEs from "./locales/es/issues.json";
import settingsEs from "./locales/es/settings.json";
import activityEs from "./locales/es/activity.json";
import adaptersEs from "./locales/es/adapters.json";
import costsEs from "./locales/es/costs.json";
import errorsEs from "./locales/es/errors.json";

import commonJa from "./locales/ja/common.json";
import navJa from "./locales/ja/nav.json";
import dashboardJa from "./locales/ja/dashboard.json";
import agentsJa from "./locales/ja/agents.json";
import issuesJa from "./locales/ja/issues.json";
import settingsJa from "./locales/ja/settings.json";
import activityJa from "./locales/ja/activity.json";
import adaptersJa from "./locales/ja/adapters.json";
import costsJa from "./locales/ja/costs.json";
import errorsJa from "./locales/ja/errors.json";

import commonDe from "./locales/de/common.json";
import navDe from "./locales/de/nav.json";
import dashboardDe from "./locales/de/dashboard.json";
import agentsDe from "./locales/de/agents.json";
import issuesDe from "./locales/de/issues.json";
import settingsDe from "./locales/de/settings.json";
import activityDe from "./locales/de/activity.json";
import adaptersDe from "./locales/de/adapters.json";
import costsDe from "./locales/de/costs.json";
import errorsDe from "./locales/de/errors.json";

import commonFr from "./locales/fr/common.json";
import navFr from "./locales/fr/nav.json";
import dashboardFr from "./locales/fr/dashboard.json";
import agentsFr from "./locales/fr/agents.json";
import issuesFr from "./locales/fr/issues.json";
import settingsFr from "./locales/fr/settings.json";
import activityFr from "./locales/fr/activity.json";
import adaptersFr from "./locales/fr/adapters.json";
import costsFr from "./locales/fr/costs.json";
import errorsFr from "./locales/fr/errors.json";

import commonPtBR from "./locales/pt-BR/common.json";
import navPtBR from "./locales/pt-BR/nav.json";
import dashboardPtBR from "./locales/pt-BR/dashboard.json";
import agentsPtBR from "./locales/pt-BR/agents.json";
import issuesPtBR from "./locales/pt-BR/issues.json";
import settingsPtBR from "./locales/pt-BR/settings.json";
import activityPtBR from "./locales/pt-BR/activity.json";
import adaptersPtBR from "./locales/pt-BR/adapters.json";
import costsPtBR from "./locales/pt-BR/costs.json";
import errorsPtBR from "./locales/pt-BR/errors.json";

import commonKo from "./locales/ko/common.json";
import navKo from "./locales/ko/nav.json";
import dashboardKo from "./locales/ko/dashboard.json";
import agentsKo from "./locales/ko/agents.json";
import issuesKo from "./locales/ko/issues.json";
import settingsKo from "./locales/ko/settings.json";
import activityKo from "./locales/ko/activity.json";
import adaptersKo from "./locales/ko/adapters.json";
import costsKo from "./locales/ko/costs.json";
import errorsKo from "./locales/ko/errors.json";

const LANGUAGE_STORAGE_KEY = "paperclip.language";

function getStoredLanguage(): string {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) || "en";
  } catch {
    return "en";
  }
}

export const supportedLanguages = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
  { code: "zh", label: "中文" },
  { code: "es", label: "Español" },
  { code: "ja", label: "日本語" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "ko", label: "한국어" },
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number]["code"];

const namespaces = [
  "common",
  "nav",
  "dashboard",
  "agents",
  "issues",
  "settings",
  "activity",
  "adapters",
  "costs",
  "errors",
] as const;

i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: commonEn,
      nav: navEn,
      dashboard: dashboardEn,
      agents: agentsEn,
      issues: issuesEn,
      settings: settingsEn,
      activity: activityEn,
      adapters: adaptersEn,
      costs: costsEn,
      errors: errorsEn,
    },
    ru: {
      common: commonRu,
      nav: navRu,
      dashboard: dashboardRu,
      agents: agentsRu,
      issues: issuesRu,
      settings: settingsRu,
      activity: activityRu,
      adapters: adaptersRu,
      costs: costsRu,
      errors: errorsRu,
    },
    zh: {
      common: commonZh,
      nav: navZh,
      dashboard: dashboardZh,
      agents: agentsZh,
      issues: issuesZh,
      settings: settingsZh,
      activity: activityZh,
      adapters: adaptersZh,
      costs: costsZh,
      errors: errorsZh,
    },
    es: {
      common: commonEs,
      nav: navEs,
      dashboard: dashboardEs,
      agents: agentsEs,
      issues: issuesEs,
      settings: settingsEs,
      activity: activityEs,
      adapters: adaptersEs,
      costs: costsEs,
      errors: errorsEs,
    },
    ja: {
      common: commonJa,
      nav: navJa,
      dashboard: dashboardJa,
      agents: agentsJa,
      issues: issuesJa,
      settings: settingsJa,
      activity: activityJa,
      adapters: adaptersJa,
      costs: costsJa,
      errors: errorsJa,
    },
    de: {
      common: commonDe,
      nav: navDe,
      dashboard: dashboardDe,
      agents: agentsDe,
      issues: issuesDe,
      settings: settingsDe,
      activity: activityDe,
      adapters: adaptersDe,
      costs: costsDe,
      errors: errorsDe,
    },
    fr: {
      common: commonFr,
      nav: navFr,
      dashboard: dashboardFr,
      agents: agentsFr,
      issues: issuesFr,
      settings: settingsFr,
      activity: activityFr,
      adapters: adaptersFr,
      costs: costsFr,
      errors: errorsFr,
    },
    "pt-BR": {
      common: commonPtBR,
      nav: navPtBR,
      dashboard: dashboardPtBR,
      agents: agentsPtBR,
      issues: issuesPtBR,
      settings: settingsPtBR,
      activity: activityPtBR,
      adapters: adaptersPtBR,
      costs: costsPtBR,
      errors: errorsPtBR,
    },
    ko: {
      common: commonKo,
      nav: navKo,
      dashboard: dashboardKo,
      agents: agentsKo,
      issues: issuesKo,
      settings: settingsKo,
      activity: activityKo,
      adapters: adaptersKo,
      costs: costsKo,
      errors: errorsKo,
    },
  },
  lng: getStoredLanguage(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: [...namespaces],
  interpolation: {
    escapeValue: false,
  },
});

export function changeLanguage(lang: SupportedLanguage) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Ignore storage write failures.
  }
  document.documentElement.lang = lang;
  return i18n.changeLanguage(lang);
}

export default i18n;
