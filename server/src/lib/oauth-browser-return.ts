import type { Request } from "express";

// Some providers' consent pages navigate to this callback and, if their own
// page is still on screen ~2s later, replace it with a "you can close this
// window" screen (Railway does exactly this). Exchanging the code and
// discovering the tool catalog routinely takes longer than that, so the
// provider's timer wins and the browser never lands back in Paperclip even
// though the connection completed. For a cross-site browser navigation, commit
// a Paperclip document immediately and repeat the same request from it; the
// repeat is same-origin and does the slow work.
export function isCrossSiteOAuthCallbackNavigation(req: Request): boolean {
  return req.get("sec-fetch-site") === "cross-site"
    && req.get("sec-fetch-mode") === "navigate";
}

export function oauthCallbackInterstitialHtml(continuePath?: string): string {
  const attribute = (continuePath ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;");
  // A meta refresh alone, not a script as well: the OAuth code is single-use, so
  // two racing follow-ups would let the loser render an expired-state error.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="${continuePath === undefined ? "0" : `0;url=${attribute}`}"><title>Finishing connection</title></head><body><p>Finishing your connection…</p></body></html>`;
}

