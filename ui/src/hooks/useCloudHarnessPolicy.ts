import { useMemo } from "react";
import { createCloudHarnessPolicy } from "@/lib/cloud-harness-policy";
import { useCloudInstance } from "./useCloudInstance";

export function useCloudHarnessPolicy() {
  const availableHarnesses = useCloudInstance()?.availableHarnesses;
  return useMemo(() => createCloudHarnessPolicy(availableHarnesses), [availableHarnesses]);
}
