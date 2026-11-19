import { useProviderLimitMessage } from "@/hooks/useProviderLimitMessage";

export function ProviderLimitMessage({ children }: { children: string }) {
  return useProviderLimitMessage(children);
}
