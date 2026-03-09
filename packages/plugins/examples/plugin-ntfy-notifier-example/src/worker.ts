import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const METRIC_SENT = "ntfy_notifications_sent";
const METRIC_FAILED = "ntfy_notification_failures";

// --- Utilities ---

/**
 * Ensures a value is a string, or returns an empty string.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Ensures a value is an array of strings.
 */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Ensures a value is an integer, or returns a fallback value.
 */
function asInt(value: unknown, fallback: number): number {
  const n = parseInt(String(value), 10);
  return isNaN(n) ? fallback : n;
}

/**
 * Strongly-typed plugin configuration based on the manifest schema.
 */
interface PluginConfig {
  /** The ntfy topic name to publish to. */
  topic: string;
  /** The ntfy server URL (e.g., https://ntfy.sh). */
  serverUrl: string;
  /** Secret reference for the auth token. */
  tokenRef: string;
  /** List of allowed event types. Empty means all are allowed. */
  allowlist: string[];
  /** Default notification priority (1-5). */
  defaultPriority: number;
  /** Tags to include in every notification. */
  defaultTags: string[];
}

/**
 * Notification parameters for a specific event type.
 */
interface NotificationParams {
  /** Function to generate the notification body text from the event. */
  text: (event: any) => string;
  /** The title of the ntfy notification. */
  title: string;
  /** The priority level (1=min, 5=urgent). */
  priority: number;
  /** Emojis or tags for the notification. */
  tags: string[];
}

// --- Constants ---

/**
 * Standard titles for different notification categories.
 */
const TITLES = {
  AGENT_ACTIVITY: "Paperclip Agent Activity",
  AGENT_ALERT: "Paperclip Agent Alert",
  AGENT_STATUS: "Paperclip Agent Status",
  ISSUE_UPDATE: "Paperclip Issue Update",
  APPROVAL: "Paperclip Approval",
};

/**
 * Common reusable emoji tags for ntfy.
 */
const TAGS = {
  ROBOT: "robot_face",
  WARNING: "warning",
  CHECK: "ballot_box_with_check",
};

/**
 * The ntfy.sh Notifier Example Plugin worker implementation.
 * 
 * This plugin subscribes to various Paperclip domain events (agent runs, issue updates, approvals)
 * and sends formatted notifications to an ntfy.sh topic or a custom ntfy server.
 * 
 * It demonstrates:
 * 1. Event subscription via `ctx.events.on`.
 * 2. Configuration access via `ctx.config.get`.
 * 3. Outbound HTTP requests via `ctx.http.fetch`.
 * 4. Secret resolution for authentication via `ctx.secrets.resolve`.
 * 5. Metrics tracking via `ctx.metrics.write`.
 * 6. Activity logging via `ctx.activity.log`.
 * 7. State management via `ctx.state.set`.
 */
