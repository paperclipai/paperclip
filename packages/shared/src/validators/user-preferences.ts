import { z } from "zod";
import { SUPPORTED_CURRENCIES, type CurrencyCode } from "../types/currency.js";

const currencyCodeSchema = z.enum(SUPPORTED_CURRENCIES as [CurrencyCode, ...CurrencyCode[]]);

export const userPreferencesSchema = z.object({
  preferredCurrency: currencyCodeSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const getUserPreferencesResponseSchema = z.object({
  preferredCurrency: currencyCodeSchema,
});

export const updateUserPreferencesSchema = z.object({
  preferredCurrency: currencyCodeSchema,
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;
export type GetUserPreferencesResponse = z.infer<typeof getUserPreferencesResponseSchema>;
export type UpdateUserPreferences = z.infer<typeof updateUserPreferencesSchema>;