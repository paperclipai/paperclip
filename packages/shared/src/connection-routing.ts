import type {
  AskUserQuestionsQuestion,
  ConnectionSearchResultItem,
} from "./types/index.js";
import {
  isRemoteMcpConnectorId,
  type RemoteMcpConnectorId,
} from "./remote-mcp-connectors.js";

export const AGGREGATOR_PRIORITY = [
  "composio",
  "arcade",
  "executor",
  "zapier",
] as const;
export const AGGREGATOR_NAMES: Record<RemoteMcpConnectorId, string> = {
  composio: "Composio",
  arcade: "Arcade",
  executor: "Executor",
  zapier: "Zapier",
};

/** Reviewed public catalog snapshot, not a claim that an account has authorized an app.
 * Add only services confirmed in the cited official catalog. No provider credentials.
 * Executor has no universal app catalog: use the authorized workspace's indexed tools.
 */
export const AGGREGATOR_SUPPORT_INDEX = [
  {
    slug: "hubspot",
    name: "HubSpot",
    aliases: ["hub spot"],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "salesforce",
    name: "Salesforce",
    aliases: [],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "ashby",
    name: "Ashby",
    aliases: [],
    providers: { composio: "2026-09-23", arcade: "2026-09-23" },
  },
  {
    slug: "pipedrive",
    name: "Pipedrive",
    aliases: [],
    providers: { composio: "2026-09-23", zapier: "2026-09-23" },
  },
  {
    slug: "gong",
    name: "Gong",
    aliases: [],
    providers: { composio: "2026-09-23" },
  },
  {
    slug: "outlook",
    name: "Outlook",
    aliases: ["microsoft outlook"],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "microsoft-teams",
    name: "Microsoft Teams",
    aliases: ["teams"],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "firecrawl",
    name: "Firecrawl",
    aliases: [],
    providers: { composio: "2026-09-23", arcade: "2026-09-23" },
  },
  {
    slug: "tavily",
    name: "Tavily",
    aliases: [],
    providers: { composio: "2026-09-23", arcade: "2026-09-23" },
  },
  {
    slug: "exa",
    name: "Exa",
    aliases: [],
    providers: { composio: "2026-09-23", arcade: "2026-09-23" },
  },
  {
    slug: "jira",
    name: "Jira",
    aliases: ["atlassian jira"],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "notion",
    name: "Notion",
    aliases: [],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "github",
    name: "GitHub",
    aliases: ["git hub"],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "gmail",
    name: "Gmail",
    aliases: ["google mail"],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "slack",
    name: "Slack",
    aliases: [],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "airtable",
    name: "Airtable",
    aliases: [],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "asana",
    name: "Asana",
    aliases: [],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
  {
    slug: "linear",
    name: "Linear",
    aliases: [],
    providers: {
      composio: "2026-09-23",
      arcade: "2026-09-23",
      zapier: "2026-09-23",
    },
  },
] as const;
export const AGGREGATOR_CATALOG_SOURCES: Partial<
  Record<RemoteMcpConnectorId, string>
> = {
  composio: "https://composio.dev/toolkits",
  arcade: "https://docs.arcade.dev/en/resources/integrations",
  zapier: "https://zapier.com/apps",
};

export function normalizeConnectionQuery(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function findAggregatorService(query: string) {
  const normalized = normalizeConnectionQuery(query);
  const exact = AGGREGATOR_SUPPORT_INDEX.find((entry) =>
    [entry.slug, entry.name, ...entry.aliases].some(
      (name) => normalizeConnectionQuery(name) === normalized,
    ),
  );
  if (exact) return exact;
  // Agents often include the desired capability ("HubSpot recent contacts").
  // Whole phrases avoid substring guesses; multiple named services need clarification.
  const matches = AGGREGATOR_SUPPORT_INDEX.filter((entry) =>
    [entry.slug, entry.name, ...entry.aliases].some((name) =>
      ` ${normalized} `.includes(` ${normalizeConnectionQuery(name)} `),
    ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Preserve a provider explicitly named by the user instead of applying default ranking. */
export function explicitAggregatorQuery(query: string) {
  // A trailing exclusion is not a second proposed provider. Keep this grammar
  // narrow; alternatives and contradictory choices still require confirmation.
  const exclusion = query.match(/\s*,?\s+not\s+(composio|arcade|executor|zapier)[.!]?\s*$/i);
  if (exclusion) query = query.slice(0, exclusion.index).trim();
  const matches = [
    ...query.matchAll(
      /\b(?:through|via|using)\s+(composio|arcade|executor|zapier)\b/gi,
    ),
  ];
  const namedProviders = new Set(
    (query.match(/\b(?:composio|arcade|executor|zapier)\b/gi) ?? []).map(
      (name) => name.toLowerCase(),
    ),
  );
  if (matches.length !== 1 || namedProviders.size !== 1) return null;
  const match = matches[0]!;
  if (exclusion?.[1]?.toLowerCase() === match[1]!.toLowerCase()) return null;
  return {
    provider: match[1]!.toLowerCase() as RemoteMcpConnectorId,
    serviceQuery: (
      query.slice(0, match.index) + query.slice(match.index! + match[0].length)
    ).trim(),
  };
}

export function parseAggregatorRoute(service: string) {
  const parts = service.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "via" ||
    !isRemoteMcpConnectorId(parts[1]) ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/.test(parts[2]!)
  )
    return null;
  return { provider: parts[1], targetService: parts[2]! };
}

export function aggregatorProviderQuestion(
  targetService: string,
  targetName: string,
  results: ConnectionSearchResultItem[],
): AskUserQuestionsQuestion {
  return {
    id: `connection-provider:${targetService}`,
    // Keep required disclosure in the prompt: all question transports preserve it.
    prompt: `Connect ${targetName} through an external service? These services handle the connection and requests to ${targetName}. Connecting a provider does not yet authorize ${targetName}.`,
    selectionMode: "single",
    required: true,
    allowOther: false,
    options: [
      ...results.map((result, index) => ({
        id: result.service,
        label: `${AGGREGATOR_NAMES[result.aggregator!.provider]}${index === 0 ? " — Recommended" : ""}`,
        description:
          result.reason ?? "Verify the app in this external provider.",
      })),
      {
        id: "none",
        label: "None for now",
        description: "Do not connect through an external service.",
      },
    ],
  };
}

export function aggregatorContinuationInstruction(
  provider: RemoteMcpConnectorId,
  targetName: string,
) {
  const name = AGGREGATOR_NAMES[provider];
  const discovery = {
    composio:
      "Use COMPOSIO_SEARCH_TOOLS to verify the requested app and capability, then COMPOSIO_MANAGE_CONNECTIONS if app authorization is needed.",
    arcade:
      "Inspect the gateway tools for the requested app. If absent, ask the user to add the app's tools in the Arcade gateway and refresh the connection. Follow tool authorization links when required.",
    executor:
      "Inspect the Executor workspace's actual integrations using its documented discovery tools. Do not assume arbitrary apps exist or register integrations merely to search. Follow provider authorization and resume instructions when needed.",
    zapier:
      "In Agentic mode, use discover_zapier_actions and the documented app connection flow. In Managed mode, ask the user to add the required actions in Zapier and refresh the catalog.",
  }[provider];
  return `${name} is an external service. Its connection is available to this agent, but ${targetName} access is not yet verified. ${discovery} Use only the requested capability and effective permissions. If support is absent, explain that result and ask before switching providers. Claim success only after verifying the underlying app; never repeat an uncertain write.`;
}
