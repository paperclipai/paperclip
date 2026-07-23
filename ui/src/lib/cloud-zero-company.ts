export type CloudZeroCompanyState = "onboard" | "waiting" | "no_access";

/**
 * Decide what an authenticated user with a resolved board-access snapshot
 * should see. `null` = not a zero-company case; render the app (Layout
 * auto-opens onboarding when the companies list is empty).
 */
export function resolveCloudZeroCompanyState(access: {
  isInstanceAdmin: boolean;
  companyIds: string[];
  cloudStack?: { stackId: string; stackRole: "owner" | "admin" | "member" | "support" } | null;
}): CloudZeroCompanyState | null {
  if (access.isInstanceAdmin || access.companyIds.length > 0) return null;
  const stackRole = access.cloudStack?.stackRole;
  if (stackRole === "owner" || stackRole === "admin") return "onboard";
  if (stackRole === "member" || stackRole === "support") return "waiting";
  return "no_access";
}
