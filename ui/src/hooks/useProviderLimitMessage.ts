import { useMemo } from "react";
import { usePageVisibility } from "@/lib/page-visibility";
import { formatProviderLimitMessage, providerLimitMessageResetAt } from "@/lib/provider-limit-message";
import { useSecondTick } from "./useSecondTick";

export function useProviderLimitClock(resetAt: number | null, fixedNow?: number, active = true): number {
  const now = fixedNow ?? Date.now();
  const { visible } = usePageVisibility();
  useSecondTick(active && visible && fixedNow === undefined && resetAt !== null && resetAt > now);
  return now;
}

export function useProviderLimitMessage(message: string, active = true): string {
  const resetAt = useMemo(() => providerLimitMessageResetAt(message), [message]);
  const now = useProviderLimitClock(resetAt, undefined, active);
  return formatProviderLimitMessage(message, now);
}
