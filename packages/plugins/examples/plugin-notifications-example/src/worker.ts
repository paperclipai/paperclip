import { definePlugin, runWorker, type PluginEvent, type Issue } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Pushover API constants
// ---------------------------------------------------------------------------

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

// Event types we know how to handle with meaningful messages
const SUPPORTED_EVENT_TYPES = [
  "issue.created",
  "issue.updated",
  "agent.run.failed",
  "budget.incident.opened",
] as const;

type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Config shape resolved from instanceConfigSchema
// ---------------------------------------------------------------------------

interface NotificationConfig {
  pushoverToken: string;
  pushoverUser: string;
  notifyOnEvents: string; // comma-separated list, blank = all
  titlePrefix: string;
}

// ---------------------------------------------------------------------------
// Pushover helpers
// ---------------------------------------------------------------------------

interface PushoverMessage {
  token: string;
  user: string;
  title: string;
  message: string;
  priority?: number; // -2 lowest, -1 low, 0 normal, 1 high, 2 emergency
  url?: string;
  url_title?: string;
  sound?: string;
}

async function sendPushoverNotification(
  ctx: { http: { fetch: (url: string, init?: RequestInit) => Promise<Response> }; logger: { info: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void } },
  msg: PushoverMessage,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("token", msg.token);
  body.set("user", msg.user);
  body.set("title", msg.title);
  body.set("message", msg.message);
  if (msg.priority !== undefined) body.set("priority", String(msg.priority));
  if (msg.url) body.set("url", msg.url);
  if (msg.url_title) body.set("url_title", msg.url_title);
  if (msg.sound) body.set("sound", msg.sound);

  const response = await ctx.http.fetch(PUSHOVER_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable)");
    ctx.logger.error("Pushover API error", {
      status: response.status,
      body: text.slice(0, 500),
    });
  } else {
    ctx.logger.info("Pushover notification sent", { title: msg.title });
  }
}

// ---------------------------------------------------------------------------
// Event → human-readable message builders
// ---------------------------------------------------------------------------

function buildIssueCreatedMessage(
  event: PluginEvent,
  prefix: string,
): PushoverMessage | null {
  const payload = event.payload as {
    issue?: Partial<Issue>;
    identifier?: string;
    title?: string;
  };
  const identifier = payload.issue?.identifier ?? payload.identifier ?? event.entityId ?? "?";
  const title = payload.issue?.title ?? payload.title ?? "(no title)";
  return {
    token: "", // filled by caller
    user: "",
    title: `${prefix} Issue created: ${identifier}`,
    message: title,
    priority: 0,
    sound: "pushover",
  };
}

function buildIssueUpdatedMessage(
  event: PluginEvent,
  prefix: string,
): PushoverMessage | null {
  const payload = event.payload as {
    issue?: Partial<Issue>;
    identifier?: string;
    title?: string;
    changes?: Record<string, { from: unknown; to: unknown }>;
  };

  const identifier =
    payload.issue?.identifier ?? payload.identifier ?? event.entityId ?? "?";
  const title = payload.issue?.title ?? payload.title ?? "(no title)";
  const changes = payload.changes ?? {};

  // Only notify for status changes (blocked, done, in_progress, etc.)
  if (!("status" in changes)) return null;

  const fromStatus = String((changes.status as { from: unknown }).from ?? "");
  const toStatus = String((changes.status as { to: unknown }).to ?? "");

  let priority = 0;
  let sound = "pushover";
  let notifTitle = `${prefix} ${identifier}: ${toStatus}`;

  if (toStatus === "blocked") {
    priority = 1;
    sound = "siren";
    notifTitle = `${prefix} BLOCKED: ${identifier}`;
  } else if (toStatus === "done") {
    sound = "magic";
    notifTitle = `${prefix} Done: ${identifier}`;
  } else if (toStatus === "in_progress") {
    priority = -1;
    notifTitle = `${prefix} Started: ${identifier}`;
  }

  return {
    token: "",
    user: "",
    title: notifTitle,
    message: `${title}\nStatus: ${fromStatus} → ${toStatus}`,
    priority,
    sound,
  };
}

function buildAgentRunFailedMessage(
  event: PluginEvent,
  prefix: string,
): PushoverMessage | null {
  const payload = event.payload as {
    agentName?: string;
    agentId?: string;
    runId?: string;
    error?: string;
  };
  const agentName = payload.agentName ?? payload.agentId ?? event.actorId ?? "agent";
  const error = payload.error ?? "(no error detail)";
  return {
    token: "",
    user: "",
    title: `${prefix} Agent run failed: ${agentName}`,
    message: error.slice(0, 200),
    priority: 1,
    sound: "siren",
  };
}

