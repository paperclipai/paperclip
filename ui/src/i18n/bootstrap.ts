import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resolveInitialUILocale } from "./locale";

import enCommon from "./locales/en/common.json";
import zhCommon from "./locales/zh/common.json";
import enApp from "./locales/en/app.json";
import zhApp from "./locales/zh/app.json";
import enSidebar from "./locales/en/sidebar.json";
import zhSidebar from "./locales/zh/sidebar.json";
import enInstanceSidebar from "./locales/en/instanceSidebar.json";
import zhInstanceSidebar from "./locales/zh/instanceSidebar.json";
import enMobileNav from "./locales/en/mobileNav.json";
import zhMobileNav from "./locales/zh/mobileNav.json";
import enLayout from "./locales/en/layout.json";
import zhLayout from "./locales/zh/layout.json";
import enNotFound from "./locales/en/notFound.json";
import zhNotFound from "./locales/zh/notFound.json";
import enOnboarding from "./locales/en/onboarding.json";
import zhOnboarding from "./locales/zh/onboarding.json";

const namespaces = [
  "common",
  "app",
  "sidebar",
  "instanceSidebar",
  "mobileNav",
  "layout",
  "notFound",
  "onboarding",
] as const;

void i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: enCommon,
      app: enApp,
      sidebar: enSidebar,
      instanceSidebar: enInstanceSidebar,
      mobileNav: enMobileNav,
      layout: enLayout,
      notFound: enNotFound,
      onboarding: enOnboarding,
    },
    zh: {
      common: zhCommon,
      app: zhApp,
      sidebar: zhSidebar,
      instanceSidebar: zhInstanceSidebar,
      mobileNav: zhMobileNav,
      layout: zhLayout,
      notFound: zhNotFound,
      onboarding: zhOnboarding,
    },
  },
  lng: resolveInitialUILocale(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: [...namespaces],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export { i18n };
