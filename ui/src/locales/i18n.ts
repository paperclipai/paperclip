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
import transcriptEN from "./en/transcript.json";
import commentsEN from "./en/comments.json";

const LANGUAGE_KEY = "paperclip_language";

const SUPPORTED_LANGUAGES = ["en"] as const;

type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

/** Returns the persisted language or browser default, falling back to English. */
function getInitialLanguage(): SupportedLanguage {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved && (SUPPORTED_LANGUAGES as readonly string[]).includes(saved)) {
      return saved as SupportedLanguage;
    }
  } catch {
    // ignore
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
      transcript: transcriptEN,
      comments: commentsEN,
    },
  },
  lng: getInitialLanguage(),
  fallbackLng: ["en"],
  fallbackNS: "common",
  supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
  nonExplicitSupportedLngs: true,
  load: "languageOnly",
  cleanCode: true,
  defaultNS: "common",
  returnEmptyString: false,
  returnNull: false,
  returnObjects: false,
  saveMissing: false,
  appendNamespaceToMissingKey: true,
  parseMissingKeyHandler: (key, defaultValue) => defaultValue ?? key,
  missingKeyHandler: (lngs, ns, key, _fallbackValue) => {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing key: ${ns}:${key} for ${Array.isArray(lngs) ? lngs.join(",") : lngs} — falling back to en → key`);
    }
  },
  interpolation: {
    escapeValue: false,
  },
  react: { useSuspense: false },
});

if (import.meta.env.DEV) {
  i18n.on("languageChanged", (lng) => {
    console.info(`[i18n] language changed to ${lng}`);
  });
}

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
};

export { LANGUAGE_KEY, SUPPORTED_LANGUAGES };
export type { SupportedLanguage };
export default i18n;
