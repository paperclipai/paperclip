import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CompanyHomeRedirect } from "@/components/CompanyHomeRedirect";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Route guard for the experimental Cases feature (PAP-12947). Redirects to the
 * company home when `enableCases` is off.
 */
export function CasesExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (experimentalSettings?.enableCases !== true) {
    return <CompanyHomeRedirect />;
  }
  return <>{children}</>;
}
