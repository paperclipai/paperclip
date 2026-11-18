import { DASHBOARD_HOME_PATH, resolveCompanyHomePath, type CompanyHomePath } from "@/lib/company-home";
import { useResponsibilitiesEnabled } from "./useResponsibilitiesEnabled";

/**
 * The company-relative home path (`/dashboard` or `/responsibilities`).
 *
 * `path` falls back to Dashboard while the flag loads so links always have a
 * target; redirects should wait for `loaded` (or use `CompanyHomeRedirect`)
 * to avoid landing on Dashboard and then jumping to Responsibilities.
 */
export function useCompanyHomePath(): { path: CompanyHomePath; loaded: boolean; error: unknown; retry: () => void } {
  const flag = useResponsibilitiesEnabled();
  const resolved = resolveCompanyHomePath(flag);
  return { path: resolved ?? DASHBOARD_HOME_PATH, loaded: resolved !== null, error: flag.error, retry: flag.retry };
}
