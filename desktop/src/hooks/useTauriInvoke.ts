import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { tauriInvoke } from "@/api/tauri-client";

export function useTauriQuery<T>(
  queryKey: unknown[],
  command: string,
  args?: Record<string, unknown>,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">,
) {
  return useQuery<T, Error>({
    queryKey,
    queryFn: () => tauriInvoke<T>(command, args),
    ...options,
  });
}
