import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  resources: {},
  lng: "en",
  fallbackLng: "en",
  defaultNS: "common",
  returnEmptyString: false,
  returnNull: false,
  returnObjects: false,
  saveMissing: false,
  appendNamespaceToMissingKey: true,
  parseMissingKeyHandler: (key, defaultValue) => defaultValue ?? key,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
