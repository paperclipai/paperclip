/**
 * LinkedIn posting client — the external-call surface used by the
 * linkedin-poster job. The agnb codebase posted to the LinkedIn UGC API
 * inline inside the route; that logic is consolidated here so the job stays
 * thin and the env gating lives in one place.
 *
 * Two modes:
 *   - Direct: LINKEDIN_ACCESS_TOKEN + LINKEDIN_AUTHOR_URN set → POST to UGC API.
 *   - Sidecar: LINKEDIN_SIDECAR_URL set → POST to a local sidecar that owns
 *     the session. Either satisfies `posterConfigured()`.
 *
 * If neither is configured, callers fall back to "manual" mode.
 */
const LI_API = "https://api.linkedin.com/v2/ugcPosts";

export function posterConfigured(): boolean {
  return (
    (!!process.env.LINKEDIN_ACCESS_TOKEN && !!process.env.LINKEDIN_AUTHOR_URN) ||
    !!process.env.LINKEDIN_SIDECAR_URL
  );
}

export interface PostResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/** Publish a text post to LinkedIn. Prefers the sidecar if configured. */
export async function postToLinkedIn(content: string): Promise<PostResult> {
  const sidecar = process.env.LINKEDIN_SIDECAR_URL?.replace(/\/$/, "");
  if (sidecar) return postViaSidecar(sidecar, content);

  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const author = process.env.LINKEDIN_AUTHOR_URN; // urn:li:person:... or urn:li:organization:...
  if (!token || !author) {
    return { ok: false, error: "LINKEDIN_* not set — manual mode" };
  }
  try {
    const r = await fetch(LI_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-restli-protocol-version": "2.0.0",
      },
      body: JSON.stringify({
        author,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: content },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, error: `linkedin http ${r.status}: ${txt.slice(0, 200)}` };
    }
    const j = await r.json();
    const postId = String(j?.id ?? "");
    const url = postId ? `https://www.linkedin.com/feed/update/${encodeURIComponent(postId)}` : undefined;
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function postViaSidecar(base: string, content: string): Promise<PostResult> {
  try {
    const r = await fetch(`${base}/api/post`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, error: `sidecar http ${r.status}: ${txt.slice(0, 200)}` };
    }
    const j = (await r.json().catch(() => ({}))) as { url?: string; post_url?: string };
    return { ok: true, url: j.url ?? j.post_url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
