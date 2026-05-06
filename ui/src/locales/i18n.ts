import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import commonEN from "./en/common.json";
import agentsEN from "./en/agents.json";
import activityEN from "./en/activity.json";
import issuesEN from "./en/issues.json";
import goalsEN from "./en/goals.json";
import costsEN from "./en/costs.json";
import companyEN from "./en/company.json";
import approvalsEN from "./en/approvals.json";
import routinesEN from "./en/routines.json";
import dashboardEN from "./en/dashboard.json";
import orgEN from "./en/org.json";
import inboxEN from "./en/inbox.json";
import settingsEN from "./en/settings.json";
import adaptersEN from "./en/adapters.json";
import onboardingEN from "./en/onboarding.json";

import commonRU from "./ru/common.json";
import agentsRU from "./ru/agents.json";
import activityRU from "./ru/activity.json";
import issuesRU from "./ru/issues.json";
import goalsRU from "./ru/goals.json";
import costsRU from "./ru/costs.json";
import companyRU from "./ru/company.json";
import approvalsRU from "./ru/approvals.json";
import routinesRU from "./ru/routines.json";
import dashboardRU from "./ru/dashboard.json";
import orgRU from "./ru/org.json";
import inboxRU from "./ru/inbox.json";
import settingsRU from "./ru/settings.json";
import adaptersRU from "./ru/adapters.json";
import onboardingRU from "./ru/onboarding.json";

import commonUK from "./uk/common.json";
import agentsUK from "./uk/agents.json";
import activityUK from "./uk/activity.json";
import issuesUK from "./uk/issues.json";
import goalsUK from "./uk/goals.json";
import costsUK from "./uk/costs.json";
import companyUK from "./uk/company.json";
import approvalsUK from "./uk/approvals.json";
import routinesUK from "./uk/routines.json";
import dashboardUK from "./uk/dashboard.json";
import orgUK from "./uk/org.json";
import inboxUK from "./uk/inbox.json";
import settingsUK from "./uk/settings.json";
import adaptersUK from "./uk/adapters.json";
import onboardingUK from "./uk/onboarding.json";

import commonDE from "./de/common.json";
import agentsDE from "./de/agents.json";
import activityDE from "./de/activity.json";
import issuesDE from "./de/issues.json";
import goalsDE from "./de/goals.json";
import costsDE from "./de/costs.json";
import companyDE from "./de/company.json";
import approvalsDE from "./de/approvals.json";
import routinesDE from "./de/routines.json";
import dashboardDE from "./de/dashboard.json";
import orgDE from "./de/org.json";
import inboxDE from "./de/inbox.json";
import settingsDE from "./de/settings.json";
import adaptersDE from "./de/adapters.json";
import onboardingDE from "./de/onboarding.json";

import commonES from "./es/common.json";
import agentsES from "./es/agents.json";
import activityES from "./es/activity.json";
import issuesES from "./es/issues.json";
import goalsES from "./es/goals.json";
import costsES from "./es/costs.json";
import companyES from "./es/company.json";
import approvalsES from "./es/approvals.json";
import routinesES from "./es/routines.json";
import dashboardES from "./es/dashboard.json";
import orgES from "./es/org.json";
import inboxES from "./es/inbox.json";
import settingsES from "./es/settings.json";
import adaptersES from "./es/adapters.json";
import onboardingES from "./es/onboarding.json";

import commonZH from "./zh/common.json";
import agentsZH from "./zh/agents.json";
import activityZH from "./zh/activity.json";
import issuesZH from "./zh/issues.json";
import goalsZH from "./zh/goals.json";
import costsZH from "./zh/costs.json";
import companyZH from "./zh/company.json";
import approvalsZH from "./zh/approvals.json";
import routinesZH from "./zh/routines.json";
import dashboardZH from "./zh/dashboard.json";
import orgZH from "./zh/org.json";
import inboxZH from "./zh/inbox.json";
import settingsZH from "./zh/settings.json";
import adaptersZH from "./zh/adapters.json";
import onboardingZH from "./zh/onboarding.json";

import commonPT from "./pt/common.json";
import agentsPT from "./pt/agents.json";
import activityPT from "./pt/activity.json";
import issuesPT from "./pt/issues.json";
import goalsPT from "./pt/goals.json";
import costsPT from "./pt/costs.json";
import companyPT from "./pt/company.json";
import approvalsPT from "./pt/approvals.json";
import routinesPT from "./pt/routines.json";
import dashboardPT from "./pt/dashboard.json";
import orgPT from "./pt/org.json";
import inboxPT from "./pt/inbox.json";
import settingsPT from "./pt/settings.json";
import adaptersPT from "./pt/adapters.json";
import onboardingPT from "./pt/onboarding.json";

import commonEL from "./el/common.json";
import agentsEL from "./el/agents.json";
import activityEL from "./el/activity.json";
import issuesEL from "./el/issues.json";
import goalsEL from "./el/goals.json";
import costsEL from "./el/costs.json";
import companyEL from "./el/company.json";
import approvalsEL from "./el/approvals.json";
import routinesEL from "./el/routines.json";
import dashboardEL from "./el/dashboard.json";
import orgEL from "./el/org.json";
import inboxEL from "./el/inbox.json";
import settingsEL from "./el/settings.json";
import adaptersEL from "./el/adapters.json";
import onboardingEL from "./el/onboarding.json";