function buildBudgetIncidentMessage(
  event: PluginEvent,
  prefix: string,
): PushoverMessage | null {
  const payload = event.payload as {
    scopeType?: string;
    scopeName?: string;
    metric?: string;
    amountObserved?: number;
    amountLimit?: number;
  };
  const scope = payload.scopeName ?? payload.scopeType ?? "unknown scope";
  const observed = payload.amountObserved ?? 0;
  const limit = payload.amountLimit ?? 0;
  return {
    token: "",
    user: "",
    title: `${prefix} Budget limit hit: ${scope}`,
    message: `${payload.metric ?? "spend"}: $${(observed / 100).toFixed(2)} of $${(limit / 100).toFixed(2)} limit`,
    priority: 1,
    sound: "siren",
  };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    // Resolve config once at startup; reload is handled via configChanged
    let config: NotificationConfig | null = null;

    async function getConfig(): Promise<NotificationConfig | null> {
      if (config) return config;
      const raw = await ctx.config.get();
      if (!raw.pushoverToken || !raw.pushoverUser) {
        ctx.logger.warn(
          "Pushover credentials not configured. Notifications are disabled until " +
            "pushoverToken and pushoverUser are set in the plugin settings.",
        );
        return null;
      }
      config = {
        pushoverToken: String(raw.pushoverToken),
        pushoverUser: String(raw.pushoverUser),
        notifyOnEvents: String(raw.notifyOnEvents ?? ""),
        titlePrefix: String(raw.titlePrefix ?? "[Paperclip]"),
      };
      return config;
    }

    function shouldNotify(cfg: NotificationConfig, eventType: string): boolean {
      const filter = cfg.notifyOnEvents.trim();
      if (!filter) return true; // no filter = notify on everything
      return filter.split(",").map((s) => s.trim()).includes(eventType);
    }

    async function dispatchNotification(
      event: PluginEvent,
      builder: (e: PluginEvent, prefix: string) => PushoverMessage | null,
    ) {
      const cfg = await getConfig();
      if (!cfg) return;
      if (!shouldNotify(cfg, event.eventType)) return;

      const msg = builder(event, cfg.titlePrefix);
      if (!msg) return;

      msg.token = cfg.pushoverToken;
      msg.user = cfg.pushoverUser;

      await sendPushoverNotification(ctx, msg);

      // Track delivery count in state for the settings widget
      const countRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "notification-count",
      });
      const count = typeof countRaw === "number" ? countRaw + 1 : 1;
      await ctx.state.set(
        { scopeKind: "instance", stateKey: "notification-count" },
        count,
      );
      await ctx.state.set(
        { scopeKind: "instance", stateKey: "last-notification-at" },
        new Date().toISOString(),
      );
    }

    // Subscribe to issue.created
    ctx.events.on("issue.created", async (event) => {
      await dispatchNotification(event, buildIssueCreatedMessage);
    });

    // Subscribe to issue.updated (filter to status changes inside the builder)
    ctx.events.on("issue.updated", async (event) => {
      await dispatchNotification(event, buildIssueUpdatedMessage);
    });

    // Subscribe to agent run failures
    ctx.events.on("agent.run.failed", async (event) => {
      await dispatchNotification(event, buildAgentRunFailedMessage);
    });

    // Subscribe to budget incidents
    ctx.events.on("budget.incident.opened", async (event) => {
      await dispatchNotification(event, buildBudgetIncidentMessage);
    });

    // Register data handler for the dashboard widget
    ctx.data.register("status", async () => {
      const cfg = await getConfig();
      const count = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "notification-count",
      });
      const lastAt = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "last-notification-at",
      });
      return {
        configured: cfg !== null,
        pushoverUser: cfg
          ? cfg.pushoverUser.slice(0, 6) + "…" // partial for display only
          : null,
        notificationCount: count ?? 0,
        lastNotificationAt: lastAt ?? null,
        monitoredEvents: SUPPORTED_EVENT_TYPES,
      };
    });

    // Allow the UI to send a test notification
    ctx.actions.register("test-notification", async () => {
      const cfg = await getConfig();
      if (!cfg) {
        return { success: false, error: "Pushover credentials not configured" };
      }
      try {
        await sendPushoverNotification(ctx, {
          token: cfg.pushoverToken,
          user: cfg.pushoverUser,
          title: `${cfg.titlePrefix} Test notification`,
          message:
            "Your Paperclip notification plugin is working correctly! 🎉",
          priority: 0,
          sound: "magic",
        });
        return { success: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    });

    ctx.logger.info("Paperclip Mobile Notifications plugin ready", {
      monitoredEvents: SUPPORTED_EVENT_TYPES,
    });
  },

  async onConfigChanged(_newConfig) {
    // Force config reload on next event — config variable is captured in setup closure
    // and will be re-read on next invocation via getConfig().
    config = null;
  },

  async onHealth() {
    return { status: "ok", message: "Notification plugin is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
