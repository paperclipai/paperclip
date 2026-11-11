import {
  AGENT_GRAPH_CLIPBOARD_KIND,
  AGENT_GRAPH_CLIPBOARD_VERSION,
  AGENT_GRAPH_MAX_DRAFTS,
  AGENT_GRAPH_MAX_STICKIES,
  agentGraphClipboardSchema,
  type AgentGraphClipboard,
  type AgentGraphClipboardAgent,
  type AgentGraphDraft,
  type AgentGraphSticky,
} from "@paperclipai/shared";

export const AGENT_GRAPH_CLIPBOARD_MAX_CHARS = 200_000;
export const PASTE_OFFSET = 40;

export interface CopyableAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  adapterType: string;
  adapterConfig?: Record<string, unknown> | null;
  reportsTo: string | null;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.length > max ? value.slice(0, max) : value;
}

export function toClipboardAgent(agent: CopyableAgent, position: { x: number; y: number }): AgentGraphClipboardAgent {
  const model = agent.adapterConfig?.model;
  return {
    sourceAgentId: agent.id,
    x: position.x,
    y: position.y,
    name: agent.name.trim().slice(0, 120) || "Agent",
    role: agent.role,
    title: truncate(agent.title, 200),
    capabilities: truncate(agent.capabilities, 4_000),
    adapterType: agent.adapterType,
    model: typeof model === "string" ? truncate(model, 512) : null,
    reportsTo: agent.reportsTo,
  };
}

export function buildClipboard(input: {
  agents: ReadonlyArray<{ agent: CopyableAgent; position: { x: number; y: number } }>;
  stickies: readonly AgentGraphSticky[];
}): AgentGraphClipboard {
  return {
    kind: AGENT_GRAPH_CLIPBOARD_KIND,
    version: AGENT_GRAPH_CLIPBOARD_VERSION,
    agents: input.agents.slice(0, AGENT_GRAPH_MAX_DRAFTS).map(({ agent, position }) => toClipboardAgent(agent, position)),
    stickies: input.stickies.slice(0, AGENT_GRAPH_MAX_STICKIES).map((sticky) => ({
      x: sticky.x,
      y: sticky.y,
      width: sticky.width,
      height: sticky.height,
      text: sticky.text,
      color: sticky.color,
    })),
  };
}

export function serializeClipboard(clipboard: AgentGraphClipboard): string {
  return JSON.stringify(clipboard);
}

export type ParsedClipboard =
  | { ok: true; clipboard: AgentGraphClipboard }
  | { ok: false; reason: "not-graph-data" | "unsupported-version" | "invalid" | "too-large" };

export function parseClipboard(text: string): ParsedClipboard {
  if (text.length > AGENT_GRAPH_CLIPBOARD_MAX_CHARS) return { ok: false, reason: "too-large" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-graph-data" };
  }
  if (!raw || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== AGENT_GRAPH_CLIPBOARD_KIND) {
    return { ok: false, reason: "not-graph-data" };
  }
  if ((raw as { version?: unknown }).version !== AGENT_GRAPH_CLIPBOARD_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }
  const parsed = agentGraphClipboardSchema.safeParse(raw);
  return parsed.success ? { ok: true, clipboard: parsed.data } : { ok: false, reason: "invalid" };
}

export function uniqueCopyName(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, "").slice(0, 105);
  let candidate = `${base} (copy)`;
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (copy ${counter})`;
    counter += 1;
  }
  return candidate;
}

export interface MaterializedPaste {
  drafts: AgentGraphDraft[];
  stickies: AgentGraphSticky[];
  droppedAgents: number;
  droppedStickies: number;
  clearedManagers: number;
}

export function materializePaste(input: {
  clipboard: AgentGraphClipboard;
  offset: { x: number; y: number };
  createId: () => string;
  takenNames: ReadonlySet<string>;
  knownAgentIds: ReadonlySet<string>;
  managerAgentIds?: ReadonlySet<string>;
  draftCapacity: number;
  stickyCapacity: number;
}): MaterializedPaste {
  const taken = new Set(input.takenNames);
  const managers = input.managerAgentIds ?? input.knownAgentIds;
  let clearedManagers = 0;
  const agents = input.clipboard.agents.slice(0, Math.max(0, input.draftCapacity));
  const stickies = input.clipboard.stickies.slice(0, Math.max(0, input.stickyCapacity));
  const drafts = agents.map((agent): AgentGraphDraft => {
    const name = uniqueCopyName(agent.name, taken);
    taken.add(name.toLowerCase());
    const reportsTo = agent.reportsTo !== null && managers.has(agent.reportsTo) ? agent.reportsTo : null;
    if (agent.reportsTo !== null && reportsTo === null) clearedManagers += 1;
    return {
      id: input.createId(),
      x: agent.x + input.offset.x,
      y: agent.y + input.offset.y,
      name,
      role: agent.role,
      title: agent.title,
      capabilities: agent.capabilities,
      adapterType: agent.adapterType,
      model: agent.model,
      reportsTo,
      sourceAgentId: input.knownAgentIds.has(agent.sourceAgentId) ? agent.sourceAgentId : null,
    };
  });
  return {
    drafts,
    stickies: stickies.map((sticky) => ({
      id: input.createId(),
      x: sticky.x + input.offset.x,
      y: sticky.y + input.offset.y,
      width: sticky.width,
      height: sticky.height,
      text: sticky.text,
      color: sticky.color,
    })),
    droppedAgents: input.clipboard.agents.length - agents.length,
    droppedStickies: input.clipboard.stickies.length - stickies.length,
    clearedManagers,
  };
}

export function resolveDraftManager(draft: AgentGraphDraft, managerAgentIds: ReadonlySet<string>): AgentGraphDraft {
  if (draft.reportsTo === null || managerAgentIds.has(draft.reportsTo)) return draft;
  return { ...draft, reportsTo: null };
}

export function draftToHireRequest(draft: AgentGraphDraft): Record<string, unknown> {
  return {
    name: draft.name,
    role: draft.role,
    title: draft.title,
    capabilities: draft.capabilities,
    adapterType: draft.adapterType,
    adapterConfig: draft.model ? { model: draft.model } : {},
    reportsTo: draft.reportsTo,
  };
}
