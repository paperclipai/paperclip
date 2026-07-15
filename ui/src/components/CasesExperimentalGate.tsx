import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Route guard for the experimental Cases feature (PAP-12947). Redirects to the
 * dashboard when `enableCases` is off, mirroring {@link PipelinesExperimentalGate}.
 */
export function CasesExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (experimentalSettings?.enableCases !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
