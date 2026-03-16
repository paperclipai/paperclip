import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createMessagingService } from "../services/messaging.js";
import { logger } from "../middleware/logger.js";
import { eq } from "drizzle-orm";
import { agents } from "@paperclipai/db";

export function messagingRoutes(db: Db) {
  const router = Router({ mergeParams: true });

  // Middleware to check company access
  const checkCompanyAccess = async (req: Request, res: Response, next: Function) => {
    try {
      const companyId = (req.params as any).companyId as string;
      const companyIds = ((req.actor as any).companyIds || []) as string[];

      if (!companyIds.includes(companyId)) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      next();
    } catch (error) {
      logger.error(`Middleware error: ${error}`);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  // Middleware to check agent access
  const checkAgentAccess = async (req: Request, res: Response, next: Function) => {
    try {
      const agentId = (req.params as any).agentId as string;
      const companyIds = ((req.actor as any).companyIds || []) as string[];

      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });

      if (!agent || !companyIds.includes(agent.companyId)) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      next();
    } catch (error) {
      logger.error(`Middleware error: ${error}`);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  // ============ CONNECTOR ROUTES ============

  router.post(
    "/companies/:companyId/messaging/connectors",
    checkCompanyAccess,
    async (req: Request, res: Response) => {
      try {
        const companyId = (req.params as any).companyId as string;
        const { platform, name, configuration } = req.body;

        if (!platform || !name || !configuration) {
          return res
            .status(400)
            .json({ error: "Missing required fields: platform, name, configuration" });
        }

        const messagingService = createMessagingService(db);

        const validation = await messagingService.validateConnectorConfig(
          platform as "telegram" | "whatsapp" | "slack" | "email",
          configuration
        );
        if (!validation.valid) {
          return res.status(400).json({ error: validation.error });
        }

        const connector = await messagingService.createConnector(
          companyId,
          platform,
          name,
          configuration
        );

        res.status(201).json(connector);
      } catch (error) {
        logger.error(`Failed to create connector: ${error}`);
        res.status(500).json({ error: "Failed to create connector" });
      }
    }
  );

  router.get(
    "/companies/:companyId/messaging/connectors",
    checkCompanyAccess,
    async (req: Request, res: Response) => {
      try {
        const companyId = (req.params as any).companyId as string;
        const messagingService = createMessagingService(db);

        const connectors = await messagingService.listConnectorsByCompany(companyId);
        res.json(connectors);
      } catch (error) {
        logger.error(`Failed to list connectors: ${error}`);
        res.status(500).json({ error: "Failed to list connectors" });
      }
    }
  );

  router.get(
    "/companies/:companyId/messaging/connectors/:connectorId",
    checkCompanyAccess,
    async (req: Request, res: Response) => {
      try {
        const connectorId = (req.params as any).connectorId as string;
        const messagingService = createMessagingService(db);

        const connector = await messagingService.getConnector(connectorId);
        if (!connector) {
          return res.status(404).json({ error: "Connector not found" });
        }

        res.json(connector);
      } catch (error) {
        logger.error(`Failed to get connector: ${error}`);
        res.status(500).json({ error: "Failed to get connector" });
      }
    }
  );

  router.patch(
    "/companies/:companyId/messaging/connectors/:connectorId",
    checkCompanyAccess,
    async (req: Request, res: Response) => {
      try {
        const connectorId = (req.params as any).connectorId as string;
        const { name, configuration, status } = req.body;

        const messagingService = createMessagingService(db);

        const connector = await messagingService.getConnector(connectorId);
        if (!connector) {
          return res.status(404).json({ error: "Connector not found" });
        }

        if (configuration) {
          const validation = await messagingService.validateConnectorConfig(
            connector.platform as any,
            configuration
          );
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        const updated = await messagingService.updateConnector(connectorId, {
          name,
          configuration,
          status,
        });

        res.json(updated);
      } catch (error) {
        logger.error(`Failed to update connector: ${error}`);
        res.status(500).json({ error: "Failed to update connector" });
      }
    }
  );

  router.delete(
    "/companies/:companyId/messaging/connectors/:connectorId",
    checkCompanyAccess,
    async (req: Request, res: Response) => {
      try {
        const connectorId = (req.params as any).connectorId as string;
        const messagingService = createMessagingService(db);

        const connector = await messagingService.getConnector(connectorId);
        if (!connector) {
          return res.status(404).json({ error: "Connector not found" });
        }

        await messagingService.deleteConnector(connectorId);
        res.status(204).send();
      } catch (error) {
        logger.error(`Failed to delete connector: ${error}`);
        res.status(500).json({ error: "Failed to delete connector" });
      }
    }
  );

  // ============ CHANNEL ROUTES ============

  router.post(
    "/agents/:agentId/messaging/channels",
    checkAgentAccess,
    async (req: Request, res: Response) => {
      try {
        const agentId = (req.params as any).agentId as string;
        const { connectorId, channelIdentifier, channelType, metadata } = req.body;

        if (!connectorId || !channelIdentifier) {
          return res
            .status(400)
            .json({ error: "Missing required fields: connectorId, channelIdentifier" });
        }

        const messagingService = createMessagingService(db);

        const channel = await messagingService.createChannel(
          connectorId,
          agentId,
          channelIdentifier,
          channelType,
          metadata
        );

        res.status(201).json(channel);
      } catch (error) {
        logger.error(`Failed to create channel: ${error}`);
        res.status(500).json({ error: "Failed to create channel" });
      }
    }
  );

  router.get(
    "/agents/:agentId/messaging/channels",
    checkAgentAccess,
    async (req: Request, res: Response) => {
      try {
        const agentId = (req.params as any).agentId as string;
        const messagingService = createMessagingService(db);

        const channels = await messagingService.getChannelsForAgent(agentId);
        res.json(channels);
      } catch (error) {
        logger.error(`Failed to get channels: ${error}`);
        res.status(500).json({ error: "Failed to get channels" });
      }
    }
  );

  router.delete(
    "/agents/:agentId/messaging/channels/:channelId",
    checkAgentAccess,
    async (req: Request, res: Response) => {
      try {
        const channelId = (req.params as any).channelId as string;
        const messagingService = createMessagingService(db);

        const channel = await messagingService.disableChannel(channelId);
        res.json(channel);
      } catch (error) {
        logger.error(`Failed to disable channel: ${error}`);
        res.status(500).json({ error: "Failed to disable channel" });
      }
    }
  );

  // ============ MESSAGE ROUTES ============

  router.get(
    "/agents/:agentId/messaging/channels/:channelId/messages",
    checkAgentAccess,
    async (req: Request, res: Response) => {
      try {
        const channelId = (req.params as any).channelId as string;
        const { limit = "50", offset = "0" } = req.query;

        const messagingService = createMessagingService(db);

        const messages = await messagingService.getMessageHistory(
          channelId,
          parseInt(limit as string),
          parseInt(offset as string)
        );

        res.json(messages);
      } catch (error) {
        logger.error(`Failed to get message history: ${error}`);
        res.status(500).json({ error: "Failed to get message history" });
      }
    }
  );

  router.post(
    "/agents/:agentId/messaging/channels/:channelId/send",
    checkAgentAccess,
    async (req: Request, res: Response) => {
      try {
        const agentId = (req.params as any).agentId as string;
        const channelId = (req.params as any).channelId as string;
        const { connectorId, content } = req.body;

        if (!connectorId || !content) {
          return res
            .status(400)
            .json({ error: "Missing required fields: connectorId, content" });
        }

        const messagingService = createMessagingService(db);

        const result = await messagingService.sendMessage(
          connectorId,
          channelId,
          agentId,
          content
        );

        if (result.success) {
          res.json({ success: true, platformMessageId: result.platformMessageId });
        } else {
          res.status(500).json({ error: result.error });
        }
      } catch (error) {
        logger.error(`Failed to send message: ${error}`);
        res.status(500).json({ error: "Failed to send message" });
      }
    }
  );

  router.get(
    "/agents/:agentId/messaging/channels/:channelId/unread",
    checkAgentAccess,
    async (req: Request, res: Response) => {
      try {
        const channelId = (req.params as any).channelId as string;
        const messagingService = createMessagingService(db);

        const messages = await messagingService.getUnreadMessages(channelId);
        res.json(messages);
      } catch (error) {
        logger.error(`Failed to get unread messages: ${error}`);
        res.status(500).json({ error: "Failed to get unread messages" });
      }
    }
  );

  // ============ WEBHOOK ROUTES ============

  router.post(
    "/messaging/webhooks/:connectorId/telegram",
    async (req: Request, res: Response) => {
      try {
        const connectorId = (req.params as any).connectorId as string;
        const payload = req.body;

        const messagingService = createMessagingService(db);

        await messagingService.recordWebhookEvent(
          connectorId,
          "telegram.message",
          payload,
          "processed"
        );

        // TODO: Process Telegram message (parse, route to agent, etc.)

        res.json({ ok: true });
      } catch (error) {
        logger.error(`Failed to process Telegram webhook: ${error}`);
        res.status(500).json({ error: "Failed to process webhook" });
      }
    }
  );

  router.post(
    "/messaging/webhooks/:connectorId/whatsapp",
    async (req: Request, res: Response) => {
      try {
        const connectorId = (req.params as any).connectorId as string;
        const payload = req.body;

        const messagingService = createMessagingService(db);

        await messagingService.recordWebhookEvent(
          connectorId,
          "whatsapp.message",
          payload,
          "processed"
        );

        // TODO: Process WhatsApp message

        res.json({ ok: true });
      } catch (error) {
        logger.error(`Failed to process WhatsApp webhook: ${error}`);
        res.status(500).json({ error: "Failed to process webhook" });
      }
    }
  );

  router.post(
    "/messaging/webhooks/:connectorId/slack",
    async (req: Request, res: Response) => {
      try {
        const connectorId = (req.params as any).connectorId as string;
        const payload = req.body;

        const messagingService = createMessagingService(db);

        await messagingService.recordWebhookEvent(
          connectorId,
          "slack.message",
          payload,
          "processed"
        );

        // TODO: Process Slack message

        res.json({ ok: true });
      } catch (error) {
        logger.error(`Failed to process Slack webhook: ${error}`);
        res.status(500).json({ error: "Failed to process webhook" });
      }
    }
  );

  return router;
}