const LANGUAGE_KEY = "paperclip_language";

const SUPPORTED_LANGUAGES = ["en", "ru", "uk", "es", "de", "pt", "zh", "el"] as const;

type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

/** Returns the persisted language or browser default, falling back to English. */
function getInitialLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (SUPPORTED_LANGUAGES.some((lang) => lang === stored)) {
      return stored as SupportedLanguage;
    }
  } catch {
    // localStorage unavailable (e.g. SSR, private mode)
  }
  const browser = navigator.language.slice(0, 2);
  if (SUPPORTED_LANGUAGES.some((lang) => lang === browser)) {
    return browser as SupportedLanguage;
  }
  return "en";
}

i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: commonEN,
      agents: agentsEN,
      activity: activityEN,
      issues: issuesEN,
      goals: goalsEN,
      costs: costsEN,
      company: companyEN,
      approvals: approvalsEN,
      routines: routinesEN,
      dashboard: dashboardEN,
      org: orgEN,
      inbox: inboxEN,
      settings: settingsEN,
      adapters: adaptersEN,
      onboarding: onboardingEN,
    },
    ru: {
      common: commonRU,
      agents: agentsRU,
      activity: activityRU,
      issues: issuesRU,
      goals: goalsRU,
      costs: costsRU,
      company: companyRU,
      approvals: approvalsRU,
      routines: routinesRU,
      dashboard: dashboardRU,
      org: orgRU,
      inbox: inboxRU,
      settings: settingsRU,
      adapters: adaptersRU,
      onboarding: onboardingRU,
    },
    uk: {
      common: commonUK,
      agents: agentsUK,
      activity: activityUK,
      issues: issuesUK,
      goals: goalsUK,
      costs: costsUK,
      company: companyUK,
      approvals: approvalsUK,
      routines: routinesUK,
      dashboard: dashboardUK,
      org: orgUK,
      inbox: inboxUK,
      settings: settingsUK,
      adapters: adaptersUK,
      onboarding: onboardingUK,
    },
    es: {
      common: commonES,
      agents: agentsES,
      activity: activityES,
      issues: issuesES,
      goals: goalsES,
      costs: costsES,
      company: companyES,
      approvals: approvalsES,
      routines: routinesES,
      dashboard: dashboardES,
      org: orgES,
      inbox: inboxES,
      settings: settingsES,
      adapters: adaptersES,
      onboarding: onboardingES,
    },
    de: {
      common: commonDE,
      agents: agentsDE,
      activity: activityDE,
      issues: issuesDE,
      goals: goalsDE,
      costs: costsDE,
      company: companyDE,
      approvals: approvalsDE,
      routines: routinesDE,
      dashboard: dashboardDE,
      org: orgDE,
      inbox: inboxDE,
      settings: settingsDE,
      adapters: adaptersDE,
      onboarding: onboardingDE,
    },
    zh: {
      common: commonZH,
      agents: agentsZH,
      activity: activityZH,
      issues: issuesZH,
      goals: goalsZH,
      costs: costsZH,
      company: companyZH,
      approvals: approvalsZH,
      routines: routinesZH,
      dashboard: dashboardZH,
      org: orgZH,
      inbox: inboxZH,
      settings: settingsZH,
      adapters: adaptersZH,
      onboarding: onboardingZH,
    },
    pt: {
      common: commonPT,
      agents: agentsPT,
      activity: activityPT,
      issues: issuesPT,
      goals: goalsPT,
      costs: costsPT,
      company: companyPT,
      approvals: approvalsPT,
      routines: routinesPT,
      dashboard: dashboardPT,
      org: orgPT,
      inbox: inboxPT,
      settings: settingsPT,
      adapters: adaptersPT,
      onboarding: onboardingPT,
    },
    el: {
      common: commonEL,
      agents: agentsEL,
      activity: activityEL,
      issues: issuesEL,
      goals: goalsEL,
      costs: costsEL,
      company: companyEL,
      approvals: approvalsEL,
      routines: routinesEL,
      dashboard: dashboardEL,
      org: orgEL,
      inbox: inboxEL,
      settings: settingsEL,
      adapters: adaptersEL,
      onboarding: onboardingEL,
    },
  },
  lng: getInitialLanguage(),
  fallbackLng: "en",
  defaultNS: "common",
  returnEmptyString: false,
  returnNull: false,
  saveMissing: false,
  parseMissingKeyHandler: (key, defaultValue) => defaultValue ?? key,
  missingKeyHandler: (lngs, ns, key) => {
    if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${ns}:${key} for ${lngs}`);
  },
  interpolation: {
    escapeValue: false,
  },
  react: { useSuspense: false },
});

/** Switches app language without restart and persists choice. */
export function setLanguage(lang: SupportedLanguage): void {
  i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANGUAGE_KEY, lang);
  } catch {
    // ignore
  }
}

export const LANGUAGE_NATIVE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  ru: "Русский",
  uk: "Українська",
  es: "Español",
  de: "Deutsch",
  pt: "Português (BR)",
  zh: "中文",
  el: "Ελληνικά",
};

export { LANGUAGE_KEY, SUPPORTED_LANGUAGES };
export type { SupportedLanguage };
export default i18n;
