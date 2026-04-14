import { z } from "zod";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../constants.js";

export const supportedLocaleSchema = z.enum(SUPPORTED_LOCALES);

export const userPreferencesSchema = z.object({
  locale: supportedLocaleSchema.nullable(),
}).strict();

export const patchUserPreferencesSchema = userPreferencesSchema;

export const i18nConfigSchema = z.object({
  defaultLocale: supportedLocaleSchema.default(DEFAULT_LOCALE),
  supportedLocales: z.array(supportedLocaleSchema).default([...SUPPORTED_LOCALES]),
}).strict();

export type SupportedLocale = z.infer<typeof supportedLocaleSchema>;
export type UserPreferences = z.infer<typeof userPreferencesSchema>;
export type PatchUserPreferences = z.infer<typeof patchUserPreferencesSchema>;
export type I18nConfig = z.infer<typeof i18nConfigSchema>;
