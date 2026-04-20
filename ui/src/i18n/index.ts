import i18n from "i18next";
import { initReactI18next } from "react-i18next";
// LanguageDetector removed — it overrides lng setting based on navigator.language
// Language is managed via localStorage("paperclip.language") + LanguageSelector component

// English resources (inlined — only EN is bundled in Core)
import commonEn from "./locales/en/common.json";
import agentsEn from "./locales/en/agents.json";
import costsEn from "./locales/en/costs.json";
import inboxEn from "./locales/en/inbox.json";
import dashboardEn from "./locales/en/dashboard.json";
import issuesEn from "./locales/en/issues.json";
import projectsEn from "./locales/en/projects.json";
import goalsEn from "./locales/en/goals.json";
import approvalsEn from "./locales/en/approvals.json";
import routinesEn from "./locales/en/routines.json";
import settingsEn from "./locales/en/settings.json";
import onboardingEn from "./locales/en/onboarding.json";
import skillsEn from "./locales/en/skills.json";
import workspacesEn from "./locales/en/workspaces.json";
import pluginsEn from "./locales/en/plugins.json";

// Non-English languages are loaded on demand from plugins via loadLanguage()

const ns = [
  "common", "agents", "costs", "inbox",
  "dashboard", "issues", "projects", "goals",
  "approvals", "routines", "settings", "onboarding",
  "skills", "workspaces", "plugins",
];

// Resolve language: user preference from localStorage, fallback to en
const savedLang = typeof window !== "undefined"
  ? localStorage.getItem("paperclip.language") ?? "en"
  : "en";

// eslint-disable-next-line @typescript-eslint/no-floating-promises
i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: commonEn,
        agents: agentsEn,
        costs: costsEn,
        inbox: inboxEn,
        dashboard: dashboardEn,
        issues: issuesEn,
        projects: projectsEn,
        goals: goalsEn,
        approvals: approvalsEn,
        routines: routinesEn,
        settings: settingsEn,
        onboarding: onboardingEn,
        skills: skillsEn,
        workspaces: workspacesEn,
        plugins: pluginsEn,
      },
    },
    ns,
    defaultNS: "common",
    lng: savedLang,
    fallbackLng: "en",
    keySeparator: false,
    interpolation: { escapeValue: false },
  } as Parameters<typeof i18n.init>[0]);

/**
 * Load language bundles on demand from plugins.
 *
 * EN is inlined in Core and never needs loading.
 * All other languages (ko, ja, es, etc.) are loaded from the server
 * plugin locale API when the user switches language.
 */
export async function loadLanguage(lng: string): Promise<void> {
  if (lng === "en") return; // EN is always inlined and authoritative

  // Fetch from server plugin locale API
  try {
    const res = await fetch(`/api/locales/${encodeURIComponent(lng)}?_t=${Date.now()}`);
    if (!res.ok) return;
    const bundle = await res.json() as {
      core: Record<string, Record<string, string>>;
      custom: Record<string, Record<string, string>>;
    };
    for (const [ns, translations] of Object.entries(bundle.core)) {
      i18n.addResourceBundle(lng, ns, translations, true, true);
    }
    for (const [scopedKey, translations] of Object.entries(bundle.custom)) {
      i18n.addResourceBundle(lng, scopedKey, translations, true, true);
    }
  } catch {
    // Server unavailable — fallback to EN
  }
}

/**
 * Remove all locale resources contributed by a specific plugin.
 * Called when a plugin is uninstalled or disabled.
 */
export function removePluginLocales(pluginKey: string, namespaces: string[], languages: string[]): void {
  for (const lng of languages) {
    for (const ns of namespaces) {
      const i18nNamespace = `plugin.${pluginKey}.${ns}`;
      i18n.removeResourceBundle(lng, i18nNamespace);
    }
  }
}

/**
 * Load a plugin's locale JSON for the current language.
 *
 * Convention-based discovery: tries to fetch
 * `/_plugins/{pluginId}/ui/locales/{lang}/{namespace}.json`
 *
 * Loaded resources are registered under i18next namespace
 * `plugin.{pluginKey}.{namespace}` so plugins access them via
 * `usePluginTranslation("plugin.myPlugin.messages")`.
 *
 * @param pluginId - The plugin database ID (used in URL path)
 * @param pluginKey - The plugin manifest key (used in namespace)
 * @param namespaces - List of namespace names to attempt loading
 */
export async function loadPluginLocales(
  pluginId: string,
  pluginKey: string,
  namespaces: string[],
): Promise<void> {
  const lng = i18n.language;

  const loads = namespaces.map(async (ns) => {
    const url = `/_plugins/${encodeURIComponent(pluginId)}/ui/locales/${encodeURIComponent(lng)}/${encodeURIComponent(ns)}.json`;
    try {
      const res = await fetch(url);
      if (!res.ok) return; // locale file not found — skip silently
      const resources = await res.json();
      const i18nNamespace = `plugin.${pluginKey}.${ns}`;
      i18n.addResourceBundle(lng, i18nNamespace, resources, true, true);
    } catch {
      // Network error — skip silently, plugin works without translations
    }
  });

  await Promise.all(loads);
}

export default i18n;
