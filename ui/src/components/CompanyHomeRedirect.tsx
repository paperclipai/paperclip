import { Navigate } from "@/lib/router";
import { useCompanyHomePath } from "@/hooks/useCompanyHomePath";

/**
 * Redirects to the company home (Dashboard, or Responsibilities when that
 * experiment is on). Renders nothing until the flag is known, so the user is
 * never sent to one home and then bounced to the other.
 *
 * `to` is company-relative; the router's `Navigate` applies the prefix.
 */
export function CompanyHomeRedirect() {
  const { path, loaded } = useCompanyHomePath();
  if (!loaded) return null;
  return <Navigate to={path} replace />;
}
