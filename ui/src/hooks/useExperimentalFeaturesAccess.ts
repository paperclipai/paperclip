import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { isUiExperimentalModeEnabled } from "@/lib/experimental-features";
import { queryKeys } from "@/lib/queryKeys";

export function useExperimentalFeaturesAccess() {
  const experimentalModeEnabled = isUiExperimentalModeEnabled();
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: experimentalModeEnabled,
    retry: false,
  });

  const canViewExperimentalFeatures = Boolean(
    experimentalModeEnabled &&
      (boardAccessQuery.data?.isInstanceAdmin || boardAccessQuery.data?.source === "local_implicit"),
  );

  return {
    canViewExperimentalFeatures,
    experimentalModeEnabled,
    isLoading: experimentalModeEnabled && boardAccessQuery.isLoading,
  };
}
