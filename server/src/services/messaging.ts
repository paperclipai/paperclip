import type { Db } from "@paperclipai/db";
import {
  messagingConnectors,
  messagingChannels,
  messagingMessages,
  messagingWebhooks,
  messagingUserMappings,
  agents,
  companies,
} from "@paperclipai/db";
import { eq, and, or } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

export interface ConnectorConfig {
  [key: string]: unknown;
}

export interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface MessagePayload {
  direction: "inbound" | "outbound";
  senderIdentifier: string;
  senderName?: string;
  content: string;
  contentType?: "text" | "media" | "media_url";
  mediaUrl?: string;
  attachmentData?: Record<string, unknown>;
  platformMessageId?: string;
}

export class MessagingService {
  constructor(private db: Db) {}

  /**
   * Create a new messaging connector
   */
  async createConnector(
    companyId: string,
    platform: "telegram" | "whatsapp" | "slack" | "email",
    name: string,
    configuration: ConnectorConfig
  ) {
    try {
      const [connector] = await this.db
        .insert(messagingConnectors)
        .values({
          companyId,
          platform,
          name,
          configuration,
          status: "inactive", // Start as inactive until validated
        })
        .returning();

      logger.info(`Created messaging connector: ${connector.id} for company: ${companyId}`);
      return connector;
    } catch (error) {
      logger.error(`Failed to create messaging connector: ${error}`);
      throw error;
    }
  }

