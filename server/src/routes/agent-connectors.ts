import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentConnectors } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { forbidden, badRequest } from "../errors.js";
import { agentConnectorService, CONNECTOR_PROVIDERS, type ConnectorProvider } from "../services/agent-connectors.js";
import { assertCompanyAccess } from "./authz.js";

export function agentConnectorRoutes(db: Db) {
  const router = Router();
  const svc = agentConnectorService(db);

  // List all connectors for an agent
  router.get("/agents/:agentId/connectors", async (req, res) => {
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, agentId);

    const connectors = await svc.listByAgentId(agentId);
    
    // Return sanitized data (no tokens to browser)
    res.json(
      connectors.map((c) => ({
        id: c.id,
        agentId: c.agentId,
        connectorType: c.connectorType,
        provider: c.provider,
        displayName: c.displayName,
        scopes: c.scopes,
        providerData: c.providerData,
        status: c.status,
        errorMessage: c.errorMessage,
        connectedAt: c.connectedAt,
        updatedAt: c.updatedAt,
      })),
    );
  });

  // Get available connector providers
  router.get("/connectors/providers", async (req, res) => {
    // This is a public endpoint - just returns the available providers
    const providers = Object.values(CONNECTOR_PROVIDERS).map((p) => ({
      id: p.id,
      name: p.name,
      scopes: p.scopes,
    }));
    res.json(providers);
  });

  // Initiate OAuth flow - create pending connector
  router.post("/agents/:agentId/connectors", async (req, res) => {
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, agentId);

    const { provider, displayName } = req.body;
    if (!provider) {
      res.status(400).json({ error: "provider is required" });
      return;
    }

    const providerConfig = CONNECTOR_PROVIDERS[provider];
    if (!providerConfig) {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
      return;
    }

    // Create pending connector
    const connector = await svc.create({
      agentId,
      provider,
      displayName,
    });

    // Build OAuth authorization URL
    const clientId = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_ID`] || "";
    const redirectUri = `${req.protocol}://${req.get("host")}/api/agents/${agentId}/connectors/${connector.id}/callback`;
    
    const authParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: providerConfig.scopes.join(" "),
      state: connector.id,
    });

    const authUrl = `${providerConfig.authUrl}?${authParams.toString()}`;

    res.json({
      connectorId: connector.id,
      authUrl,
      status: "pending",
    });
  });

  // OAuth callback handler
  router.get("/agents/:agentId/connectors/:connectorId/callback", async (req, res) => {
    const { agentId, connectorId } = req.params;
    const { code, state, error } = req.query;

    assertCompanyAccess(req, agentId);

    // Verify state matches connector ID
    if (state !== connectorId) {
      res.status(400).json({ error: "Invalid state parameter" });
      return;
    }

    const connector = await svc.getById(connectorId);
    if (!connector || connector.agentId !== agentId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    if (error) {
      await svc.markError(connectorId, String(error));
      res.redirect(`/agents/${agentId}?connector_error=${encodeURIComponent(String(error))}`);
      return;
    }

    if (!code) {
      await svc.markError(connectorId, "No authorization code received");
      res.redirect(`/agents/${agentId}?connector_error=no_code`);
      return;
    }

    const providerConfig = CONNECTOR_PROVIDERS[connector.provider];
    if (!providerConfig) {
      await svc.markError(connectorId, "Unknown provider");
      res.redirect(`/agents/${agentId}?connector_error=unknown_provider`);
      return;
    }

    // Exchange code for tokens
    const clientId = process.env[`OAUTH_${connector.provider.toUpperCase()}_CLIENT_ID`] || "";
    const clientSecret = process.env[`OAUTH_${connector.provider.toUpperCase()}_CLIENT_SECRET`] || "";
    const redirectUri = `${req.protocol}://${req.get("host")}/api/agents/${agentId}/connectors/${connectorId}/callback`;

    try {
      const tokenResponse = await fetch(providerConfig.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: String(code),
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        await svc.markError(connectorId, `Token exchange failed: ${errText}`);
        res.redirect(`/agents/${agentId}?connector_error=token_exchange_failed`);
        return;
      }

      const tokens = await tokenResponse.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      // Calculate expiration time
      const tokenExpiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : undefined;

      // Mark as connected
      await svc.markConnected(connectorId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt,
        scopes: providerConfig.scopes,
      });

      res.redirect(`/agents/${agentId}?connector_connected=${connectorId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await svc.markError(connectorId, msg);
      res.redirect(`/agents/${agentId}?connector_error=${encodeURIComponent(msg)}`);
    }
  });

  // Delete a connector
  router.delete("/agents/:agentId/connectors/:connectorId", async (req, res) => {
    const agentId = req.params.agentId as string;
    const connectorId = req.params.connectorId as string;
    assertCompanyAccess(req, agentId);

    const connector = await svc.getById(connectorId);
    if (!connector || connector.agentId !== agentId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    await svc.delete(connectorId);
    res.json({ success: true });
  });

  // Revoke a connector (mark as revoked)
  router.post("/agents/:agentId/connectors/:connectorId/revoke", async (req, res) => {
    const agentId = req.params.agentId as string;
    const connectorId = req.params.connectorId as string;
    assertCompanyAccess(req, agentId);

    const connector = await svc.getById(connectorId);
    if (!connector || connector.agentId !== agentId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    await svc.update(connectorId, {
      status: "revoked",
      accessToken: undefined,
      refreshToken: undefined,
    });

    res.json({ success: true });
  });

  return router;
}
