import i18n, { type BackendModule, type InitOptions, type ResourceKey, type TOptions } from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, loadLocaleMessages, supportedLocales } from "./locales";

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
  partialBundledLanguages: true,
};

// English is bundled; changeLanguage()/loadLanguages() fetch any other catalog on demand.
const lazyLocaleBackend: BackendModule = {
  type: "backend",
  init() {},
  read(language, _namespace, callback) {
    loadLocaleMessages(language).then((messages) => callback(null, messages as ResourceKey), (error: Error) => callback(error, null));
  },
};

void i18n.use(lazyLocaleBackend).use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

export function t(
  key: string,
  defaultValueOrOptions?: string | TOptions,
  options?: TOptions,
) {
  if (typeof defaultValueOrOptions === "string") {
    return i18n.t(key, { defaultValue: defaultValueOrOptions, ...(options || {}) });
  }
  return i18n.t(key, defaultValueOrOptions ?? {});
}

export { useTranslation } from "react-i18next";
export { i18n };
