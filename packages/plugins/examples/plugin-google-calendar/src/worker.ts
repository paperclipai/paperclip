import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";

// ─── Constants ────────────────────────────────────────────────────────────────

const JARVIS_AGENT_ID = "ee9f5ec7-3eba-49ca-8f11-4ce67367a1ec";
const GCAL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCAL_API_BASE = "https://www.googleapis.com/calendar/v3";

// ─── Types ────────────────────────────────────────────────────────────────────

type GCalConfig = {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  calendarId?: string;
  timezone?: string;
};

type TokenCache = {
  accessToken: string;
  expiresAt: number; // ms epoch
};

type GCalEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri: string; entryPointType: string }> };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getConfig(ctx: PluginContext): Promise<GCalConfig> {
  const raw = await ctx.config.get();
  return (raw ?? {}) as GCalConfig;
}

function requireCredentials(cfg: GCalConfig): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
  timezone: string;
} {
  if (!cfg.clientId?.trim() || !cfg.clientSecret?.trim() || !cfg.refreshToken?.trim()) {
    throw new Error(
      "Google Calendar credentials not configured. Set clientId, clientSecret, and refreshToken in plugin settings."
    );
  }
  return {
    clientId: cfg.clientId.trim(),
    clientSecret: cfg.clientSecret.trim(),
    refreshToken: cfg.refreshToken.trim(),
    calendarId: cfg.calendarId?.trim() || "primary",
    timezone: cfg.timezone?.trim() || "America/Chicago",
  };
}

async function getAccessToken(ctx: PluginContext, cfg: GCalConfig): Promise<string> {
  // Try cached token first
  const cached = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: "token-cache",
  })) as TokenCache | null;

  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  // Refresh the token
  const { clientId, clientSecret, refreshToken } = requireCredentials(cfg);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const resp = await fetch(GCAL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "unknown error");
    throw new Error(`Failed to refresh Google OAuth token: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  const accessToken = data.access_token;
  const expiresAt = Date.now() + data.expires_in * 1000;

  await ctx.state.set({ scopeKind: "instance", stateKey: "token-cache" }, {
    accessToken,
    expiresAt,
  } satisfies TokenCache);

  return accessToken;
}

async function gcalFetch(
  ctx: PluginContext,
  cfg: GCalConfig,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const accessToken = await getAccessToken(ctx, cfg);
  const url = path.startsWith("http") ? path : `${GCAL_API_BASE}${path}`;
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "unknown error");
    throw new Error(`Google Calendar API error ${resp.status}: ${text}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Format an ISO datetime string for display using the configured timezone. */
function formatTime(isoStr: string | undefined, timezone: string): string {
  if (!isoStr) return "?";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(new Date(isoStr));
  } catch {
    return isoStr;
  }
}

/** Format a date header line like "☀️ Monday, April 28" */
function formatDateHeader(dateStr: string, timezone: string): string {
  try {
    const d = new Date(`${dateStr}T00:00:00`);
    return (
      "☀️ " +
      new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: timezone,
      }).format(d)
    );
  } catch {
    return dateStr;
  }
}

/** Build a human-readable day summary string. */
function buildDaySummary(events: GCalEvent[], dateStr: string, timezone: string): string {
  const header = formatDateHeader(dateStr, timezone);

  if (events.length === 0) {
    return `${header}\n\nNo events today.`;
  }

  const lines = events.map((ev) => {
    const start = formatTime(ev.start?.dateTime, timezone);
    const end = formatTime(ev.end?.dateTime, timezone);
    const title = ev.summary ?? "(no title)";
    // Detect video call link
    const hangout = ev.hangoutLink;
    const conferenceUri = ev.conferenceData?.entryPoints?.find(
      (e) => e.entryPointType === "video"
    )?.uri;
    const meetPart =
      hangout || conferenceUri
        ? ` (${hangout ? "Google Meet" : new URL(conferenceUri!).hostname})`
        : "";
    return `${start} – ${end}  ${title}${meetPart}`;
  });

  const count = events.length;
  return `${header}\n\n${lines.join("\n")}\n\n${count} event${count === 1 ? "" : "s"} today.`;
}

