function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,\n|]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeText(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stripCodeFences(text: string): string {
  // Remove fenced code blocks (```...```) so that quoted tool output,
  // agent names in tables, or example snippets do not trigger keyword routing.
  return text.replace(/```[\s\S]*?```/g, " ");
}

function normalizeToolsetToken(token: string) {
  const normalized = token.trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalized) return null;
  if (normalized === "image_gen" || normalized === "image-gen" || normalized === "imagegen") {
    return "image_gen" as const;
  }
  if (normalized === "video_gen" || normalized === "video-gen" || normalized === "videogen") {
    return "video_gen" as const;
  }
  if (
    normalized === "media" ||
    normalized === "creative" ||
    normalized === "grok-imagine" ||
    normalized === "designer-media" ||
    normalized === "designer_media"
  ) {
    return "media" as const;
  }
  return null;
}

function addSignal(
  map: Map<RequiredIssueToolset, Set<string>>,
  toolset: RequiredIssueToolset,
  signal: string,
) {
  const existing = map.get(toolset) ?? new Set<string>();
  existing.add(signal);
  map.set(toolset, existing);
}

export type RequiredIssueToolset = "image_gen" | "video_gen";

export interface IssueCapabilityRoutingInput {
  title?: string | null;
  description?: string | null;
  labels?: Array<string | { name?: string | null }> | null;
  originKind?: string | null;
}

export interface IssueToolRequirements {
  requiredToolsets: RequiredIssueToolset[];
  matchedSignals: Record<RequiredIssueToolset, string[]>;
  requiresMediaTools: boolean;
}

export interface AgentCapabilityRoutingInput {
  id: string;
  name: string;
  title?: string | null;
  capabilities?: string | null;
  adapterType?: string | null;
  adapterConfig?: unknown;
}

export interface NormalizedAgentToolCapabilities {
  toolsets: RequiredIssueToolset[];
  matchedSignals: string[];
  isMediaSpecialist: boolean;
}

export function inferIssueToolRequirements(input: IssueCapabilityRoutingInput): IssueToolRequirements {
  const toolSignals = new Map<RequiredIssueToolset, Set<string>>();
  const title = normalizeText(input.title);
  const description = normalizeText(input.description);
  // Strip fenced code blocks before keyword matching. stripCodeFences was written for exactly
  // this and was never actually called, so quoted tool output still drove routing: an issue
  // whose body merely QUOTED an agent name — in a results table, a log excerpt, or the
  // matcher's own regexes — force-required media toolsets and 422'd a deliberate non-media
  // assignee. Proven 2026-07-25: an RCA naming the lane, and a guard card whose output table
  // listed it, both rejected; filing the bug report itself took five attempts because quoting
  // these rules trips these rules. Quoted output is DATA, not routing intent.
  const body = stripCodeFences(`${title}\n${description}`);
  const explicitOnlyForRoutineDispatch = normalizeText(input.originKind) === "routine_execution";
  const labelNames = (input.labels ?? [])
    .map((label) => typeof label === "string" ? label : label?.name ?? "")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

  if (/\b(?:requires|needs|toolset|required[-_\s]?skill)[:\s_-]+image[_ -]?gen\b/.test(body)) {
    addSignal(toolSignals, "image_gen", "keyword:image_gen");
  }
  if (/\b(?:requires|needs|toolset|required[-_\s]?skill)[:\s_-]+video[_ -]?gen\b/.test(body)) {
    addSignal(toolSignals, "video_gen", "keyword:video_gen");
  }
  if (!explicitOnlyForRoutineDispatch) {
    if (/\bimage[_ -]?gen\b/.test(body)) {
      addSignal(toolSignals, "image_gen", "keyword:image_gen");
    }
    if (/\bvideo[_ -]?gen\b/.test(body)) {
      addSignal(toolSignals, "video_gen", "keyword:video_gen");
    }
    if (/\b(?:grok-imagine|designer[-_\s]?media)\b/.test(body)) {
      addSignal(toolSignals, "image_gen", "keyword:media_specialist");
      addSignal(toolSignals, "video_gen", "keyword:media_specialist");
    }
    if (/\b(?:generate|create|render|edit)\s+(?:an?\s+)?image\b/.test(body)) {
      addSignal(toolSignals, "image_gen", "keyword:generate_image");
    }
    if (/\b(?:generate|create|render|edit)\s+(?:an?\s+)?video\b/.test(body)) {
      addSignal(toolSignals, "video_gen", "keyword:generate_video");
    }
  }

  for (const labelName of labelNames) {
    const normalized = normalizeText(labelName);
    if (
      /\b(?:image[_ -]?gen|needs[:/_-]?image[_ -]?gen|requires[:/_-]?image[_ -]?gen|required[-_\s]?skill[:/_-]?image[_ -]?gen)\b/.test(normalized)
    ) {
      addSignal(toolSignals, "image_gen", `label:${labelName}`);
    }
    if (
      /\b(?:video[_ -]?gen|needs[:/_-]?video[_ -]?gen|requires[:/_-]?video[_ -]?gen|required[-_\s]?skill[:/_-]?video[_ -]?gen)\b/.test(normalized)
    ) {
      addSignal(toolSignals, "video_gen", `label:${labelName}`);
    }
    if (/\b(?:media|creative|grok-imagine|designer[-_\s]?media)\b/.test(normalized)) {
      addSignal(toolSignals, "image_gen", `label:${labelName}`);
      addSignal(toolSignals, "video_gen", `label:${labelName}`);
    }
  }

  const requiredToolsets = [...toolSignals.keys()].sort();
  return {
    requiredToolsets,
    matchedSignals: {
      image_gen: [...(toolSignals.get("image_gen") ?? [])],
      video_gen: [...(toolSignals.get("video_gen") ?? [])],
    },
    requiresMediaTools: requiredToolsets.length > 0,
  };
}

