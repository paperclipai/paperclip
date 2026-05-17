export interface UnauthenticatedLoginAdapter {
  proceed(input?: { nextPath?: string }): Promise<void>;
}

export function isUnauthenticatedDevelopmentLoginAvailable(): boolean {
  return import.meta.env.DEV;
}

export const unauthenticatedLoginAdapter: UnauthenticatedLoginAdapter = {
  async proceed(input = {}) {
    if (!isUnauthenticatedDevelopmentLoginAvailable()) {
      throw new Error("Unauthenticated development entry is only available in development mode.");
    }
    const target = input.nextPath?.trim() || "/";
    window.location.assign(target);
  },
};
