/**
 * The one rule for reading a slash command as a real user request.
 *
 * Source of trust: the caller passes only text the signed-in user typed and
 * submitted themselves in Paperclip's task composer (a comment body, or the
 * body of a new task). Never pass agent-authored text, chat or connector
 * messages, API-posted text, issue descriptions written by someone else, or
 * any prompt Paperclip assembles for an agent. Those stay ordinary text, and
 * harness guards (for example Antigravity's native-command neutraliser) keep
 * them from acting as commands.
 *
 * Within that text, only a command at the very start counts: optional
 * whitespace, then `/name`, then whitespace or the end. The name is exact and
 * lower-case, and must be in the caller's allowlist. Whitespace follows the
 * Python rules the Antigravity server uses (U+001C-U+001F count, U+FEFF does
 * not), so this never accepts a command boundary the server would not.
 */
export interface LeadingUserCommand<Name extends string = string> {
  command: Name;
  /** The rest of the message, trimmed. Empty when only the command was sent. */
  argument: string;
}

const WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING = new RegExp(`^[${WHITESPACE}]*\\/([a-z]+)(?=[${WHITESPACE}]|$)`);
const TRIM = new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, "g");

export function parseLeadingUserCommand<Name extends string>(
  userAuthoredText: string,
  allowlist: readonly Name[],
): LeadingUserCommand<Name> | null {
  const match = LEADING.exec(userAuthoredText);
  if (!match || !(allowlist as readonly string[]).includes(match[1]!)) return null;
  return { command: match[1] as Name, argument: userAuthoredText.slice(match[0].length).replace(TRIM, "") };
}

/**
 * The longest `/swarm` request (the text after the command) a swarm accepts,
 * in UTF-16 code units. The composer and the server refuse longer requests up
 * front; the Paperclip Runner enforces the same bound on its own.
 */
export const SWARM_REQUEST_MAX_CHARS = 16_000;

/** A Google Antigravity agent: the only kind of agent that runs a /swarm. */
export function isAntigravityAgent(agent: { adapterType: string; adapterConfig: unknown } | null | undefined): boolean {
  const config = agent?.adapterConfig !== null && typeof agent?.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
    ? agent.adapterConfig as Record<string, unknown> : {};
  return agent?.adapterType === "paperclip_runner" && config.provider === "acpx" && config.acpxAgent === "antigravity";
}

/** Helpers change files, so only a standard task runs a swarm (an allow-list; Plan, Ask and others never do). */
export function antigravitySwarmWorkModeAllows(workMode: string | null | undefined): boolean {
  return workMode === "standard";
}

/**
 * Whether `/swarm` reaches this assignee as a swarm: a Google Antigravity agent,
 * the instance's experimental Antigravity swarm setting on, and a standard
 * task. The composer uses it for its hint; the server checks the same rule
 * (and more, such as a remote environment) on send.
 */
export function antigravitySwarmAvailable(
  agent: { adapterType: string; adapterConfig: unknown } | null | undefined,
  experimental: { enableAntigravitySwarm?: boolean } | null | undefined,
  workMode: string | null | undefined,
): boolean {
  return experimental?.enableAntigravitySwarm === true && isAntigravityAgent(agent) && antigravitySwarmWorkModeAllows(workMode);
}
