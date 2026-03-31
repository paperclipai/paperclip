import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { agentsMessages } from "./messages/agents";
import { agentConfigMessages } from "./messages/agentConfig";
import { agentDetailMessages } from "./messages/agentDetail";
import { accessMessages } from "./messages/access";
import { bootstrapMessages } from "./messages/bootstrap";
import { companiesMessages } from "./messages/companies";
import { commonMessages } from "./messages/common";
import { costsMessages } from "./messages/costs";
import { dashboardMessages } from "./messages/dashboard";
import { adminMessages } from "./messages/admin";
import { navigationMessages } from "./messages/navigation";
import { orgMessages } from "./messages/org";
import { portabilityMessages } from "./messages/portability";
import { projectPropertiesMessages } from "./messages/projectProperties";
import { systemMessages } from "./messages/system";
import { workMessages } from "./messages/work";
import { workspaceMessages } from "./messages/workspace";
import {
  getRuntimeLocale,
  normalizeLocale,
  readStoredLocalePreference,
  resolveInitialLocale,
  writeStoredLocalePreference,
} from "./runtime";
import { ACTIVE_LOCALES, type ActiveLocale, type MessageTree } from "./types";

function mergeTrees(target: MessageTree, source: MessageTree): MessageTree {
  const next: MessageTree = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = next[key];
    if (
      current
      && typeof current === "object"
      && !Array.isArray(current)
      && typeof value === "object"
      && !Array.isArray(value)
    ) {
      next[key] = mergeTrees(current as MessageTree, value as MessageTree);
      continue;
    }
    next[key] = value;
  }
  return next;
}

const MESSAGE_SOURCES = [
  accessMessages,
  adminMessages,
  agentConfigMessages,
  agentDetailMessages,
  commonMessages,
  navigationMessages,
  dashboardMessages,
  agentsMessages,
  companiesMessages,
  orgMessages,
  portabilityMessages,
  costsMessages,
  bootstrapMessages,
  projectPropertiesMessages,
  systemMessages,
  workMessages,
  workspaceMessages,
] as const;

const MESSAGES: Record<ActiveLocale, MessageTree> = ACTIVE_LOCALES.reduce(
  (acc, locale) => {
    acc[locale] = MESSAGE_SOURCES.reduce<MessageTree>(
      (tree, source) => mergeTrees(tree, source[locale]),
      {},
    );
    return acc;
  },
  {} as Record<ActiveLocale, MessageTree>,
);

type I18nContextValue = {
  locale: ActiveLocale;
  setLocale: (locale: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getMessageFromTree(tree: MessageTree, key: string): string | null {
  const parts = key.split(".");
  let cursor: string | MessageTree | undefined = tree;
  for (const part of parts) {
    if (!cursor || typeof cursor === "string") return null;
    cursor = cursor[part];
  }
  return typeof cursor === "string" ? cursor : null;
}

function interpolate(template: string, vars?: Record<string, string | number>) {
  if (!vars) return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : "",
  );
}

export function formatMessage(
  locale: ActiveLocale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const value = getMessageFromTree(MESSAGES[locale], key) ?? getMessageFromTree(MESSAGES.en, key);
  return interpolate(value ?? key, vars);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<ActiveLocale>(() => getRuntimeLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
    writeStoredLocalePreference(locale);
  }, [locale]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== "paperclip.locale" && event.key !== "hublit-ui-lang" && event.key !== "preferred_ui_language" && event.key !== "ui_language") {
        return;
      }
      const next = resolveInitialLocale(readStoredLocalePreference(), window.navigator.languages);
      setLocaleState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLocale = useCallback((nextLocale: string) => {
    setLocaleState(normalizeLocale(nextLocale));
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => formatMessage(locale, key, vars),
    [locale],
  );

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t,
  }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used within an I18nProvider");
  return context;
}

export { ACTIVE_LOCALES };
export type { ActiveLocale, MessageTree };
