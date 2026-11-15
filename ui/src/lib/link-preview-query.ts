import type { QueryFunctionContext } from "@tanstack/react-query";
import type { LinkPreviewResult, LinkPreviewTarget } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

export interface LinkPreviewLoader {
  companyId: string;
  userId: string | null;
  load: (target: LinkPreviewTarget) => Promise<LinkPreviewResult>;
}

/** Hover and deferred page work must share both the key and the query function. */
export function linkPreviewQueryOptions(context: LinkPreviewLoader, target: LinkPreviewTarget) {
  return {
    queryKey: queryKeys.linkPreview(context.companyId, context.userId, target.canonicalUrl),
    queryFn: async ({ client, queryKey }: QueryFunctionContext): Promise<LinkPreviewResult> => {
      try { return await context.load(target); } catch { return { preview: client.getQueryData<LinkPreviewResult>(queryKey)?.preview ?? null, maxAgeMs: 60_000 }; }
    },
    staleTime: (query: { state: { data?: LinkPreviewResult } }) => query.state.data?.maxAgeMs ?? 60_000,
    gcTime: 5 * 60_000,
    retry: false as const, refetchOnMount: false as const,
    refetchOnWindowFocus: false as const, refetchOnReconnect: false as const,
  };
}
