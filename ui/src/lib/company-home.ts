/**
 * The company home: where the app lands when no other page was asked for
 * (company root, company switch, a gated page whose flag is off).
 *
 * Dashboard is home by default. With the experimental Responsibilities flag
 * on, the Responsibilities overview is home and Dashboard moves to a
 * secondary position. This is the only place that decision is made.
 */
export const DASHBOARD_HOME_PATH = "/dashboard";
export const RESPONSIBILITIES_HOME_PATH = "/responsibilities";

export type CompanyHomePath = typeof DASHBOARD_HOME_PATH | typeof RESPONSIBILITIES_HOME_PATH;

/**
 * Company-relative home path, or `null` while the flag is still loading so
 * callers can wait instead of redirecting to the wrong page and back.
 */
export function resolveCompanyHomePath(flag: { enabled: boolean; loaded: boolean }): CompanyHomePath | null {
  if (!flag.loaded) return null;
  return flag.enabled ? RESPONSIBILITIES_HOME_PATH : DASHBOARD_HOME_PATH;
}
