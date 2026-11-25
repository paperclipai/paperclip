import { canonicalRunnerToolName } from "../runner-tool-bridge.js";
import { ANTIGRAVITY_PAPERCLIP_MCP_SERVER } from "./antigravity-plan-mode.js";

/**
 * Antigravity sends no tool identity Paperclip can show: ACP titles are display
 * text ("Run mcp_paperclip_paperclip_finish", "File ../../u1.txt", a command
 * line), so without this every row was named after its title. This module
 * gives each call the identity other harnesses send in `paperclipToolDetail`:
 * Paperclip's own tools as `mcp__paperclip__<tool>`, the CLI's native tools
 * under their own names with the command as the subject, and the swarm's
 * progress lines one neutral identity whose subject is the plain sentence.
 */
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The one identity of every swarm progress line; its subject is the sentence. */
export const ANTIGRAVITY_SWARM_UPDATE_TOOL = "swarm_update";

export interface AntigravityToolDetail {
  toolName: string;
  subject?: string;
}

const NATIVE_TOOL = /^[a-z][a-z0-9_]{1,63}$/;
const CLI_PAPERCLIP_PREFIX = `mcp_${ANTIGRAVITY_PAPERCLIP_MCP_SERVER}_`;
/** Ordinary runs title an MCP call `<server>_<tool>`; the CLI says `Run mcp_<server>_<tool>`. */
const TITLED_PAPERCLIP = new RegExp(`^(?:Run )?(?:mcp_)?${ANTIGRAVITY_PAPERCLIP_MCP_SERVER}_([a-z][a-z0-9_]{0,127})\\??$`);
/** Command-line arguments the CLI's shell tools carry. */
const COMMAND_KEYS = ["CommandLine", "commandLine", "command", "Command"];
/** Kinds whose native name an ordinary run never sends, named the way the CLI names them. */
const KIND_TOOLS: Readonly<Record<string, string>> = { execute: "run_command", read: "view_file", edit: "edit_file", delete: "delete_file", move: "move_file" };

function paperclipTool(tool: string): string {
  return `mcp__${ANTIGRAVITY_PAPERCLIP_MCP_SERVER}__${canonicalRunnerToolName(tool)}`;
}

/** The Paperclip bridge tool a call names, from the CLI's native name, ACP `_meta.mcp`, or its title. */
export function antigravityPaperclipToolName(call: { name?: unknown; title?: unknown; _meta?: unknown }): string | null {
  const name = string(call.name);
  if (name?.startsWith(CLI_PAPERCLIP_PREFIX)) return paperclipTool(name.slice(CLI_PAPERCLIP_PREFIX.length));
  const mcp = record(record(call._meta).mcp);
  if (mcp.server === ANTIGRAVITY_PAPERCLIP_MCP_SERVER && string(mcp.tool)) return paperclipTool(string(mcp.tool)!);
  const titled = string(call.title) ? TITLED_PAPERCLIP.exec(string(call.title)!)?.[1] : undefined;
  return titled ? paperclipTool(titled) : null;
}

function command(call: Json): string | undefined {
  const input = { ...record(call.rawInput), ...record(call.args) };
  for (const key of COMMAND_KEYS) {
    const value = string(input[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * Reads of the CLI's own installation (its built-in skills under the run's
 * private Antigravity home) are the CLI loading itself, not work on the task.
 */
export function isAntigravityInternalRead(call: { name?: unknown; kind?: unknown; title?: unknown; locations?: unknown; rawInput?: unknown; args?: unknown }): boolean {
  // Only a read is the CLI loading itself; a command or edit stays visible wherever it points.
  const name = string(call.name);
  if (call.kind !== "read" && !(name && READ_TOOL.test(name))) return false;
  const paths = [
    string(call.title),
    ...(Array.isArray(call.locations) ? call.locations.map(location => string(record(location).path)) : []),
    ...Object.values({ ...record(call.rawInput), ...record(call.args) }).map(string),
  ];
  return paths.some(path => path !== undefined && PRIVATE_CLI_HOME.test(path));
}

const READ_TOOL = /^(?:view|read)_/;
/**
 * The run's private Antigravity home, inside the Runner's own ACPX runtime
 * folder (`…/paperclip-runner/acpx/…/antigravity-home/antigravity-cli/…`). A
 * task folder that merely has a directory named `antigravity-home` is not it.
 */
const PRIVATE_CLI_HOME = /(?:^|[\\/ ])paperclip-runner[\\/]acpx[\\/](?:[^\\/]+[\\/])*?antigravity-home[\\/]antigravity-(?:cli|acp)[\\/]/;

/**
 * The identity of one Antigravity tool call. `name` is the CLI's native tool
 * name (the swarm route reads it from the raw update; ACPX drops it), so an
 * ordinary run falls back to the ACP kind. Null leaves the call unchanged.
 */
export function antigravityToolDetail(call: Json): AntigravityToolDetail | null {
  const paperclip = antigravityPaperclipToolName(call);
  if (paperclip) return { toolName: paperclip };
  const kind = string(call.kind);
  const native = string(call.name);
  const toolName = native && NATIVE_TOOL.test(native) ? native : kind ? KIND_TOOLS[kind] : undefined;
  if (!toolName) return null;
  // A shell call's title is its command line; other titles are display text.
  const title = string(call.title);
  const subject = command(call) ?? (kind === "execute" && title && !/^run command$/i.test(title) ? title : undefined);
  return { toolName, ...(subject ? { subject: subject.slice(0, 4_000) } : {}) };
}
