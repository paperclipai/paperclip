import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CompanyHomeRedirect } from "@/components/CompanyHomeRedirect";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function StatusCardsExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (experimentalSettings?.enableStatusCards !== true) {
    return <CompanyHomeRedirect />;
  }
  return <>{children}</>;
}