/** ISO date string for today or a given date, local to timezone. */
function todayInTz(timezone: string, date?: string): string {
  if (date) return date;
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Google Calendar plugin starting up");

    // ── Job: morning-briefing ─────────────────────────────────────────────────
    ctx.jobs.register("morning-briefing", async (_jobCtx) => {
      ctx.logger.info("Running morning briefing — waking Jarvis agent");
      try {
        const companyId =
          process.env["PAPERCLIP_COMPANY_ID"] ??
          ((await ctx.state.get({ scopeKind: "instance", stateKey: "company-id" })) as string | null) ??
          "";

        if (!companyId) {
          ctx.logger.error("morning-briefing: companyId not available — cannot invoke Jarvis");
          return;
        }

        await ctx.agents.invoke(JARVIS_AGENT_ID, companyId, {
          prompt: "Good morning! Please deliver the morning briefing.",
          reason: "routine_morning_briefing",
        });
        ctx.logger.info("Morning briefing: Jarvis agent woken successfully");
      } catch (err) {
        ctx.logger.error("Failed to wake Jarvis agent", { error: summarizeError(err) });
        throw err;
      }
    });

    // ── Tool: gcal_get_day_summary ────────────────────────────────────────────
    ctx.tools.register(
      "gcal_get_day_summary",
      {
        displayName: "Google Calendar: Day Summary",
        description:
          "Returns a human-readable summary of today's events (or a specific date if provided).",
        parametersSchema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "ISO date (YYYY-MM-DD). Defaults to today in the configured timezone.",
            },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { date } = (params ?? {}) as { date?: string };
        try {
          const cfg = await getConfig(ctx);
          const { calendarId, timezone } = requireCredentials(cfg);
          const dateStr = todayInTz(timezone, date);
          const timeMin = `${dateStr}T00:00:00Z`;
          const timeMax = `${dateStr}T23:59:59Z`;
          const data = (await gcalFetch(
            ctx,
            cfg,
            `/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`
          )) as { items?: GCalEvent[] };
          const events = data.items ?? [];
          return { content: buildDaySummary(events, dateStr, timezone) };
        } catch (err) {
          return { error: `Error fetching day summary: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_list_events ────────────────────────────────────────────────
    ctx.tools.register(
      "gcal_list_events",
      {
        displayName: "Google Calendar: List Events",
        description: "Lists calendar events between two ISO dates (inclusive).",
        parametersSchema: {
          type: "object",
          properties: {
            dateStart: { type: "string", description: "Start date (YYYY-MM-DD)" },
            dateEnd: { type: "string", description: "End date (YYYY-MM-DD)" },
          },
          required: ["dateStart", "dateEnd"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { dateStart, dateEnd } = params as { dateStart: string; dateEnd: string };
        try {
          const cfg = await getConfig(ctx);
          const { calendarId } = requireCredentials(cfg);
          const timeMin = `${dateStart}T00:00:00Z`;
          const timeMax = `${dateEnd}T23:59:59Z`;
          const data = (await gcalFetch(
            ctx,
            cfg,
            `/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`
          )) as { items?: GCalEvent[] };
          const events = data.items ?? [];
          if (events.length === 0) {
            return { content: `No events found between ${dateStart} and ${dateEnd}.` };
          }
          return { content: JSON.stringify(events, null, 2) };
        } catch (err) {
          return { error: `Error listing events: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_get_event ──────────────────────────────────────────────────
    ctx.tools.register(
      "gcal_get_event",
      {
        displayName: "Google Calendar: Get Event",
        description: "Returns a single calendar event by ID.",
        parametersSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "Google Calendar event ID" },
          },
          required: ["eventId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { eventId } = params as { eventId: string };
        try {
          const cfg = await getConfig(ctx);
          const { calendarId } = requireCredentials(cfg);
          const event = await gcalFetch(
            ctx,
            cfg,
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
          );
          return { content: JSON.stringify(event, null, 2) };
        } catch (err) {
          return { error: `Error fetching event: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_create_event ───────────────────────────────────────────────
    ctx.tools.register(
      "gcal_create_event",
      {
        displayName: "Google Calendar: Create Event",
        description: "Creates a new calendar event.",
        parametersSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Event title / summary" },
            startTime: { type: "string", description: "ISO 8601 datetime" },
            endTime: { type: "string", description: "ISO 8601 datetime" },
            description: { type: "string", description: "Optional event description" },
            location: { type: "string", description: "Optional location" },
          },
          required: ["title", "startTime", "endTime"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { title, startTime, endTime, description, location } = params as {
          title: string;
          startTime: string;
          endTime: string;
          description?: string;
          location?: string;
        };
        try {
          const cfg = await getConfig(ctx);
          const { calendarId, timezone } = requireCredentials(cfg);
          const body: Record<string, unknown> = {
            summary: title,
            start: { dateTime: startTime, timeZone: timezone },
            end: { dateTime: endTime, timeZone: timezone },
          };
          if (description) body["description"] = description;
          if (location) body["location"] = location;

          const created = await gcalFetch(
            ctx,
            cfg,
            `/calendars/${encodeURIComponent(calendarId)}/events`,
            { method: "POST", body: JSON.stringify(body) }
          );
          const ev = created as GCalEvent;
          return {
            content: `Event created: **${ev.summary ?? title}** (ID: \`${ev.id}\`)\n\`\`\`json\n${JSON.stringify(created, null, 2)}\n\`\`\``,
          };
        } catch (err) {
          return { error: `Error creating event: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_update_event ───────────────────────────────────────────────
    ctx.tools.register(
      "gcal_update_event",
      {
        displayName: "Google Calendar: Update Event",
        description: "Updates fields on an existing calendar event (PATCH).",
        parametersSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "Event ID to update" },
            title: { type: "string", description: "New title" },
            startTime: { type: "string", description: "New start datetime (ISO 8601)" },
            endTime: { type: "string", description: "New end datetime (ISO 8601)" },
            description: { type: "string", description: "New description" },
          },
          required: ["eventId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { eventId, title, startTime, endTime, description } = params as {
          eventId: string;
          title?: string;
          startTime?: string;
          endTime?: string;
          description?: string;
        };
        try {
          const cfg = await getConfig(ctx);
          const { calendarId, timezone } = requireCredentials(cfg);
          const patch: Record<string, unknown> = {};
          if (title) patch["summary"] = title;
          if (startTime) patch["start"] = { dateTime: startTime, timeZone: timezone };
          if (endTime) patch["end"] = { dateTime: endTime, timeZone: timezone };
          if (description !== undefined) patch["description"] = description;

          const updated = await gcalFetch(
            ctx,
            cfg,
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
            { method: "PATCH", body: JSON.stringify(patch) }
          );
          return {
            content: `Event updated.\n\`\`\`json\n${JSON.stringify(updated, null, 2)}\n\`\`\``,
          };
        } catch (err) {
          return { error: `Error updating event: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: gcal_delete_event ───────────────────────────────────────────────
    ctx.tools.register(
      "gcal_delete_event",
      {
        displayName: "Google Calendar: Delete Event",
        description: "Permanently deletes a calendar event.",
        parametersSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "Event ID to delete" },
          },
          required: ["eventId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { eventId } = params as { eventId: string };
        try {
          const cfg = await getConfig(ctx);
          const { calendarId } = requireCredentials(cfg);
          await gcalFetch(
            ctx,
            cfg,
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
            { method: "DELETE" }
          );
          return { content: `Event \`${eventId}\` deleted successfully.` };
        } catch (err) {
          return { error: `Error deleting event: ${summarizeError(err)}` };
        }
      }
    );

    // ── Data endpoint: today's summary (for UI) ───────────────────────────────
    ctx.data.register("today-summary", async () => {
      try {
        const cfg = await getConfig(ctx);
        const { calendarId, timezone } = requireCredentials(cfg);
        const dateStr = todayInTz(timezone);
        const timeMin = `${dateStr}T00:00:00Z`;
        const timeMax = `${dateStr}T23:59:59Z`;
        const data = (await gcalFetch(
          ctx,
          cfg,
          `/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`
        )) as { items?: GCalEvent[] };
        const events = data.items ?? [];
        return {
          date: dateStr,
          summary: buildDaySummary(events, dateStr, timezone),
          eventCount: events.length,
        };
      } catch {
        return { date: null, summary: null, eventCount: 0 };
      }
    });

    ctx.data.register("config-status", async () => {
      const cfg = await getConfig(ctx);
      return {
        hasClientId: Boolean(cfg.clientId?.trim()),
        hasClientSecret: Boolean(cfg.clientSecret?.trim()),
        hasRefreshToken: Boolean(cfg.refreshToken?.trim()),
        calendarId: cfg.calendarId ?? "primary",
        timezone: cfg.timezone ?? "America/Chicago",
      };
    });

    ctx.logger.info("Google Calendar plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Google Calendar plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
