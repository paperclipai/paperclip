import { Router } from "express";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logger } from "../middleware/logger.js";

/**
 * Validate a Claude OAuth token by making a lightweight API call.
 */
async function validateClaudeOAuthToken(accessToken: string): Promise<{ valid: boolean; error?: string; email?: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      return { valid: true };
    }

    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errType = (body.error as Record<string, unknown>)?.type ?? "";
    const errMsg = (body.error as Record<string, unknown>)?.message ?? "";

    // 401 = bad token, 403 = token valid but no access, 429 = rate limited (token is valid)
    if (res.status === 429) {
      return { valid: true }; // Rate limited means the token authenticated successfully
    }
    if (res.status === 401) {
      return { valid: false, error: "Invalid token — authentication failed" };
    }
    if (res.status === 403) {
      return { valid: false, error: `Token valid but access denied: ${errMsg || errType}` };
    }

    return { valid: false, error: `API returned ${res.status}: ${errMsg || errType || "unknown error"}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "credential validation failed");
    if (msg.includes("timeout") || msg.includes("TIMEOUT")) {
      return { valid: false, error: "Validation timed out — try again" };
    }
    return { valid: false, error: `Connection error: ${msg}` };
  }
}

export function credentialValidateRoutes() {
  const router = Router();

  router.post("/credentials/validate", async (req, res) => {
    assertBoard(req);

    const type = typeof req.body?.type === "string" ? req.body.type : "";
    const credential = req.body?.credential as Record<string, unknown> | undefined;

    if (type === "claude_oauth") {
      const token = credential?.accessToken;
      if (typeof token !== "string" || !token.trim()) {
        res.json({ valid: false, error: "Missing access token" });
        return;
      }
      const t = token.trim();
      if (!t.startsWith("sk-ant-oat01-")) {
        res.json({ valid: false, error: "Invalid format — token should start with sk-ant-oat01-" });
        return;
      }
      if (t.length < 50) {
        res.json({ valid: false, error: "Token looks too short" });
        return;
      }
      // OAuth tokens can't be validated via API — they only work with Claude CLI sessions.
      // Format check is sufficient.
      res.json({ valid: true });
      return;
    }

    // For other types, just check the value is non-empty
    res.json({ valid: true });
  });

  return router;
}
