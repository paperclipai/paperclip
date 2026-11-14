/** Host-owned link metadata. Providers do not supply markup or fetch URLs. */
export interface LinkPreviewTarget {
  provider: string;
  kind: string;
  canonicalUrl: string;
  label: string;
}

export type LinkPreviewState = "unknown" | "open" | "draft" | "merged" | "closed" | "conflicts";

export interface LinkPreview {
  target: LinkPreviewTarget;
  title: string;
  state: LinkPreviewState;
  author: string | null;
  updatedAt: string | null;
}

export interface LinkPreviewResult {
  preview: LinkPreview | null;
  /** Demand-driven cache lifetime; this does not schedule a refresh. */
  maxAgeMs: number;
}

/** Recognition only. Never contacts a remote service or changes navigation. */
export function recognizeLinkPreview(href: string | null | undefined): LinkPreviewTarget | null {
  if (!href || href.length > 2048) return null;
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)
    || url.username || url.password || url.port) return null;
  const match = /^\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)(?:\/|$)/i.exec(url.pathname);
  if (!match || match[2] === "." || match[2] === ".." || !Number.isSafeInteger(Number(match[3]))) return null;
  const [, owner, repo, number] = match;
  return {
    provider: "github",
    kind: "pull_request",
    canonicalUrl: `https://github.com/${owner!.toLowerCase()}/${repo!.toLowerCase()}/pull/${number}`,
    label: `${owner}/${repo}#${number}`,
  };
}
