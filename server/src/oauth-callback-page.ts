import type { Request, Response } from "express";

export function escapeCallbackHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Standalone so a callback stays readable even when the app bundle cannot load. */
export function oauthCallbackPage(input: {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
  state?: "success" | "error" | "pending";
  head?: string;
  script?: string;
}): string {
  const escape = escapeCallbackHtml;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(input.title)} · Paperclip</title>${input.head ?? ""}<style>
:root{color-scheme:light dark;--bg:#faf9f6;--card:#fff;--text:#242320;--muted:#68665f;--line:#e5e3dc;--accent:#345d45}
@media(prefers-color-scheme:dark){:root{--bg:#191a18;--card:#22231f;--text:#f2f1eb;--muted:#b1b2a8;--line:#3b3d35;--accent:#a5d3b4}}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}main{width:100%;max-width:460px;padding:36px;background:var(--card);border:1px solid var(--line);border-radius:16px}.brand{font-weight:650;letter-spacing:-.03em;margin-bottom:36px}.mark{display:inline-block;margin-right:8px;color:var(--accent)}.status{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--line);border-radius:50%;font-size:24px;color:var(--accent)}h1{font-size:26px;line-height:1.25;letter-spacing:-.025em;margin:20px 0 12px}p{color:var(--muted);margin:0 0 28px}a{display:inline-block;background:var(--text);color:var(--card);padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.note{font-size:13px;margin:24px 0 0}@media(max-width:480px){main{padding:24px}}
</style></head><body><main><div class="brand"><span class="mark" aria-hidden="true">↗</span>Paperclip</div><div class="status" aria-hidden="true">${input.state === "success" ? "✓" : input.state === "error" ? "!" : "…"}</div><h1>${escape(input.title)}</h1><p>${escape(input.description)}</p>${input.actionHref && input.actionLabel ? `<a href="${escape(input.actionHref)}">${escape(input.actionLabel)}</a>` : ""}<p class="note">You can close this window and return to Paperclip.</p></main>${input.script ? `<script>${input.script}</script>` : ""}</body></html>`;
}

const callbackPaths = new Set([
  "/api/tools/oauth/callback",
  "/api/tools/oauth/cloud-connector/callback",
  "/api/tools/oauth/paperclip-id/callback",
  "/api/tools/oauth/cloud-connector/enrollment-callback",
  "/api/tools/vercel-connect/callback",
  "/api/slack/search/callback",
  "/api/chat-github/manifest/callback",
]);

/** Only browser callback failures change representation; API errors stay JSON. */
export function sendOAuthCallbackError(req: Request, res: Response, status: number): boolean {
  if (req.method !== "GET"
    || !callbackPaths.has(req.originalUrl.split("?")[0].replace(/\/$/, ""))
    || !req.get("accept")?.includes("text/html")) return false;
  const forbidden = status === 401 || status === 403;
  res.status(status).set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer").type("html").send(oauthCallbackPage({
    title: forbidden ? "Sign in to finish connecting" : "Connection could not be completed",
    description: forbidden
      ? "Return to Paperclip and sign in with the account that started this connection. Then try connecting again."
      : status >= 500
        ? "Something went wrong while finishing your connection. Return to Paperclip and try again."
        : "This connection request may have expired, already been used, or been cancelled. Return to Paperclip to start a new connection.",
    actionHref: "/", actionLabel: "Return to Paperclip", state: "error",
  }));
  return true;
}
