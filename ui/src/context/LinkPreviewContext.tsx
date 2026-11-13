import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { LinkPreviewResult, LinkPreviewTarget } from "@paperclipai/shared";
import { api } from "@/api/client";

export interface LinkPreviewContextValue {
  companyId: string;
  userId: string | null;
  load: (target: LinkPreviewTarget) => Promise<LinkPreviewResult>;
}

const LinkPreviewContext = createContext<LinkPreviewContextValue | null>(null);

export function LinkPreviewProvider({ companyId, userId, children }: {
  companyId: string | null; userId: string | null; children: ReactNode;
}) {
  const value = useMemo<LinkPreviewContextValue | null>(() => companyId ? ({
    companyId, userId,
    load: target => api.get<LinkPreviewResult>(
      `/companies/${companyId}/link-preview?${new URLSearchParams({ url: target.canonicalUrl })}`,
      { timeoutMs: 6_000, cache: "no-store" },
    ),
  }) : null, [companyId, userId]);
  return <LinkPreviewContext.Provider value={value}>{children}</LinkPreviewContext.Provider>;
}

export function useLinkPreviewContext() { return useContext(LinkPreviewContext); }
