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

function signalsRecord(map: Map<RequiredIssueToolset, Set<string>>): Record<RequiredIssueToolset, string[]> {
  return {
    image_gen: [...(map.get("image_gen") ?? [])].sort(),
    video_gen: [...(map.get("video_gen") ?? [])].sort(),
  };
}

export type RequiredIssueToolset = "image_gen" | "video_gen";

export interface IssueCapabilityRoutingInput {
  title?: string | null;
  description?: string | null;
  labels?: Array<string | { name?: string | null }> | null;
  originKind?: string | null;
}

export interface IssueToolRequirements {
  /** Hard requirements that 422 a deliberate non-capable assignee. */
  requiredToolsets: RequiredIssueToolset[];
  matchedSignals: Record<RequiredIssueToolset, string[]>;
  requiresMediaTools: boolean;
  /**
   * Soft prose/mention signals. Used for ranking/suggestion only — never force a 422.
   * Bare `image_gen` / Designer-Media / "generate an image" prose lands here (TSMC-18607).
   */
  suggestedToolsets: RequiredIssueToolset[];
  suggestedSignals: Record<RequiredIssueToolset, string[]>;
  suggestsMediaTools: boolean;
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

/**
 * Infer hard tool requirements vs soft suggestions from issue text.
 *
 * Hard (422 on deliberate non-capable assignee):
 *   - explicit intent prefixes: requires:/needs:/toolset:/required-skill: + image_gen|video_gen
 *   - labels that name a media toolset/specialist (deliberate tags)
 *
 * Soft (suggestion only — does NOT 422):
 *   - bare prose mentions of image_gen / video_gen / Designer-Media / grok-imagine
 *   - bare "generate/create/render/edit an image|video" phrasing
 *
 * Fenced code blocks are stripped first (quoted data is not intent). Routine executions
 * only honour explicit-intent body signals (labels still apply).
 *
 * Proven 2026-07-25/31: RCAs, postmortems, routing-guard cards, and recovery issues that
 * merely DISCUSS media lanes were force-routed and 422'd non-media assignees. Half-closed
 * by stripCodeFences; TSMC-18607 closes the prose half.
 */
export function inferIssueToolRequirements(input: IssueCapabilityRoutingInput): IssueToolRequirements {
  const hardSignals = new Map<RequiredIssueToolset, Set<string>>();
  const softSignals = new Map<RequiredIssueToolset, Set<string>>();
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

  // --- HARD: explicit intent prefixes only ---------------------------------
  if (/\b(?:requires|needs|toolset|required[-_\s]?skill)[:\s_-]+image[_ -]?gen\b/.test(body)) {
    addSignal(hardSignals, "image_gen", "keyword:image_gen");
  }
  if (/\b(?:requires|needs|toolset|required[-_\s]?skill)[:\s_-]+video[_ -]?gen\b/.test(body)) {
    addSignal(hardSignals, "video_gen", "keyword:video_gen");
  }

  // --- SOFT: bare prose mentions (never 422 a deliberate assignee) ---------
  // TSMC-18607: discussing media work on an RCA/postmortem/routing card must not force-route.
  if (!explicitOnlyForRoutineDispatch) {
    if (/\bimage[_ -]?gen\b/.test(body)) {
      // Only soft when the same token was not already claimed as hard via explicit prefix.
      if (!(hardSignals.get("image_gen")?.has("keyword:image_gen"))) {
        addSignal(softSignals, "image_gen", "mention:image_gen");
      }
    }
    if (/\bvideo[_ -]?gen\b/.test(body)) {
      if (!(hardSignals.get("video_gen")?.has("keyword:video_gen"))) {
        addSignal(softSignals, "video_gen", "mention:video_gen");
      }
    }
    if (/\b(?:grok-imagine|designer[-_\s]?media)\b/.test(body)) {
      addSignal(softSignals, "image_gen", "mention:media_specialist");
      addSignal(softSignals, "video_gen", "mention:media_specialist");
    }
    if (/\b(?:generate|create|render|edit)\s+(?:an?\s+)?image\b/.test(body)) {
      addSignal(softSignals, "image_gen", "mention:generate_image");
    }
    if (/\b(?:generate|create|render|edit)\s+(?:an?\s+)?video\b/.test(body)) {
      addSignal(softSignals, "video_gen", "mention:generate_video");
    }
  }

  // --- HARD: labels are deliberate tags ------------------------------------
  for (const labelName of labelNames) {
    const normalized = normalizeText(labelName);
    if (
      /\b(?:image[_ -]?gen|needs[:/_-]?image[_ -]?gen|requires[:/_-]?image[_ -]?gen|required[-_\s]?skill[:/_-]?image[_ -]?gen)\b/.test(normalized)
    ) {
      addSignal(hardSignals, "image_gen", `label:${labelName}`);
    }
    if (
      /\b(?:video[_ -]?gen|needs[:/_-]?video[_ -]?gen|requires[:/_-]?video[_ -]?gen|required[-_\s]?skill[:/_-]?video[_ -]?gen)\b/.test(normalized)
    ) {
      addSignal(hardSignals, "video_gen", `label:${labelName}`);
    }
    if (/\b(?:media|creative|grok-imagine|designer[-_\s]?media)\b/.test(normalized)) {
      addSignal(hardSignals, "image_gen", `label:${labelName}`);
      addSignal(hardSignals, "video_gen", `label:${labelName}`);
    }
  }

  const requiredToolsets = [...hardSignals.keys()].sort() as RequiredIssueToolset[];
  const suggestedToolsets = [...softSignals.keys()].sort() as RequiredIssueToolset[];
  return {
    requiredToolsets,
    matchedSignals: signalsRecord(hardSignals),
    requiresMediaTools: requiredToolsets.length > 0,
    suggestedToolsets,
    suggestedSignals: signalsRecord(softSignals),
    suggestsMediaTools: suggestedToolsets.length > 0,
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

  // Prefer hard-requirement coverage first, then soft-suggestion coverage for ranking only.
  const rankingToolsets = requirements.requiredToolsets.length > 0
    ? requirements.requiredToolsets
    : requirements.suggestedToolsets;
  const leftCoverage = rankingToolsets.filter((toolset) => leftCapabilities.toolsets.includes(toolset)).length;
  const rightCoverage = rankingToolsets.filter((toolset) => rightCapabilities.toolsets.includes(toolset)).length;
  if (leftCoverage !== rightCoverage) return rightCoverage - leftCoverage;

  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function describeIssueToolRequirements(requirements: IssueToolRequirements) {
  return requirements.requiredToolsets.join(", ");
}
