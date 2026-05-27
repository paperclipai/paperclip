import { useCallback } from "react";
import type { TOptions } from "i18next";

import { useTranslation } from "./index";
import { isKoreanLocale } from "./locale-utils";

export function useCurrentLocale() {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
}

export function useLocalizedCopy() {
  const { t, i18n } = useTranslation();
  const korean = isKoreanLocale(i18n.resolvedLanguage ?? i18n.language);

  return useCallback(
    (key: string, english: string, koreanText: string, options: TOptions = {}) =>
      String(t(key, { ...options, defaultValue: korean ? koreanText : english })),
    [korean, t],
  );
}
