import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HostFeatureKey } from "@paperclipai/shared";
import { runtimeFeaturesApi } from "@/api/runtimeFeatures";
import { queryKeys } from "@/lib/queryKeys";

type RuntimeFeaturesContextValue = {
  hasFeature(feature: HostFeatureKey): boolean;
};

const RuntimeFeaturesContext = createContext<RuntimeFeaturesContextValue>({
  hasFeature: () => false,
});

export function RuntimeFeaturesProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: queryKeys.runtimeFeatures,
    queryFn: runtimeFeaturesApi.get,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const features = new Set(query.data?.hostFeatures ?? []);

  return (
    <RuntimeFeaturesContext.Provider value={{ hasFeature: (feature) => features.has(feature) }}>
      {children}
    </RuntimeFeaturesContext.Provider>
  );
}

export function useRuntimeFeatures() {
  return useContext(RuntimeFeaturesContext);
}
