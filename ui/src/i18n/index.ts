import i18n from "i18next";
import { initReactI18next } from "react-i18next";
// LanguageDetector removed — it overrides lng setting based on navigator.language
// Language is managed via localStorage("paperclip.language") + LanguageSelector component

// English resources (inlined)
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

// Korean resources (inlined for instant availability)
import commonKo from "./locales/ko/common.json";
import agentsKo from "./locales/ko/agents.json";
import costsKo from "./locales/ko/costs.json";
import inboxKo from "./locales/ko/inbox.json";
import dashboardKo from "./locales/ko/dashboard.json";
import issuesKo from "./locales/ko/issues.json";
import projectsKo from "./locales/ko/projects.json";
import goalsKo from "./locales/ko/goals.json";
import approvalsKo from "./locales/ko/approvals.json";
import routinesKo from "./locales/ko/routines.json";
import settingsKo from "./locales/ko/settings.json";
import onboardingKo from "./locales/ko/onboarding.json";
import skillsKo from "./locales/ko/skills.json";
import workspacesKo from "./locales/ko/workspaces.json";
import pluginsKo from "./locales/ko/plugins.json";

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
      ko: {
        common: commonKo,
        agents: agentsKo,
        costs: costsKo,
        inbox: inboxKo,
        dashboard: dashboardKo,
        issues: issuesKo,
        projects: projectsKo,
        goals: goalsKo,
        approvals: approvalsKo,
        routines: routinesKo,
        settings: settingsKo,
        onboarding: onboardingKo,
        skills: skillsKo,
        workspaces: workspacesKo,
        plugins: pluginsKo,
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
 * Load language bundles on demand.
 *
 * For EN: already inlined and authoritative, no fetch needed.
 * For KO: inlined in Core, but also fetches from server plugin locale API
 * to allow plugins to supplement/override translations.
 * For other languages: fetches from local Vite glob (if available)
 * and from the server plugin locale API.
 */
export async function loadLanguage(lng: string): Promise<void> {
  if (lng === "en") return; // EN is always inlined and authoritative

  // KO is inlined but may be supplemented/overridden by plugins.
  // For inlined languages, skip local Vite glob but still fetch from server.
  const isInlined = lng === "ko";

  // Try local Vite glob first (for languages bundled in Core, skip if already inlined)
  const localLoads: Promise<void>[] = [];
  if (!isInlined) {
    const modules = import.meta.glob("./locales/**/*.json") as Record<
      string,
      () => Promise<{ default: Record<string, unknown> }>
    >;

    const prefix = `./locales/${lng}/`;
    localLoads.push(
      ...Object.entries(modules)
        .filter(([p]) => p.startsWith(prefix))
        .map(async ([p, loader]) => {
          const nsName = p.match(/\/(\w+)\.json$/)?.[1];
          if (!nsName) return;
          const mod = await loader();
          i18n.addResourceBundle(lng, nsName, mod.default, true, true);
        }),
    );
  }

  // Also try server plugin locale API
  const serverLoad = (async () => {
    try {
      const res = await fetch(`/api/plugins/locales/${encodeURIComponent(lng)}?_t=${Date.now()}`);
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
      // Server unavailable — use local bundles only
    }
  })();

  await Promise.all([...localLoads, serverLoad]);
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
