import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-google-calendar",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Google Calendar",
  description:
    "Connects to Google Calendar API v3 to read, create, update, and delete calendar events.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "jobs.schedule",
    "http.outbound",
    "agent.tools.register",
    "instance.settings.register",
    "agents.read",
    "agents.invoke",
    "ui.dashboardWidget.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      clientId: {
        type: "string",
        title: "Google OAuth2 Client ID",
        description:
          "OAuth2 client ID from the Google Cloud Console (Credentials → OAuth 2.0 Client IDs).",
        default: "",
      },
      clientSecret: {
        type: "string",
        title: "Google OAuth2 Client Secret",
        description: "OAuth2 client secret paired with the Client ID above.",
        default: "",
      },
      refreshToken: {
        type: "string",
        title: "OAuth2 Refresh Token",
        description:
          "Long-lived refresh token obtained from the OAuth2 consent flow. Used to mint new access tokens automatically.",
        default: "",
      },
      calendarId: {
        type: "string",
        title: "Calendar ID",
        description:
          "Target Google Calendar ID. Use 'primary' for the account's default calendar, or paste a specific calendar ID.",
        default: "primary",
      },
      timezone: {
        type: "string",
        title: "Timezone",
        description:
          "IANA timezone string used when formatting event times (e.g. 'America/Chicago', 'America/New_York').",
        default: "America/Chicago",
      },
    },
  },
  jobs: [
    {
      jobKey: "morning-briefing",
      displayName: "Morning Briefing",
      description:
        "Wakes the Jarvis agent each morning so it can deliver a daily calendar briefing.",
      schedule: "0 7 * * *",
    },
  ],
  tools: [
    {
      name: "gcal_get_day_summary",
      displayName: "Google Calendar: Day Summary",
      description:
        "Returns a human-readable summary of events for a given day (defaults to today).",
      parametersSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "ISO date (YYYY-MM-DD). Defaults to today.",
          },
        },
      },
    },
    {
      name: "gcal_list_events",
      displayName: "Google Calendar: List Events",
      description: "Lists events between two dates.",
      parametersSchema: {
        type: "object",
        properties: {
          dateStart: { type: "string", description: "ISO date start (YYYY-MM-DD, inclusive)" },
          dateEnd: { type: "string", description: "ISO date end (YYYY-MM-DD, inclusive)" },
        },
        required: ["dateStart", "dateEnd"],
      },
    },
    {
      name: "gcal_get_event",
      displayName: "Google Calendar: Get Event",
      description: "Returns a single calendar event by event ID.",
      parametersSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Google Calendar event ID" },
        },
        required: ["eventId"],
      },
    },
    {
      name: "gcal_create_event",
      displayName: "Google Calendar: Create Event",
      description: "Creates a new calendar event.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title / summary" },
          startTime: {
            type: "string",
            description: "ISO 8601 datetime (e.g. '2026-04-28T09:00:00')",
          },
          endTime: {
            type: "string",
            description: "ISO 8601 datetime (e.g. '2026-04-28T10:00:00')",
          },
          description: { type: "string", description: "Optional event description / notes" },
          location: { type: "string", description: "Optional location string" },
        },
        required: ["title", "startTime", "endTime"],
      },
    },
    {
      name: "gcal_update_event",
      displayName: "Google Calendar: Update Event",
      description: "Updates fields on an existing calendar event.",
      parametersSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Google Calendar event ID to update" },
          title: { type: "string", description: "New event title" },
          startTime: { type: "string", description: "New start datetime (ISO 8601)" },
          endTime: { type: "string", description: "New end datetime (ISO 8601)" },
          description: { type: "string", description: "New event description" },
        },
        required: ["eventId"],
      },
    },
    {
      name: "gcal_delete_event",
      displayName: "Google Calendar: Delete Event",
      description: "Permanently deletes a calendar event.",
      parametersSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Google Calendar event ID to delete" },
        },
        required: ["eventId"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "google-calendar-page",
        displayName: "Google Calendar",
        exportName: "CalendarPage",
        routePath: "google-calendar",
      },
      {
        type: "dashboardWidget",
        id: "google-calendar-today-widget",
        displayName: "Today's Events",
        exportName: "TodayWidget",
      },
    ],
  },
};

export default manifest;
