import type { ReactNode } from "react";
import { Navigate } from "@/lib/router";
import { useFeatures } from "@/hooks/useFeatures";

export function PipelinesExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useFeatures();

  if (!isFetched) return null;
  if (experimentalSettings?.enablePipelines !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
