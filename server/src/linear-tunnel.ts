/**
 * Cloudflare Tunnel + Linear webhook auto-registration.
 *
 * On startup (if Linear is connected):
 * 1. Starts a cloudflared quick tunnel
 * 2. Parses the public URL from cloudflared output
 * 3. Creates or updates a Linear webhook pointing to /api/auth/linear/webhook
 * 4. Tears down tunnel + deletes webhook on shutdown
 *
 * Requires OAuth token with admin scope for webhook CRUD.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "./middleware/logger.js";

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let linearWebhookId: string | null = null;

export async function startLinearTunnel(opts: {
  port: number;
  linearToken: string;
  teamId: string;
}): Promise<string | null> {
  // Check if cloudflared is available
  try {
    const which = spawn("which", ["cloudflared"]);
    const available = await new Promise<boolean>((resolve) => {
      which.on("exit", (code) => resolve(code === 0));
      which.on("error", () => resolve(false));
    });
    if (!available) {
      logger.info("[linear-tunnel] cloudflared not found, skipping tunnel setup");
      return null;
    }
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${opts.port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    tunnelProcess = child;

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logger.warn("[linear-tunnel] timed out waiting for tunnel URL");
        resolve(null);
      }
    }, 15_000);

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelUrl = match[0];
        logger.info({ url: tunnelUrl }, "[linear-tunnel] tunnel started");

        void registerLinearWebhook(tunnelUrl, opts.linearToken, opts.teamId)
          .then((webhookId) => {
            linearWebhookId = webhookId;
            if (webhookId) {
              logger.info({ webhookId, url: `${tunnelUrl}/api/auth/linear/webhook` }, "[linear-tunnel] Linear webhook registered");
            } else {
              logger.warn("[linear-tunnel] webhook registration failed — re-authenticate Linear to grant admin scope");
            }
          })
          .catch((err) => {
            logger.warn({ err }, "[linear-tunnel] failed to register webhook");
          });

        resolve(tunnelUrl);
      }
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        logger.warn({ err }, "[linear-tunnel] cloudflared failed to start");
        resolve(null);
      }
    });

    child.on("exit", () => {
      tunnelProcess = null;
      tunnelUrl = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
  });
}

async function registerLinearWebhook(
  publicUrl: string,
  token: string,
  teamId: string,
): Promise<string | null> {
  const webhookUrl = `${publicUrl}/api/auth/linear/webhook`;
  const label = "Paperclip Sync (auto)";

  // Find existing Paperclip webhook to update
  try {
    const listRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query { webhooks { nodes { id label url enabled } } }`,
      }),
    });

    if (listRes.ok) {
      const listData = (await listRes.json()) as {
        data?: { webhooks?: { nodes?: Array<{ id: string; label: string; url: string; enabled: boolean }> } };
      };
      const existing = listData.data?.webhooks?.nodes?.find(
        (w) => w.label === label || w.url.includes("/api/auth/linear/webhook"),
      );

      if (existing) {
        const updateRes = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `mutation($id: String!, $input: WebhookUpdateInput!) {
              webhookUpdate(id: $id, input: $input) { webhook { id url } }
            }`,
            variables: { id: existing.id, input: { url: webhookUrl, enabled: true } },
          }),
        });
        if (updateRes.ok) {
          logger.info({ id: existing.id }, "[linear-tunnel] updated existing webhook URL");
          return existing.id;
        }
      }
    }
  } catch {
    // Fall through to create
  }

  // Create new webhook
  try {
    const createRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: WebhookCreateInput!) {
          webhookCreate(input: $input) { webhook { id url } }
        }`,
        variables: {
          input: {
            url: webhookUrl,
            label,
            teamId,
            resourceTypes: ["Issue", "Comment", "IssueLabel"],
            enabled: true,
          },
        },
      }),
    });

    if (createRes.ok) {
      const data = (await createRes.json()) as {
        data?: { webhookCreate?: { webhook?: { id: string } } };
        errors?: Array<{ message: string }>;
      };
      if (data.errors?.length) {
        logger.warn({ errors: data.errors }, "[linear-tunnel] webhook create failed");
        return null;
      }
      const id = data.data?.webhookCreate?.webhook?.id ?? null;
      if (id) logger.info({ id }, "[linear-tunnel] created new webhook");
      return id;
    }
  } catch (err) {
    logger.warn({ err }, "[linear-tunnel] webhook create request failed");
  }

  return null;
}

/**
 * Stop the tunnel and delete the Linear webhook.
 */
export async function stopLinearTunnel(linearToken?: string): Promise<void> {
  // Delete the webhook (clean up)
  if (linearWebhookId && linearToken) {
    try {
      await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { Authorization: linearToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation($id: String!) {
            webhookDelete(id: $id) { success }
          }`,
          variables: { id: linearWebhookId },
        }),
      });
      logger.info("[linear-tunnel] Linear webhook deleted");
    } catch {
      // Best effort
    }
    linearWebhookId = null;
  }

  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    tunnelUrl = null;
    logger.info("[linear-tunnel] tunnel stopped");
  }
}

export function getTunnelUrl(): string | null {
  return tunnelUrl;
}

/**
 * Register or update webhook using a specific token (e.g. after reconnecting Linear).
 */
export async function registerWebhookWithToken(
  publicUrl: string,
  token: string,
  teamId: string,
): Promise<void> {
  const id = await registerLinearWebhook(publicUrl, token, teamId);
  if (id) {
    linearWebhookId = id;
    logger.info({ webhookId: id, url: `${publicUrl}/api/auth/linear/webhook` }, "[linear-tunnel] webhook registered after reconnect");
  }
}
