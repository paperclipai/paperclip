import type { ReactNode } from "react";
import { Navigate } from "@/lib/router";
import { useFeatures } from "@/hooks/useFeatures";

/**
 * Route guard for the experimental Cases feature (PAP-12947). Redirects to the
 * dashboard when `enableCases` is off, mirroring {@link PipelinesExperimentalGate}.
 */
export function CasesExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useFeatures();

  if (!isFetched) return null;
  if (experimentalSettings?.enableCases !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