export function normalizeAgentToolCapabilities(
  agent: AgentCapabilityRoutingInput,
): NormalizedAgentToolCapabilities {
  const toolsets = new Set<RequiredIssueToolset>();
  const matchedSignals = new Set<string>();
  const adapterConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
  const rawTokens = [
    ...readStringArray(agent.capabilities),
    ...readStringArray(adapterConfig.toolsets),
    ...readStringArray(adapterConfig.enabledToolsets),
  ];

  for (const token of rawTokens) {
    const normalized = normalizeToolsetToken(token);
    if (normalized === "image_gen") {
      toolsets.add("image_gen");
      matchedSignals.add(`toolset:${token}`);
    } else if (normalized === "video_gen") {
      toolsets.add("video_gen");
      matchedSignals.add(`toolset:${token}`);
    } else if (normalized === "media") {
      toolsets.add("image_gen");
      toolsets.add("video_gen");
      matchedSignals.add(`toolset:${token}`);
    }
  }

  const identity = `${normalizeText(agent.name)} ${normalizeText(agent.title)}`;
  const isMediaSpecialist = /\b(?:designer[-_\s]?media|grok-imagine)\b/.test(identity);
  if (isMediaSpecialist) {
    toolsets.add("image_gen");
    toolsets.add("video_gen");
    matchedSignals.add("identity:media_specialist");
  }

  if (
    agent.adapterType === "hermes_local" &&
    /\b(?:media|creative)\b/.test(identity)
  ) {
    toolsets.add("image_gen");
    toolsets.add("video_gen");
    matchedSignals.add("identity:hermes_media_hint");
  }

  return {
    toolsets: [...toolsets].sort(),
    matchedSignals: [...matchedSignals],
    isMediaSpecialist,
  };
}

export function agentSatisfiesIssueToolRequirements(
  agent: AgentCapabilityRoutingInput,
  requirements: IssueToolRequirements,
) {
  if (!requirements.requiresMediaTools) return true;
  const normalized = normalizeAgentToolCapabilities(agent);
  return requirements.requiredToolsets.every((toolset) => normalized.toolsets.includes(toolset));
}

export function compareAgentsByIssueToolRequirements(
  left: AgentCapabilityRoutingInput,
  right: AgentCapabilityRoutingInput,
  requirements: IssueToolRequirements,
) {
  const leftCapabilities = normalizeAgentToolCapabilities(left);
  const rightCapabilities = normalizeAgentToolCapabilities(right);
  const leftSpecialistScore = leftCapabilities.isMediaSpecialist ? 0 : 1;
  const rightSpecialistScore = rightCapabilities.isMediaSpecialist ? 0 : 1;
  if (leftSpecialistScore !== rightSpecialistScore) return leftSpecialistScore - rightSpecialistScore;

  const leftExplicitScore = leftCapabilities.matchedSignals.some((signal) => signal.startsWith("toolset:")) ? 0 : 1;
  const rightExplicitScore = rightCapabilities.matchedSignals.some((signal) => signal.startsWith("toolset:")) ? 0 : 1;
  if (leftExplicitScore !== rightExplicitScore) return leftExplicitScore - rightExplicitScore;

  const leftCoverage = requirements.requiredToolsets.filter((toolset) => leftCapabilities.toolsets.includes(toolset)).length;
  const rightCoverage = requirements.requiredToolsets.filter((toolset) => rightCapabilities.toolsets.includes(toolset)).length;
  if (leftCoverage !== rightCoverage) return rightCoverage - leftCoverage;

  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function describeIssueToolRequirements(requirements: IssueToolRequirements) {
  return requirements.requiredToolsets.join(", ");
}
