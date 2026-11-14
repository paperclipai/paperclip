import { useId, useMemo, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { PreviewCard } from "@base-ui/react/preview-card";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, TriangleAlert } from "lucide-react";
import type { LinkPreview as Preview, LinkPreviewResult, LinkPreviewState, LinkPreviewTarget } from "@paperclipai/shared";
import { useLinkPreviewContext, type LinkPreviewContextValue } from "@/context/LinkPreviewContext";
import { timeAgo } from "@/lib/timeAgo";
import { retryTransientOnly } from "@/lib/query-client";
import { queryKeys } from "@/lib/queryKeys";

export const linkPreviewStateLabel: Record<LinkPreviewState, string> = {
  unknown: "Status unknown", open: "Open", merged: "Merged", conflicts: "Merge conflicts", draft: "Draft", closed: "Closed",
};
export const linkPreviewStateIcon = {
  unknown: GitPullRequest, open: GitPullRequest, merged: GitMerge,
  conflicts: TriangleAlert, draft: GitPullRequestDraft, closed: GitPullRequestClosed,
};

function PreviewCardContents({ target, preview, loading }: { target: LinkPreviewTarget; preview?: Preview | null; loading: boolean }) {
  const state = preview?.state ?? "unknown";
  const Icon = linkPreviewStateIcon[state];
  const updated = preview?.updatedAt && Number.isFinite(Date.parse(preview.updatedAt)) ? preview.updatedAt : null;
  return <div className="flex min-w-0 flex-col gap-3" data-link-preview-state={state}>
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon aria-hidden="true" className="link-preview-status size-4 shrink-0" data-state={state} />
      <span className="min-w-0 break-all font-mono">{target.label}</span>
      {preview ? <span className="link-preview-status ml-auto shrink-0" data-state={state}>{linkPreviewStateLabel[state]}</span> : null}
    </div>
    {preview ? <>
      <p className="m-0 text-sm font-medium leading-snug">{preview.title}</p>
      {(preview.author || updated) ? <p className="m-0 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {preview.author ? <span>{preview.author}</span> : null}
        {updated ? <span>Updated <time className="font-mono" dateTime={updated} title={new Date(updated).toLocaleString()}>{timeAgo(updated)}</time></span> : null}
      </p> : null}
    </> : loading ? <p className="m-0 text-sm text-muted-foreground" role="status">Loading pull request…</p> : null}
    <span className="break-all font-mono text-xs text-muted-foreground">{target.canonicalUrl}</span>
  </div>;
}

function ConnectedLinkPreview({ context, target, children }: {
  context: LinkPreviewContextValue; target: LinkPreviewTarget;
  children: (preview: Preview | null, describedBy?: string) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  // Inline links can wrap: their union rectangle starts on a later line.
  // Anchor to the first line (the icon), never to the pointer or union box.
  const anchor = useMemo(() => ({
    getBoundingClientRect: () => triggerRef.current?.getClientRects()[0] ?? new DOMRect(),
    get contextElement() { return triggerRef.current ?? undefined; },
  }), []);
  const query = useQuery({
    queryKey: queryKeys.linkPreview(context.companyId, context.userId, target.canonicalUrl),
    // Optional enrichment: a failed read is a cached absence, not a global error.
    queryFn: async (): Promise<LinkPreviewResult> => {
      try { return await context.load(target); } catch { return { preview: null, maxAgeMs: 60_000 }; }
    },
    enabled: open,
    staleTime: query => query.state.data?.maxAgeMs ?? 60_000,
    gcTime: 5 * 60_000,
    retry: retryTransientOnly(0), refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  return <PreviewCard.Root open={open} onOpenChange={setOpen}>
    <PreviewCard.Trigger ref={triggerRef} delay={350} closeDelay={150}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      render={children(query.data?.preview ?? null, open ? id : undefined)} />
    <PreviewCard.Portal>
      <PreviewCard.Positioner anchor={anchor} align="start" side="bottom" className="z-50">
        <PreviewCard.Popup id={id} role="tooltip" className="link-preview-card">
          <PreviewCardContents target={target} preview={query.data?.preview} loading={query.isPending} />
        </PreviewCard.Popup>
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  </PreviewCard.Root>;
}

/** Shared by link renderers; without the app provider links stay entirely static. */
export function LinkPreview({ target, children }: {
  target: LinkPreviewTarget;
  children: (preview: Preview | null, describedBy?: string) => ReactElement;
}) {
  const context = useLinkPreviewContext();
  return context ? <ConnectedLinkPreview key={`${context.companyId}:${context.userId}:${target.canonicalUrl}`} context={context} target={target}>{children}</ConnectedLinkPreview> : children(null);
}
