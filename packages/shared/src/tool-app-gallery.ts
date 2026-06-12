import type { ToolConnectionTransport } from "./types/tool-access.js";

export type AppGalleryAuthKind = "oauth" | "api_key" | "none";

export interface AppGalleryCredentialField {
  label: string;
  configPath: string;
  helpUrl: string;
  required?: boolean;
  placement?: "header" | "env";
  key?: string;
  prefix?: string | null;
}

export type AppGalleryTransportTemplate =
  | {
      transport: Extract<ToolConnectionTransport, "remote_http">;
      url: string;
    }
  | {
      transport: Extract<ToolConnectionTransport, "local_stdio">;
      templateKey: string;
    };

export interface AppGalleryEntry {
  key: string;
  name: string;
  logoUrl: string;
  tagline: string;
  description?: string;
  authKind: AppGalleryAuthKind;
  transportTemplate: AppGalleryTransportTemplate;
  credentialFields: AppGalleryCredentialField[];
  recommendedDefaults: Record<string, unknown>;
  urlPatterns: string[];
  availability?: {
    available: boolean;
    reason?: string | null;
    robotEmail?: string | null;
  };
  oauth?: {
    provider: string;
    scopes: string[];
    tokenUrl?: string | null;
    metadataUrl?: string | null;
    authorizationUrl?: string | null;
  };
}

const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

export const TOOL_APP_GALLERY = [
  {
    key: "zapier",
    name: "Zapier",
    logoUrl: favicon("zapier.com"),
    tagline: "Connect Zapier-hosted MCP actions to Paperclip agents.",
    description: "Let agents use Zapier automations across the apps your business already runs. Good for handoffs, lightweight operations, and cross-app updates that should stay visible in Paperclip.",
    authKind: "api_key",
    transportTemplate: {
      transport: "remote_http",
      url: "https://mcp.zapier.com/api/mcp",
    },
    credentialFields: [
      {
        label: "Zapier MCP token",
        configPath: "credentials.authorization",
        helpUrl: "https://zapier.com/app/settings/authorizations",
        required: true,
        placement: "header",
        key: "Authorization",
        prefix: "Bearer ",
      },
    ],
    recommendedDefaults: {
      access: "all_agents",
      askFirstRiskLevels: ["write", "destructive"],
    },
    urlPatterns: ["https://mcp.zapier.com/*"],
  },
  {
    key: "github",
    name: "GitHub",
    logoUrl: favicon("github.com"),
    tagline: "Read and manage GitHub work through the hosted MCP server.",
    description: "Give agents a governed way to inspect repositories, issues, and pull requests. Useful when engineering work needs GitHub context or small updates without leaving Paperclip.",
    authKind: "api_key",
    transportTemplate: {
      transport: "remote_http",
      url: "https://api.githubcopilot.com/mcp/",
    },
    credentialFields: [
      {
        label: "GitHub token",
        configPath: "credentials.authorization",
        helpUrl: "https://github.com/settings/tokens",
        required: true,
        placement: "header",
        key: "Authorization",
        prefix: "Bearer ",
      },
    ],
    recommendedDefaults: {
      access: "all_agents",
      askFirstRiskLevels: ["write", "destructive"],
    },
    urlPatterns: ["https://api.githubcopilot.com/mcp/*"],
  },
  {
    key: "slack",
    name: "Slack",
    logoUrl: favicon("slack.com"),
    tagline: "Search channels and coordinate Slack actions.",
    description: "Let agents search workspace conversations and coordinate in Slack when work needs team context. Message-sending actions can still ask a human first.",
    authKind: "oauth",
    transportTemplate: {
      transport: "remote_http",
      url: "https://mcp.slack.com/mcp",
    },
    credentialFields: [],
    recommendedDefaults: {
      access: "all_agents",
      askFirstRiskLevels: ["write", "destructive"],
    },
    urlPatterns: ["https://mcp.slack.com/*"],
    oauth: {
      provider: "slack",
      scopes: ["channels:read", "chat:write", "search:read"],
      authorizationUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
    },
  },
  {
    key: "notion",
    name: "Notion",
    logoUrl: favicon("notion.so"),
    tagline: "Search and update Notion workspace content.",
    description: "Connect Notion so agents can find docs, read project notes, and update workspace pages. Use it for company memory that lives outside Paperclip.",
    authKind: "oauth",
    transportTemplate: {
      transport: "remote_http",
      url: "https://mcp.notion.com/mcp",
    },
    credentialFields: [],
    recommendedDefaults: {
      access: "all_agents",
      askFirstRiskLevels: ["write", "destructive"],
    },
    urlPatterns: ["https://mcp.notion.com/*"],
    oauth: {
      provider: "notion",
      scopes: ["read_content", "update_content"],
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
    },
  },
  {
    key: "linear",
    name: "Linear",
    logoUrl: favicon("linear.app"),
    tagline: "Read and update Linear issues from agent workflows.",
    description: "Let agents look up Linear work and make issue updates when their Paperclip tasks depend on your existing product queue.",
    authKind: "oauth",
    transportTemplate: {
      transport: "remote_http",
      url: "https://mcp.linear.app/mcp",
    },
    credentialFields: [],
    recommendedDefaults: {
      access: "all_agents",
      askFirstRiskLevels: ["write", "destructive"],
    },
    urlPatterns: ["https://mcp.linear.app/*"],
    oauth: {
      provider: "linear",
      scopes: ["read", "write"],
      authorizationUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
    },
  },
  {
    key: "google-sheets",
    name: "Google Sheets",
    logoUrl: favicon("sheets.google.com"),
    tagline: "Read and update selected spreadsheets.",
    description: "Let agents read and update only the spreadsheets you choose. Share each sheet with the robot email, then paste the sheet links here.",
    authKind: "none",
    transportTemplate: {
      transport: "local_stdio",
      templateKey: "paperclip.google-sheets",
    },
    credentialFields: [],
    recommendedDefaults: {
      access: "all_agents",
      askFirstRiskLevels: ["write", "destructive"],
    },
    urlPatterns: ["https://docs.google.com/spreadsheets/*", "https://sheets.google.com/*"],
  },
  {
    key: "context7",
    name: "Context7",
    logoUrl: favicon("context7.com"),
    tagline: "Fetch current library documentation through Context7 MCP.",
    description: "Let agents pull current library documentation while they work. It is a low-risk reference app for coding and research tasks.",
    authKind: "none",
    transportTemplate: {
      transport: "remote_http",
      url: "https://mcp.context7.com/mcp",
    },
    credentialFields: [],
    recommendedDefaults: {
      access: "all_agents",
      askFirstRiskLevels: [],
    },
    urlPatterns: ["https://mcp.context7.com/*"],
  },
] satisfies AppGalleryEntry[];

export type AppGalleryKey = (typeof TOOL_APP_GALLERY)[number]["key"];

export function getToolAppGalleryEntry(key: string): AppGalleryEntry | null {
  return TOOL_APP_GALLERY.find((entry) => entry.key === key) ?? null;
}

function wildcardPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function getToolAppGalleryEntryForUrl(
  link: string,
  entries: readonly AppGalleryEntry[] = TOOL_APP_GALLERY,
): AppGalleryEntry | null {
  let normalized: string;
  try {
    normalized = new URL(link.trim()).toString();
  } catch {
    return null;
  }
  return entries.find((entry) =>
    entry.urlPatterns.some((pattern) => wildcardPatternToRegExp(pattern).test(normalized))
  ) ?? null;
}
