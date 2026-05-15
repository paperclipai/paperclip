import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ko from './locales/ko.json';
import en from './locales/en.json';

i18n.use(initReactI18next).init({
  resources: {
    ko: { translation: ko },
    en: { translation: en },
  },
  lng: 'ko', // 기본 언어: 한국어
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React는 XSS 방지가 내장되어 있음
  },
});

export default i18n;