const plugin = definePlugin({
  /**
   * Main setup function for the plugin.
   * Initializes event listeners and handles configuration resolution.
   */
  async setup(ctx) {
    /**
     * Reads and parses the current plugin configuration.
     * Maps the raw instance configuration to a strongly-typed PluginConfig object.
     */
    const getParsedConfig = async (): Promise<PluginConfig> => {
      const config = await ctx.config.get();
      return {
        topic: asString(config.topic),
        serverUrl: asString(config.serverUrl) || "https://ntfy.sh",
        tokenRef: asString(config.tokenSecretRef),
        allowlist: asStringArray(config.eventAllowlist),
        defaultPriority: asInt(config.defaultPriority, 3),
        defaultTags: asStringArray(config.defaultTags),
      };
    };

    /**
     * Core function to send a message to ntfy.sh.
     * Constructs the URL and headers, resolves secrets if necessary, 
     * and performs the POST request.
     * 
     * @param config The current plugin configuration.
     * @param params Notification details including text, title, priority, tags, and an optional click URL.
     */
    const sendNtfyMessage = async (
      config: PluginConfig,
      params: {
        text: string;
        title?: string;
        priority?: number;
        tags?: string[];
        click?: string;
      }
    ): Promise<boolean> => {
      if (!config.topic) {
        ctx.logger.warn("ntfy notifier skipped message: topic missing from configuration");
        return false;
      }

      try {
        const baseUrl = config.serverUrl.replace(/\/$/, "");
        const url = `${baseUrl}/${config.topic}`;
        
        const headers: Record<string, string> = {
          "Content-Type": "text/plain",
        };

        if (params.title) headers["Title"] = params.title;
        
        // Priority: Param > Config Default > 3 (ntfy default)
        headers["Priority"] = String(params.priority ?? config.defaultPriority);

        // Tags: Merge params tags with config defaults
        const tags = [...(params.tags || []), ...config.defaultTags];
        if (tags.length > 0) {
          headers["Tags"] = [...new Set(tags)].join(",");
        }

        if (params.click) headers["Click"] = params.click;

        // Resolve secret if a token reference is provided
        if (config.tokenRef) {
          const token = await ctx.secrets.resolve(config.tokenRef);
          headers["Authorization"] = `Bearer ${token}`;
        }

        const response = await ctx.http.fetch(url, {
          method: "POST",
          headers,
          body: params.text
        });

        if (!response.ok) {
          throw new Error(`ntfy server responded with ${response.status}: ${await response.text()}`);
        }

        // Increment success metric
        await ctx.metrics.write(METRIC_SENT, 1);
        return true;
      } catch (error) {
        // Increment failure metric and log error
        await ctx.metrics.write(METRIC_FAILED, 1);
        ctx.logger.error("ntfy notifier delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    /**
     * Helper to register an event handler with common filtering and delivery logic.
     * 
     * @param eventName The Paperclip event to subscribe to.
     * @param params Formatting parameters for the notification.
     * @param afterSend Optional callback to execute after a successful notification.
     */
    const handleEvent = (
      eventName: string,
      params: NotificationParams,
      afterSend?: (event: any, config: PluginConfig) => Promise<void>
    ) => {
      ctx.events.on(eventName as any, async (event) => {
        const config = await getParsedConfig();
        
        // Skip if event type is not in the allowlist
        if (config.allowlist.length > 0 && !config.allowlist.includes(event.eventType)) {
          return;
        }

        // Send notification
        const delivered = await sendNtfyMessage(config, {
          text: params.text(event),
          title: params.title,
          priority: params.priority,
          tags: params.tags,
        });
        if (!delivered) {
          return;
        }

        // Run post-send logic if provided
        if (afterSend) {
          await afterSend(event, config);
        }
      });
    };

    // --- Register Event Handlers ---

    handleEvent("agent.run.started", {
      text: (e) => `Agent run started: ${e.entityId || "unknown"}`,
      title: TITLES.AGENT_ACTIVITY,
      priority: 2,
      tags: [TAGS.ROBOT, "arrow_forward"],
    });

    handleEvent("agent.run.finished", {
      text: (e) => `Agent run finished: ${e.entityId || "unknown"}`,
      title: TITLES.AGENT_ACTIVITY,
      priority: 3,
      tags: [TAGS.ROBOT, "checkered_flag"],
    }, async (e) => {
      // Log notification activity to the Paperclip audit log
      await ctx.activity.log({
        companyId: e.companyId,
        message: `Forwarded agent run completion (${e.entityId}) to ntfy`,
        entityType: "run",
        entityId: e.entityId
      });
    });

    handleEvent("agent.run.failed", {
      text: (e) => `Agent run failed: ${e.entityId || "unknown"}`,
      title: TITLES.AGENT_ALERT,
      priority: 4,
      tags: [TAGS.ROBOT, "x", TAGS.WARNING],
    });

    handleEvent("agent.run.cancelled", {
      text: (e) => `Agent run cancelled: ${e.entityId || "unknown"}`,
      title: TITLES.AGENT_ACTIVITY,
      priority: 2,
      tags: [TAGS.ROBOT, "stop_sign"],
    });

    handleEvent("agent.status_changed", {
      text: (e) => `Agent ${e.entityId || "unknown"} status changed`,
      title: TITLES.AGENT_STATUS,
      priority: 2,
      tags: [TAGS.ROBOT, "arrows_counterclockwise"],
    });

    handleEvent("issue.created", {
      text: (e) => `New issue created: ${e.entityId || "unknown"}`,
      title: TITLES.ISSUE_UPDATE,
      priority: 4,
      tags: ["new", "memo"],
    });

    handleEvent("issue.comment.created", {
      text: (e) => `New comment on issue ${e.entityId || "unknown"}`,
      title: TITLES.ISSUE_UPDATE,
      priority: 3,
      tags: ["speech_balloon"],
    }, async (e) => {
      // Update plugin state to track the last notification time for this issue
      await ctx.state.set(
        { scopeKind: "issue", scopeId: e.entityId, stateKey: "last_ntfy_notified_at" },
        e.occurredAt
      );
    });

    handleEvent("approval.created", {
      text: () => "Approval requested for an action in Paperclip.",
      title: TITLES.APPROVAL,
      priority: 5,
      tags: [TAGS.WARNING, "writing_hand"],
    });

    handleEvent("approval.decided", {
      text: () => "An approval decision has been recorded.",
      title: TITLES.APPROVAL,
      priority: 3,
      tags: [TAGS.CHECK],
    });
  },

  /**
   * Validates the plugin configuration provided by the user.
   */
  async onValidateConfig(config) {
    if (!asString(config.topic)) {
      return { ok: false, errors: ["topic is required"] };
    }
    const priority = asInt(config.defaultPriority, 3);
    if (priority < 1 || priority > 5) {
      return { ok: false, errors: ["defaultPriority must be between 1 and 5"] };
    }
    return { ok: true };
  },

  /**
   * Returns the current health status of the plugin instance.
   */
  async onHealth() {
    return { status: "ok", message: "ntfy notifier example plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