  /**
   * Update connector configuration
   */
  async updateConnector(
    connectorId: string,
    updates: {
      name?: string;
      configuration?: ConnectorConfig;
      status?: "active" | "inactive" | "error";
      errorMessage?: string | null;
      webhookUrl?: string | null;
      webhookSecret?: string | null;
    }
  ) {
    try {
      const [connector] = await this.db
        .update(messagingConnectors)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(messagingConnectors.id, connectorId))
        .returning();

      logger.info(`Updated messaging connector: ${connectorId}`);
      return connector;
    } catch (error) {
      logger.error(`Failed to update messaging connector: ${error}`);
      throw error;
    }
  }

  /**
   * Get connector by ID
   */
  async getConnector(connectorId: string) {
    try {
      const connector = await this.db.query.messagingConnectors.findFirst({
        where: eq(messagingConnectors.id, connectorId),
      });
      return connector;
    } catch (error) {
      logger.error(`Failed to get messaging connector: ${error}`);
      throw error;
    }
  }

  /**
   * List connectors by company
   */
  async listConnectorsByCompany(companyId: string) {
    try {
      const connectors = await this.db.query.messagingConnectors.findMany({
        where: eq(messagingConnectors.companyId, companyId),
      });
      return connectors;
    } catch (error) {
      logger.error(`Failed to list messaging connectors: ${error}`);
      throw error;
    }
  }

  /**
   * Delete connector
   */
  async deleteConnector(connectorId: string) {
    try {
      await this.db
        .delete(messagingConnectors)
        .where(eq(messagingConnectors.id, connectorId));
      logger.info(`Deleted messaging connector: ${connectorId}`);
    } catch (error) {
      logger.error(`Failed to delete messaging connector: ${error}`);
      throw error;
    }
  }

  /**
   * Create messaging channel for agent
   */
  async createChannel(
    connectorId: string,
    agentId: string,
    channelIdentifier: string,
    channelType?: "direct" | "group" | "channel",
    metadata?: Record<string, unknown>
  ) {
    try {
      const [channel] = await this.db
        .insert(messagingChannels)
        .values({
          connectorId,
          agentId,
          channelIdentifier,
          channelType,
          metadata,
          enabled: true,
        })
        .returning();

      logger.info(`Created messaging channel: ${channel.id} for agent: ${agentId}`);
      return channel;
    } catch (error) {
      logger.error(`Failed to create messaging channel: ${error}`);
      throw error;
    }
  }

  /**
   * Get channels for agent
   */
  async getChannelsForAgent(agentId: string) {
    try {
      const channels = await this.db.query.messagingChannels.findMany({
        where: eq(messagingChannels.agentId, agentId),
        with: {
          connector: true,
        },
      });
      return channels;
    } catch (error) {
      logger.error(`Failed to get channels for agent: ${error}`);
      throw error;
    }
  }

  /**
   * Get channels for connector
   */
  async getChannelsForConnector(connectorId: string) {
    try {
      const channels = await this.db.query.messagingChannels.findMany({
        where: eq(messagingChannels.connectorId, connectorId),
      });
      return channels;
    } catch (error) {
      logger.error(`Failed to get channels for connector: ${error}`);
      throw error;
    }
  }

  /**
   * Disable channel
   */
  async disableChannel(channelId: string) {
    try {
      const [channel] = await this.db
        .update(messagingChannels)
        .set({ enabled: false })
        .where(eq(messagingChannels.id, channelId))
        .returning();

      logger.info(`Disabled messaging channel: ${channelId}`);
      return channel;
    } catch (error) {
      logger.error(`Failed to disable messaging channel: ${error}`);
      throw error;
    }
  }

  /**
   * Store incoming or outgoing message
   */
  async storeMessage(
    channelId: string,
    agentId: string,
    messageData: MessagePayload
  ) {
    try {
      const [message] = await this.db
        .insert(messagingMessages)
        .values({
          channelId,
          agentId,
          direction: messageData.direction,
          platformMessageId: messageData.platformMessageId,
          senderIdentifier: messageData.senderIdentifier,
          senderName: messageData.senderName,
          content: messageData.content,
          contentType: messageData.contentType,
          mediaUrl: messageData.mediaUrl,
          attachmentData: messageData.attachmentData,
          status: messageData.direction === "outbound" ? "pending" : "delivered",
        })
        .returning();

      logger.info(`Stored message: ${message.id} in channel: ${channelId}`);
      return message;
    } catch (error) {
      logger.error(`Failed to store message: ${error}`);
      throw error;
    }
  }

  /**
   * Update message status
   */
  async updateMessageStatus(
    messageId: string,
    status: "pending" | "sent" | "delivered" | "read" | "failed",
    errorMessage?: string
  ) {
    try {
      const [message] = await this.db
        .update(messagingMessages)
        .set({
          status,
          errorMessage: errorMessage || null,
        })
        .where(eq(messagingMessages.id, messageId))
        .returning();

      logger.info(`Updated message status: ${messageId} -> ${status}`);
      return message;
    } catch (error) {
      logger.error(`Failed to update message status: ${error}`);
      throw error;
    }
  }

  /**
   * Get message history for channel
   */
  async getMessageHistory(channelId: string, limit: number = 50, offset: number = 0) {
    try {
      const messages = await this.db.query.messagingMessages.findMany({
        where: eq(messagingMessages.channelId, channelId),
        limit,
        offset,
        orderBy: (msgs, { desc }) => [desc(msgs.createdAt)],
      });
      return messages.reverse(); // Return in chronological order
    } catch (error) {
      logger.error(`Failed to get message history: ${error}`);
      throw error;
    }
  }

  /**
   * Record webhook event
   */
  async recordWebhookEvent(
    connectorId: string,
    webhookEvent: string,
    payload: Record<string, unknown>,
    status: "processed" | "failed" | "pending_retry" = "pending_retry",
    errorMessage?: string
  ) {
    try {
      const [webhook] = await this.db
        .insert(messagingWebhooks)
        .values({
          connectorId,
          webhookEvent,
          payload,
          status,
          errorMessage: errorMessage || null,
          retryCount: 0,
        })
        .returning();

      logger.info(`Recorded webhook event: ${webhook.id} for connector: ${connectorId}`);
      return webhook;
    } catch (error) {
      logger.error(`Failed to record webhook event: ${error}`);
      throw error;
    }
  }

  /**
   * Update webhook processing status
   */
  async updateWebhookStatus(
    webhookId: string,
    status: "processed" | "failed" | "pending_retry",
    errorMessage?: string
  ) {
    try {
      // Get current webhook to increment retry count
      const currentWebhook = await this.db.query.messagingWebhooks.findFirst({
        where: eq(messagingWebhooks.id, webhookId),
      });

      let newRetryCount = currentWebhook?.retryCount ?? 0;
      if (status === "pending_retry") {
        newRetryCount = (currentWebhook?.retryCount ?? 0) + 1;
      }

      const [webhook] = await this.db
        .update(messagingWebhooks)
        .set({
          status,
          errorMessage: errorMessage || null,
          processedAt: status === "processed" ? new Date() : null,
          retryCount: newRetryCount,
        })
        .where(eq(messagingWebhooks.id, webhookId))
        .returning();

      logger.info(`Updated webhook status: ${webhookId} -> ${status}`);
      return webhook;
    } catch (error) {
      logger.error(`Failed to update webhook status: ${error}`);
      throw error;
    }
  }

  /**
   * Map external user to agent
   */
  async mapUserToAgent(
    connectorId: string,
    externalUserId: string,
    agentId: string,
    externalMetadata?: Record<string, unknown>
  ) {
    try {
      const [mapping] = await this.db
        .insert(messagingUserMappings)
        .values({
          connectorId,
          externalUserId,
          agentId,
          externalMetadata,
        })
        .returning();

      logger.info(
        `Mapped external user ${externalUserId} to agent ${agentId} via connector ${connectorId}`
      );
      return mapping;
    } catch (error) {
      logger.error(`Failed to map user to agent: ${error}`);
      throw error;
    }
  }

  /**
   * Get agent for external user
   */
  async getAgentForExternalUser(connectorId: string, externalUserId: string) {
    try {
      const mapping = await this.db.query.messagingUserMappings.findFirst({
        where: and(
          eq(messagingUserMappings.connectorId, connectorId),
          eq(messagingUserMappings.externalUserId, externalUserId)
        ),
        with: {
          agent: true,
        },
      });
      return mapping?.agent;
    } catch (error) {
      logger.error(`Failed to get agent for external user: ${error}`);
      throw error;
    }
  }

  /**
   * Validate connector configuration based on platform
   */
  async validateConnectorConfig(
    platform: "telegram" | "whatsapp" | "slack" | "email",
    config: ConnectorConfig
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      switch (platform) {
        case "telegram":
          // Require botToken and chatId
          if (!config.botToken || typeof config.botToken !== "string") {
            return { valid: false, error: "Missing or invalid botToken" };
          }
          break;

        case "whatsapp":
          // Require phoneNumberId, accessToken, businessAccountId
          if (!config.phoneNumberId || !config.accessToken || !config.businessAccountId) {
            return {
              valid: false,
              error: "Missing phoneNumberId, accessToken, or businessAccountId",
            };
          }
          break;

        case "slack":
          // Require botToken or webhookUrl
          if (!config.botToken && !config.webhookUrl) {
            return {
              valid: false,
              error: "Missing botToken or webhookUrl",
            };
          }
          break;

        case "email":
          // Require smtpServer, smtpPort, senderEmail, senderPassword
          if (
            !config.smtpServer ||
            !config.smtpPort ||
            !config.senderEmail ||
            !config.senderPassword
          ) {
            return {
              valid: false,
              error: "Missing SMTP configuration (server, port, email, password)",
            };
          }
          break;

        default:
          return { valid: false, error: "Unknown platform" };
      }

      return { valid: true };
    } catch (error) {
      logger.error(`Failed to validate connector config: ${error}`);
      return { valid: false, error: "Validation failed" };
    }
  }

  /**
   * Send message via platform (implementation for each platform)
   */
  async sendMessage(
    connectorId: string,
    channelId: string,
    agentId: string,
    content: string
  ): Promise<{ success: boolean; platformMessageId?: string; error?: string }> {
    try {
      const connector = await this.getConnector(connectorId);
      if (!connector) {
        return { success: false, error: "Connector not found" };
      }

      const channel = await this.db.query.messagingChannels.findFirst({
        where: eq(messagingChannels.id, channelId),
      });
      if (!channel) {
        return { success: false, error: "Channel not found" };
      }

      // Store message first
      const message = await this.storeMessage(channelId, agentId, {
        direction: "outbound",
        senderIdentifier: agentId,
        senderName: "Agent",
        content,
        contentType: "text",
      });

      // Platform-specific sending logic
      let platformMessageId: string | undefined;
      try {
        switch (connector.platform) {
          case "telegram":
            // platformMessageId = await this.sendTelegramMessage(...);
            platformMessageId = `tg-${message.id}`;
            break;
          case "whatsapp":
            // platformMessageId = await this.sendWhatsAppMessage(...);
            platformMessageId = `wa-${message.id}`;
            break;
          case "slack":
            // platformMessageId = await this.sendSlackMessage(...);
            platformMessageId = `slack-${message.id}`;
            break;
          case "email":
            // platformMessageId = await this.sendEmailMessage(...);
            platformMessageId = `email-${message.id}`;
            break;
        }

        // Update message with platform message ID
        await this.updateMessageStatus(message.id, "sent");

        logger.info(`Message sent via ${connector.platform}: ${platformMessageId}`);
        return { success: true, platformMessageId };
      } catch (error) {
        // Mark as failed
        await this.updateMessageStatus(message.id, "failed", String(error));
        return { success: false, error: String(error) };
      }
    } catch (error) {
      logger.error(`Failed to send message: ${error}`);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get unread messages for channel
   */
  async getUnreadMessages(channelId: string) {
    try {
      const messages = await this.db.query.messagingMessages.findMany({
        where: and(
          eq(messagingMessages.channelId, channelId),
          eq(messagingMessages.direction, "inbound"),
          or(
            eq(messagingMessages.status, "pending"),
            eq(messagingMessages.status, "delivered")
          )
        ),
      });
      return messages;
    } catch (error) {
      logger.error(`Failed to get unread messages: ${error}`);
      throw error;
    }
  }
}

/**
 * Factory function to create MessagingService
 */
export function createMessagingService(db: Db): MessagingService {
  return new MessagingService(db);
}
