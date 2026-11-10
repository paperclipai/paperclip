// Each phase's outcome (rejected, failed, executed) is graded from saved
// records: the card resolution, action request and invocation status, provider
// write counts and the trust rule. The reply is graded only for naming the
// record it reports on: the saved connection by its saved name, or a link to
// that connection's app page. Its wording is never matched.
export interface ReviewedConnection { id: string; name: string }

/** `origin` is the app's own origin: relative links and absolute links to it are equivalent. */
export function reviewReplyNamesRecord(reply: string, connection: ReviewedConnection | undefined, origin = "https://paperclip.invalid") {
  if (!connection?.id || !connection.name?.trim() || !reply.trim()) return false;
  const named = reply.replace(/[*_`]/g, "").includes(connection.name.trim());
  const linked = [...reply.matchAll(/\]\(([^)\s]+)\)/g)].some(match => {
    try { const url = new URL(match[1]!, origin);
      return url.origin === new URL(origin).origin && new RegExp(`^/[^/]+/apps/${connection.id}(?:/|$)`).test(url.pathname); } catch { return false; }
  });
  return named || linked;
}
