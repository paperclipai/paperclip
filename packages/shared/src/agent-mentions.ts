export const AGENT_MENTION_SCHEME = "agent://";

const AGENT_MENTION_LINK_RE = /\[[^\]]*]\((agent:\/\/[^)\s]+)\)/gi;

export interface ParsedAgentMention {
  agentId: string;
}

export function buildAgentMentionHref(agentId: string): string {
  return `${AGENT_MENTION_SCHEME}${agentId.trim()}`;
}

export function parseAgentMentionHref(href: string): ParsedAgentMention | null {
  if (!href.startsWith(AGENT_MENTION_SCHEME)) return null;
  const agentId = href.slice(AGENT_MENTION_SCHEME.length).trim();
  if (!agentId) return null;
  return { agentId };
}

export function extractAgentMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(AGENT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseAgentMentionHref(match[1]);
    if (parsed) ids.add(parsed.agentId);
  }
  return [...ids];
}
