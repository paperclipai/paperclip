type HermesMetadata = {
  hermesOrg?: unknown;
  profile?: unknown;
  division?: unknown;
  charter?: unknown;
  cadence?: unknown;
  skills?: unknown;
  review?: unknown;
  bridgeUrl?: unknown;
};

export type HermesOrgAgentRow = {
  id: string;
  name: string;
  title: string | null;
  status: string;
  adapterType: string;
  lastHeartbeatAt: Date | string | null;
  metadata: HermesMetadata | null;
};

export type HermesOrgRunRow = {
  id: string;
  agentId: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  createdAt: Date | string;
  error: string | null;
};

export type HermesOrgVisibleAgent = {
  id: string;
  name: string;
  title: string | null;
  profile: string;
  division: string;
  status: string;
  adapterType: string;
  bridgeConnected: boolean;
  charter: string | null;
  cadence: string | null;
  skills: string[];
  review: string[];
  lastHeartbeatAt: Date | string | null;
  recentRuns: Array<{
    id: string;
    status: string;
    invocationSource: string;
    triggerDetail: string | null;
    startedAt: Date | string | null;
    finishedAt: Date | string | null;
    createdAt: Date | string;
    error: string | null;
  }>;
};

export type HermesOrgVisibility = {
  orgKey: "full-lead-org";
  totalAgents: number;
  activeAgents: number;
  bridgeAgents: number;
  runningRuns: number;
  divisions: Array<{
    name: string;
    agentCount: number;
    activeCount: number;
    runningRunCount: number;
    agents: HermesOrgVisibleAgent[];
  }>;
  firstActivationPod: HermesOrgVisibleAgent[];
};

const FIRST_ACTIVATION_POD_PROFILES = [
  "leadcoo",
  "leadresearch",
  "leadseo",
  "leadcontent",
  "leadvisual",
  "leadqa",
  "leadsecurity",
];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isActiveAgent(status: string): boolean {
  return status === "active" || status === "running" || status === "idle";
}

function isRunningRun(status: string): boolean {
  return status === "queued" || status === "running";
}

export function buildHermesOrgVisibility(input: {
  agents: HermesOrgAgentRow[];
  runs: HermesOrgRunRow[];
}): HermesOrgVisibility {
  const runsByAgent = new Map<string, HermesOrgRunRow[]>();
  for (const run of input.runs) {
    const existing = runsByAgent.get(run.agentId) ?? [];
    existing.push(run);
    runsByAgent.set(run.agentId, existing);
  }

  const visibleAgents: HermesOrgVisibleAgent[] = input.agents
    .filter((agent) => agent.metadata?.hermesOrg === "full-lead-org")
    .map((agent) => {
      const metadata = agent.metadata ?? {};
      const profile = asString(metadata.profile) ?? agent.name;
      const recentRuns = (runsByAgent.get(agent.id) ?? []).slice(0, 5).map((run) => ({
        id: run.id,
        status: run.status,
        invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        error: run.error,
      }));

      return {
        id: agent.id,
        name: agent.name,
        title: agent.title,
        profile,
        division: asString(metadata.division) ?? "Unassigned",
        status: agent.status,
        adapterType: agent.adapterType,
        bridgeConnected: agent.adapterType === "http" && Boolean(asString(metadata.bridgeUrl)),
        charter: asString(metadata.charter),
        cadence: asString(metadata.cadence),
        skills: asStringArray(metadata.skills),
        review: asStringArray(metadata.review),
        lastHeartbeatAt: agent.lastHeartbeatAt,
        recentRuns,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const divisions = new Map<string, HermesOrgVisibleAgent[]>();
  for (const agent of visibleAgents) {
    const existing = divisions.get(agent.division) ?? [];
    existing.push(agent);
    divisions.set(agent.division, existing);
  }

  const firstActivationPod = FIRST_ACTIVATION_POD_PROFILES
    .map((profile) => visibleAgents.find((agent) => agent.profile === profile))
    .filter((agent): agent is HermesOrgVisibleAgent => Boolean(agent));

  return {
    orgKey: "full-lead-org",
    totalAgents: visibleAgents.length,
    activeAgents: visibleAgents.filter((agent) => isActiveAgent(agent.status)).length,
    bridgeAgents: visibleAgents.filter((agent) => agent.bridgeConnected).length,
    runningRuns: input.runs.filter((run) => isRunningRun(run.status)).length,
    divisions: Array.from(divisions.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, agents]) => ({
        name,
        agentCount: agents.length,
        activeCount: agents.filter((agent) => isActiveAgent(agent.status)).length,
        runningRunCount: agents.reduce(
          (count, agent) => count + agent.recentRuns.filter((run) => isRunningRun(run.status)).length,
          0,
        ),
        agents,
      })),
    firstActivationPod,
  };
}
