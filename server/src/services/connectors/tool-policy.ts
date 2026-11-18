import { REST_CONNECTORS } from "./rest-registry.js";
import { getConnectableAppDefinition, reviewedToolRisk, type ToolRiskLevel } from "@paperclipai/shared";
import { NATIVE_PROVIDER_CATALOGS } from "../native-provider-catalogs.js";
import { classifyRailwayToolRisk, isRailwayEndpoint } from "../railway.js";
import { braintrustRisk } from "./braintrust/risk.js";
import { enterpretRisk } from "./enterpret/risk.js";

interface ToolDescriptor {
  name: string;
  annotations?: Record<string, unknown>;
}

interface ConnectionIdentity {
  transport: string;
  config: Record<string, unknown>;
}

interface ReviewedToolPolicy {
  sourceTemplateKey: string;
  classifyRisk?: (tool: ToolDescriptor) => ToolRiskLevel | null;
  quarantineNewEntries: boolean;
  matchesConnection?: (connection: ConnectionIdentity) => boolean;
  matchesEndpoint?: (connection: ConnectionIdentity) => boolean;
}

// Provider selection belongs here; authorization, catalog transitions, and
// operator-selected action policies remain owned by the shared tool service.
const reviewedPolicies: ReviewedToolPolicy[] = [
  ...REST_CONNECTORS.map(connector => ({
    sourceTemplateKey: connector.sourceTemplateKey,
    quarantineNewEntries: true,
    classifyRisk: (tool: ToolDescriptor) => connector.tools.some(candidate => candidate.name === tool.name) ? connector.risk(tool.name) : null,
    matchesConnection: connector.matches,
  })),
  {
    sourceTemplateKey: "railway",
    quarantineNewEntries: true,
    classifyRisk: classifyRailwayToolRisk,
    matchesConnection: connection => isRailwayEndpoint(connection.config.url),
    // A custom connection to the exact reviewed endpoint gets the same risk
    // review and drift handling, without enabling the native API bridge.
    matchesEndpoint: connection => isRailwayEndpoint(connection.config.url),
  },
  // Native REST providers (Daytona, Unikraft) classify from their generated contract.
  ...NATIVE_PROVIDER_CATALOGS.map((provider): ReviewedToolPolicy => ({
    sourceTemplateKey: provider.slug,
    quarantineNewEntries: true,
    classifyRisk: tool => provider.risk(tool.name),
    matchesConnection: provider.isConnection,
  })),
  { sourceTemplateKey: "enterpret", quarantineNewEntries: true, classifyRisk: enterpretRisk },
  { sourceTemplateKey: "braintrust", quarantineNewEntries: true, classifyRisk: braintrustRisk },
];

/**
 * A reviewed tool list declared in the connector's own definition. This is
 * how a connector without provider code (including one a plugin provides)
 * gets the same reviewed risk wherever its definition is installed.
 */
function declaredPolicy(sourceTemplateKey: string | null | undefined): ReviewedToolPolicy | null {
  if (!sourceTemplateKey) return null;
  const app = getConnectableAppDefinition(sourceTemplateKey);
  const review = app?.reviewedTools;
  if (!review) return null;
  return {
    sourceTemplateKey,
    quarantineNewEntries: review.quarantineNewEntries ?? false,
    classifyRisk: tool => reviewedToolRisk(review, tool),
  };
}

const bySource = new Map(reviewedPolicies.map(policy => [policy.sourceTemplateKey, policy]));

export function connectorToolPolicy(sourceTemplateKey?: string | null, connection?: ConnectionIdentity): {
  sourceTemplateKey: string | null;
  classifyRisk?: (tool: ToolDescriptor) => ToolRiskLevel | null;
  quarantineNewEntries: boolean;
} {
  const policy = (connection && reviewedPolicies.find(candidate => candidate.matchesEndpoint?.(connection)))
    || bySource.get(sourceTemplateKey ?? "")
    || declaredPolicy(sourceTemplateKey);
  return {
    sourceTemplateKey: policy?.sourceTemplateKey ?? sourceTemplateKey ?? null,
    classifyRisk: policy?.classifyRisk,
    // Initial setup declares this default before discovery. Subsequent
    // refresh/reconnect preserves it only for the reviewed connection identity.
    quarantineNewEntries: Boolean(policy?.quarantineNewEntries
      && (!connection || !policy.matchesConnection || policy.matchesConnection(connection))),
  };
}
