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
  authKind: AppGalleryAuthKind;
  transportTemplate: AppGalleryTransportTemplate;
  credentialFields: AppGalleryCredentialField[];
  recommendedDefaults: Record<string, unknown>;
  urlPatterns: string[];
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
    key: "google-drive",
    name: "Google Drive",
    logoUrl: favicon("drive.google.com"),
    tagline: "Search and retrieve files from Google Drive.",
    authKind: "api_key",
    transportTemplate: {
      transport: "remote_http",
      url: "https://mcp.google.com/drive",
    },
    credentialFields: [
      {
        label: "Google API token",
        configPath: "credentials.authorization",
        helpUrl: "https://console.cloud.google.com/apis/credentials",
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
    urlPatterns: ["https://mcp.google.com/drive*", "https://*.googleapis.com/*"],
  },
  {
    key: "context7",
    name: "Context7",
    logoUrl: favicon("context7.com"),
    tagline: "Fetch current library documentation through Context7 MCP.",
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
