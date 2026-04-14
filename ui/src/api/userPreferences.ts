import type { PatchUserPreferences, UserPreferences } from "@paperclipai/shared";
import { api } from "./client";

export const userPreferencesApi = {
  getCurrent: () => api.get<UserPreferences>("/user/preferences"),
  updateCurrent: (patch: PatchUserPreferences) =>
    api.patch<UserPreferences>("/user/preferences", patch),
};
