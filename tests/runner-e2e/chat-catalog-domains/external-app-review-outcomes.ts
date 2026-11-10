// Each phase's outcome (rejected, failed, executed) is graded from saved
// records: the card resolution, action request and invocation status, provider
// write counts and the trust rule. The reply must exist and must not point the
// person at a different app record: any app link it renders targets the
// reviewed connection on the app's own origin. Whether it names the app, and
// how it words the outcome, is left to a human reader.
export interface ReviewedConnection { id: string; name: string }

/** `origin` is the app's own origin: relative links and absolute links to it are equivalent. */
export function reviewReplyStaysOnRecord(reply: string, connection: ReviewedConnection | undefined, origin = "https://paperclip.invalid") {
  if (!connection?.id || !reply.trim()) return false;
  return [...reply.matchAll(/\]\(([^)\s]+)\)/g)].every(match => {
    let url: URL; try { url = new URL(match[1]!, origin); } catch { return false; }
    const app = /^\/[^/]+\/apps\/([^/]+)/.exec(url.pathname);
    if (url.origin !== new URL(origin).origin) return !/\/apps\//.test(url.pathname);
    return !app || app[1] === connection.id;
  });
}
