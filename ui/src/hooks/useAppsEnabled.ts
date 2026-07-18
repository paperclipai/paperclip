import { useFeatures } from "@/hooks/useFeatures";

export function useAppsEnabled() {
  const query = useFeatures();

  return {
    enabled: query.data?.enableApps === true,
    loaded: query.isFetched,
  };
}
