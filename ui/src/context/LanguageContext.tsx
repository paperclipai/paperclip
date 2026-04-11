import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { useTranslation as useI18nTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, type SupportedLanguage } from '../i18n/config';

interface LanguageContextValue {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
  t: ReturnType<typeof useI18nTranslation>['t'];
  isReady: boolean;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const { t, ready: isReady } = useI18nTranslation();
  const [language, setLanguageState] = useState<SupportedLanguage>(() => {
    const stored = localStorage.getItem('paperclip:language');
    if (stored && SUPPORTED_LANGUAGES.includes(stored as SupportedLanguage)) {
      return stored as SupportedLanguage;
    }
    return DEFAULT_LANGUAGE;
  });

  const setLanguage = useCallback((lang: SupportedLanguage) => {
    setLanguageState(lang);
    localStorage.setItem('paperclip:language', lang);
    import('../i18n/config').then(({ default: i18n }) => {
      i18n.changeLanguage(lang);
    });
  }, []);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'paperclip:language' && e.newValue) {
        setLanguageState(e.newValue as SupportedLanguage);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const value: LanguageContextValue = {
    language,
    setLanguage,
    t,
    isReady,
  };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
