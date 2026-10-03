import { classifyAction } from "./policy.mjs";

const UNKNOWN = "Unknown";
const LANE_STATUSES = new Set(["healthy", "attention", "blocked", "unknown"]);
const AGENT_STATUS_HEALTH = Object.freeze({
  active: "healthy",
  idle: "healthy",
  running: "healthy",
  paused: "attention",
  pending_approval: "attention",
  error: "blocked",
  terminated: "blocked",
});

function valueOrUnknown(value) {
  if (value === null || value === undefined || value === "") return UNKNOWN;
  return ["string", "number", "boolean"].includes(typeof value) ? value : UNKNOWN;
}

function sourceLink(path, identifier) {
  const normalizedIdentifier = valueOrUnknown(identifier);
  return normalizedIdentifier === UNKNOWN
    ? UNKNOWN
    : `/${path}/${normalizedIdentifier}`;
}

function summarizeTrigger(trigger) {
  const source = trigger && typeof trigger === "object" ? trigger : {};
  return {
    id: valueOrUnknown(source.id),
    type: valueOrUnknown(source.type ?? source.kind),
    status: valueOrUnknown(source.status),
  };
}

function deriveAgentHealth(agent) {
  if (LANE_STATUSES.has(agent?.health)) return agent.health;
  const status = typeof agent?.status === "string" ? agent.status.toLowerCase() : "";
  return AGENT_STATUS_HEALTH[status] ?? UNKNOWN;
}

function latestHeartbeat(dashboard, agents) {
  const candidates = [
    dashboard?.lastHeartbeatAt,
    ...(Array.isArray(agents) ? agents.map((agent) => agent?.lastHeartbeatAt) : []),
  ].filter((value) => typeof value === "string" && value.trim());
  if (candidates.length === 0) return UNKNOWN;
  const valid = candidates
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter(({ time }) => Number.isFinite(time));
  return (valid.length > 0 ? valid.sort((a, b) => b.time - a.time)[0].value : candidates[0]) ?? UNKNOWN;
}

export function normalizeCompanyState({
  company,
  dashboard,
  agents = [],
  routines = [],
  issues = [],
  approvals = [],
  now = new Date(),
}) {
  const knownAgents = (Array.isArray(agents) ? agents : []).map((agent = {}) => ({
    id: valueOrUnknown(agent.id),
    name: valueOrUnknown(agent.name),
    role: valueOrUnknown(agent.role),
    model: valueOrUnknown(agent.adapterConfig?.model ?? agent.model),
    status: valueOrUnknown(agent.status),
    health: deriveAgentHealth(agent),
    link: sourceLink("agents", agent.id),
  }));

  return {
    company: {
      id: valueOrUnknown(company?.id),
      name: valueOrUnknown(company?.name),
    },
    heartbeat: latestHeartbeat(dashboard, agents),
    agents: knownAgents,
    routines: (Array.isArray(routines) ? routines : []).map((routine = {}) => ({
      id: valueOrUnknown(routine.id),
      title: valueOrUnknown(routine.title),
      status: valueOrUnknown(routine.status),
      triggers: Array.isArray(routine.triggers) ? routine.triggers.map(summarizeTrigger) : [],
      link: sourceLink("routines", routine.id),
    })),
    decisions: (Array.isArray(approvals) ? approvals : []).map((approval = {}) => {
      const classification = classifyAction({
        type: approval.type,
        categories: approval.categories,
      });
      return {
        id: valueOrUnknown(approval.id),
        title: valueOrUnknown(approval.title ?? (typeof approval.type === "string" && approval.type.length > 0
          ? approval.type.replaceAll("_", " ")
          : null)),
        status: valueOrUnknown(approval.status),
        protected: classification.protected,
        link: sourceLink("approvals", approval.id),
      };
    }),
    timeline: (Array.isArray(issues) ? issues : []).slice(0, 20).map((issue = {}) => ({
      id: valueOrUnknown(issue.id),
      identifier: valueOrUnknown(issue.identifier),
      title: valueOrUnknown(issue.title),
      status: valueOrUnknown(issue.status),
      link: sourceLink("issues", issue.identifier ?? issue.id),
    })),
    generatedAt: now.toISOString(),
  };
}

export function deriveLaneStatus(agent, healthByAgentId = {}) {
  const upstreamHealth = healthByAgentId?.[agent?.id];
  if (upstreamHealth !== null && upstreamHealth !== undefined) {
    return LANE_STATUSES.has(upstreamHealth) ? upstreamHealth : "unknown";
  }
  return LANE_STATUSES.has(agent?.health) ? agent.health : "unknown";
}
