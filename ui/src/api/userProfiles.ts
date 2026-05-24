import type { UserProfileResponse } from "@valadrien-os/shared";
import { api } from "./client";

export const userProfilesApi = {
  get: (companyId: string, userSlug: string) =>
    api.get<UserProfileResponse>(
      `/companies/${companyId}/users/${encodeURIComponent(userSlug)}/profile`,
    ),
};
