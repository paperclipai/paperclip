import { parseSlackConfiguredCoverage, type SlackConfiguredCoverage } from "./chat-channels/slack/configured-coverage.js";
/** Closed Cloud-owned ingress catalog. No credential material belongs in this proof. */
export interface IdleIncomingWakeCapability {
  version: 1;
  ownerId: string;
  generation: string;
  routes: ("tenant-api-http-v2" | "github-broker-events-v1" | "slack-broker-events-v1" | "mcp-oauth-http-v1")[];
  mcpOAuthProof?: { version: 1; challenge: string };
  apiKeyProof?: { version: 1; challenge: string };
  githubBroker?: { instanceId: string; bindingsFingerprint: string };
  slackBroker?: SlackConfiguredCoverage;
}
export interface IdleCapabilities {
  incomingWake?: IdleIncomingWakeCapability;
  deadlineCatalog?: "domain_deadlines_v1";
}
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
const digest = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function parseIdleCapabilities(value: unknown): IdleCapabilities {
  if (
    !object(value) ||
    !exact(value, ["incomingWake", "deadlineCatalog"]) ||
    !Object.keys(value).length
  )
    throw new Error("Invalid idle capabilities");
  if (
    value.deadlineCatalog !== undefined &&
    value.deadlineCatalog !== "domain_deadlines_v1"
  )
    throw new Error("Unknown idle deadline catalog");
  if (value.incomingWake !== undefined) {
    const v = value.incomingWake;
    if (
      !object(v) ||
      !exact(v, [
        "version",
        "ownerId",
        "generation",
        "routes",
        "githubBroker",
        "slackBroker",
        "apiKeyProof",
        "mcpOAuthProof",
      ]) ||
      v.version !== 1 ||
      typeof v.ownerId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        v.ownerId,
      ) ||
      !digest(v.generation) ||
      !Array.isArray(v.routes) ||
      v.routes.length < 1 ||
      v.routes.length > 4 ||
      v.routes.some(
        (r) => !["tenant-api-http-v2", "github-broker-events-v1", "slack-broker-events-v1", "mcp-oauth-http-v1"].includes(r),
      ) ||
      new Set(v.routes).size !== v.routes.length ||
      [...v.routes].sort().join() !== v.routes.join()
    )
      throw new Error("Invalid incoming wake capability");
    if (v.routes.includes("tenant-api-http-v2")) {
      const proof = v.apiKeyProof;
      if (!object(proof) || Object.keys(proof).length !== 2 || !exact(proof, ["version", "challenge"])
        || proof.version !== 1 || !digest(proof.challenge)) throw new Error("Invalid API wake challenge");
    } else if (v.apiKeyProof !== undefined) throw new Error("Unexpected API wake challenge");
    if (v.routes.includes("mcp-oauth-http-v1")) {
      const proof = v.mcpOAuthProof;
      if (!object(proof) || Object.keys(proof).length !== 2 || !exact(proof, ["version", "challenge"])
        || proof.version !== 1 || !digest(proof.challenge)) throw new Error("Invalid MCP OAuth wake challenge");
    } else if (v.mcpOAuthProof !== undefined) throw new Error("Unexpected MCP OAuth wake challenge");
    if (v.routes.includes("github-broker-events-v1")) {
      const b = v.githubBroker;
      if (
        !object(b) ||
        !exact(b, ["instanceId", "bindingsFingerprint"]) ||
        typeof b.instanceId !== "string" ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(b.instanceId) ||
        !digest(b.bindingsFingerprint)
      )
        throw new Error("Invalid GitHub wake binding");
    } else if (v.githubBroker !== undefined)
      throw new Error("Unexpected GitHub wake binding");
  }
  if (value.incomingWake && typeof value.incomingWake === "object" && !Array.isArray(value.incomingWake)) {
    const incoming = Object.fromEntries(Object.entries(value.incomingWake));
    if (Array.isArray(incoming.routes) && incoming.routes.includes("slack-broker-events-v1")) {
      const proof = parseSlackConfiguredCoverage(incoming.slackBroker);
      if (proof.generation !== incoming.generation) throw new Error("Slack capability generation changed");
    } else if (incoming.slackBroker !== undefined) throw new Error("Unexpected Slack wake binding");
  }
  // Return a detached immutable snapshot; request callers cannot mutate a verified claim.
  const parsed = JSON.parse(JSON.stringify(value)) as IdleCapabilities;
  if (parsed.incomingWake) {
    Object.freeze(parsed.incomingWake.routes);
    if (parsed.incomingWake.slackBroker) parsed.incomingWake.slackBroker = parseSlackConfiguredCoverage(parsed.incomingWake.slackBroker);
    if (parsed.incomingWake.mcpOAuthProof) Object.freeze(parsed.incomingWake.mcpOAuthProof);
    if (parsed.incomingWake.apiKeyProof) Object.freeze(parsed.incomingWake.apiKeyProof);
    if (parsed.incomingWake.githubBroker)
      Object.freeze(parsed.incomingWake.githubBroker);
    Object.freeze(parsed.incomingWake);
  }
  return Object.freeze(parsed);
}

declare const verified: unique symbol;
export type VerifiedIdleCapabilities = IdleCapabilities & {
  readonly [verified]: true;
};
