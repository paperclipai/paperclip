import { createContext, useContext, useMemo, useLayoutEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createLinkPreviewPageLoader } from "@/lib/link-preview-page-loader";
import type { LinkPreviewBatchResult, LinkPreviewResult, LinkPreviewTarget } from "@paperclipai/shared";
import { api } from "@/api/client";

export interface LinkPreviewContextValue {
  companyId: string;
  userId: string | null;
  register?: (target: LinkPreviewTarget) => () => void;
  load: (target: LinkPreviewTarget) => Promise<LinkPreviewResult>;
}

const LinkPreviewContext = createContext<LinkPreviewContextValue | null>(null);

export function LinkPreviewProvider({ companyId, userId, children, autoLoad = true }: {
  companyId: string | null; userId: string | null; children: ReactNode; autoLoad?: boolean;
}) {
  const client = useQueryClient();
  const pageLoader = useRef<ReturnType<typeof createLinkPreviewPageLoader> | null>(null);
  const value = useMemo<LinkPreviewContextValue | null>(() => companyId ? ({
    companyId, userId,
    register: target => pageLoader.current?.register(target) ?? (() => {}),
    load: target => api.get<LinkPreviewResult>(
      `/companies/${companyId}/link-preview?${new URLSearchParams({ url: target.canonicalUrl })}`,
      { timeoutMs: 6_000, cache: "no-store" },
    ),
  }) : null, [companyId, userId, autoLoad]);
  // Link registration uses passive effects, after this layout effect initializes the registry.
  useLayoutEffect(() => {
    if (!value || !autoLoad) return;
    const loader = createLinkPreviewPageLoader(client, {
      ...value,
      readCached: targets => api.get<LinkPreviewBatchResult>(`/companies/${companyId}/link-previews/cached?${
        new URLSearchParams(targets.map(target => ["url", target.canonicalUrl]))
      }`, { timeoutMs: 6_000, cache: "no-store" }),
    });
    pageLoader.current = loader;
    return () => { loader.dispose(); if (pageLoader.current === loader) pageLoader.current = null; };
  }, [value, autoLoad, client, companyId]);
  return <LinkPreviewContext.Provider value={value}>{children}</LinkPreviewContext.Provider>;
}

export function useLinkPreviewContext() { return useContext(LinkPreviewContext); }
