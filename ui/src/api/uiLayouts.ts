import type { UiLayoutPreference, UiLayoutSurface } from "@paperclipai/shared";
import { api } from "./client";

export const uiLayoutsApi = {
  get: (companyId: string, surface: UiLayoutSurface) =>
    api.get<UiLayoutPreference>(`/companies/${companyId}/ui-layouts/${surface}/me`),
  save: (companyId: string, surface: UiLayoutSurface, layout: unknown, options?: { keepalive?: boolean }) =>
    api.put<UiLayoutPreference>(`/companies/${companyId}/ui-layouts/${surface}/me`, { layout }, options),
  reset: (companyId: string, surface: UiLayoutSurface) =>
    api.delete<UiLayoutPreference>(`/companies/${companyId}/ui-layouts/${surface}/me`),
};
