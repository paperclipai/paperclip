import { Router } from "express";
import crypto from "node:crypto";
import {
  setGitHubUserToken,
  getGitHubUserToken,
  clearGitHubUserToken,
  getGitHubUserTokenInfo,
} from "../services/github-user-token.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

function popupClosePage(status: "success" | "error", message?: string): string {
  const text = status === "success" ? "GitHub connected. This window will close." : `Error: ${message ?? "Unknown error"}`;
  return `<!DOCTYPE html><html><body><p>${text}</p><script>window.close();</script></body></html>`;
}

const pendingStates = new Map<string, { createdAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingStates) {
    if (now - value.createdAt > 600_000) pendingStates.delete(key);
  }
}, 300_000);

export function githubOAuthRoutes() {
  const router = Router();

  // GET /oauth/github/start — redirect to GitHub authorize page
  router.get("/oauth/github/start", (_req, res) => {
    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    if (!clientId) {
      res.status(500).json({ error: "GitHub OAuth not configured (GITHUB_OAUTH_CLIENT_ID)" });
      return;
    }

    const state = crypto.randomBytes(32).toString("hex");
    pendingStates.set(state, { createdAt: Date.now() });

    const redirectUri = `${_req.protocol}://${_req.get("host")}/oauth/github/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "repo,read:org",
      state,
    });

    res.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
  });

  // GET /oauth/github/callback — exchange code for token
  router.get("/oauth/github/callback", async (req, res) => {
    const { code, state, error: ghError } = req.query as Record<string, string>;

    if (ghError) {
      res.send(popupClosePage("error", ghError));
      return;
    }

    if (!state || !pendingStates.has(state)) {
      res.send(popupClosePage("error", "Invalid or expired state parameter"));
      return;
    }
    pendingStates.delete(state);

    if (!code) {
      res.send(popupClosePage("error", "Missing authorization code"));
      return;
    }

    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.send(popupClosePage("error", "GitHub OAuth not configured"));
      return;
    }

    try {
      const redirectUri = `${req.protocol}://${req.get("host")}/oauth/github/callback`;
      const tokenRes = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });

      const body = (await tokenRes.json()) as {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (body.error || !body.access_token) {
        const msg = body.error_description ?? body.error ?? "Token exchange failed";
        res.send(popupClosePage("error", msg));
        return;
      }

      setGitHubUserToken(body.access_token, body.scope ?? "");
      res.send(popupClosePage("success"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Token exchange failed";
      res.send(popupClosePage("error", msg));
    }
  });

  return router;
}

export function githubApiRoutes() {
  const router = Router();

  router.get("/github/status", (_req, res) => {
    res.json(getGitHubUserTokenInfo());
  });

  router.post("/github/disconnect", (_req, res) => {
    clearGitHubUserToken();
    res.json({ disconnected: true });
  });

  router.get("/github/repos", async (req, res) => {
    const token = getGitHubUserToken();
    if (!token) {
      res.status(401).json({ error: "GitHub not connected" });
      return;
    }

    const q = (req.query.q as string || "").trim();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 30));

    try {
      let url: string;
      if (q) {
        url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+in:name+fork:true&per_page=${perPage}&page=${page}&sort=updated`;
      } else {
        url = `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,organization_member,collaborator`;
      }

      const ghRes = await fetch(url, {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      });

      if (!ghRes.ok) {
        res.status(ghRes.status).json({ error: `GitHub API error: ${ghRes.status}` });
        return;
      }

      const body = await ghRes.json() as unknown;
      const repos = Array.isArray(body) ? body : (body as { items?: unknown[] }).items ?? [];

      const mapped = (repos as Array<{
        full_name: string;
        name: string;
        owner: { login: string; avatar_url: string };
        private: boolean;
        description: string | null;
        html_url: string;
        default_branch: string;
        updated_at: string;
      }>).map((r) => ({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        ownerAvatar: r.owner.avatar_url,
        private: r.private,
        description: r.description,
        htmlUrl: r.html_url,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
      }));

      res.json({ repos: mapped, page, perPage });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch repos" });
    }
  });

  return router;
}
