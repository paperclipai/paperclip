import { authApi } from "@/api/auth";

export interface UnauthenticatedLoginAdapterInput {
  nextPath?: string;
  companyId?: string | null;
}

export const unauthenticatedLoginAdapter = {
  async proceed(input: UnauthenticatedLoginAdapterInput = {}) {
    if (!input.companyId) {
      throw new Error("Unauthenticated development entry is disabled.");
    }

    const availability = await authApi.getUnauthenticatedLoginAvailability(input.companyId);
    if (!availability.available) {
      throw new Error("Unauthenticated development entry is disabled.");
    }
    await authApi.startUnauthenticatedLoginSession(input.companyId);
    const target = input.nextPath?.trim() || "/";
    window.location.assign(target);
  },
};
