import { t } from "@/i18n";
/**
 * Provider-neutral tool vocabulary shared by live status, transcript rows,
 * and canonical provider activity. Exact semantic tools get purpose-specific
 * copy; ACP kinds and normalized name prefixes cover future adapters.
 */
import {
  BookOpen,
  Brain,
  ChevronsLeftRightEllipsis,
  CircleHelp,
  Clock3,
  FilePenLine,
  Image,
  ListChecks,
  MessageSquareReply,
  Network,
  Search,
  SearchCode,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { McpIcon } from "./McpIcon";

/** Lucide icons and hand-rolled SVGs (the MCP logo) share this shape. */
export type ToolIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type ToolFamily =
  | "terminal"
  | "grep"
  | "search"
  | "read"
  | "edit"
  | "web"
  | "plan"
  | "question"
  | "agent"
  | "safety"
  | "image"
  | "wait"
  | "mcp"
  | "other";

export interface ToolTaxonomyEntry {
  family: ToolFamily;
  icon: ToolIcon;
  /** Progressive verb for the status pill, without the trailing ellipsis. */
  verbLabel: string;
}

export type ToolClassificationConfidence = "exact" | "kind" | "inferred" | "fallback" | "unnamed";

export interface ToolActivityPresentationInput {
  name?: string | null;
  transport?: string | null;
  namespace?: string | null;
  /** ACP kind or canonical operation. */
  operation?: string | null;
  target?: string | null;
  progress?: string | null;
}

export interface ToolSummaryGroup {
  key: string;
  singular: string;
  plural: string;
}

export interface ToolActivityPresentation {
  icon: ToolIcon;
  family: ToolFamily;
  runningLabel: string;
  completedLabel: string;
  failedLabel: string;
  interruptedLabel: string;
  displayName: string;
  sourceLabel?: string;
  technicalName?: string;
  confidence: ToolClassificationConfidence;
  summaryGroup: ToolSummaryGroup;
}

/** ACPX's placeholder title must never displace real lifecycle identity. */
const GENERIC_TOOL_NAMES = new Set(["tool", "tool call", "tool_call", "acp_tool"]);

export function isGenericToolName(name: string | undefined | null): boolean {
  const raw = (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*\((?:pending|in[_ -]?progress|completed|failed|cancelled|canceled)\)$/, "");
  return !raw || GENERIC_TOOL_NAMES.has(raw);
}

interface McpIdentity {
  namespace: string;
  name: string;
}

export function mcpToolIdentity(name: string): McpIdentity | null {
  const doubleUnderscore = name.match(/^mcp__(.+?)__(.+)$/i);
  if (doubleUnderscore) return { namespace: doubleUnderscore[1], name: doubleUnderscore[2] };
  const dotted = name.match(/^mcp\.([^.]+)\.(.+)$/i);
  return dotted ? { namespace: dotted[1], name: dotted[2] } : null;
}

function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function sentenceCase(words: readonly string[]): string {
  if (words.length === 0) return "";
  const text = words.map((word) => {
    if (["api", "id", "lsp", "mcp", "pr", "url"].includes(word)) return word.toUpperCase();
    return word;
  }).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function humanizeToolName(name: string | undefined | null): string {
  const raw = (name ?? "").trim();
  if (isGenericToolName(raw)) return t("activity-ui:tool.unnamed");
  const mcp = mcpToolIdentity(raw);
  return sentenceCase(identifierWords(mcp?.name ?? raw));
}

/** Humanized MCP tool segment for both mcp__server__tool and mcp.server.tool. */
export function mcpToolSegment(name: string): string | null {
  const identity = mcpToolIdentity(name);
  return identity ? humanizeToolName(identity.name) : null;
}

type Action =
  | "read" | "list" | "search" | "fetch" | "open" | "update" | "create"
  | "delete" | "move" | "run" | "request" | "post" | "start" | "stop"
  | "wait" | "finish" | "block" | "think" | "switch" | "other";

interface ExactAction {
  action: Action;
  copyKey?: string;
  group?: string;
  family?: ToolFamily;
}

const group = (key: string): string => key;

const EXACT_ACTIONS: Record<string, ExactAction> = {
  bash: { action: "run" },
  terminal: { action: "run" },
  shell: { action: "run" },
  command: { action: "run" },
  run: { action: "run" },
  execute: { action: "run" },
  exec_command: { action: "run" },
  apply_patch: { action: "update", copyKey: "tool.exact.apply_patch" },
  read: { action: "read", copyKey: "tool.exact.read" },
  write: { action: "update", copyKey: "tool.exact.write" },
  edit: { action: "update", copyKey: "tool.exact.edit" },
  notebook_read: { action: "read", copyKey: "tool.exact.notebook_read" },
  notebook_edit: { action: "update", copyKey: "tool.exact.notebook_edit" },
  glob: { action: "search", copyKey: "tool.exact.glob" },
  grep: { action: "search", copyKey: "tool.exact.grep", family: "grep" },
  tool_search: { action: "search", copyKey: "tool.exact.tool_search", group: group("tool_search") },
  web_search: { action: "search", copyKey: "tool.exact.web_search", family: "web" },
  web_fetch: { action: "fetch", copyKey: "tool.exact.web_fetch", family: "web" },
  todo_write: { action: "update", copyKey: "tool.exact.todo_write", family: "plan", group: group("task_operation") },
  task_create: { action: "create", copyKey: "tool.exact.task_create", family: "plan", group: group("task_operation") },
  task_update: { action: "update", copyKey: "tool.exact.task_update", family: "plan", group: group("task_operation") },
  task_list: { action: "list", copyKey: "tool.exact.task_list", family: "plan", group: group("task_operation") },
  task_get: { action: "read", copyKey: "tool.exact.task_get", family: "plan", group: group("task_operation") },
  enter_plan_mode: { action: "switch", copyKey: "tool.exact.enter_plan_mode", family: "plan" },
  exit_plan_mode: { action: "switch", copyKey: "tool.exact.exit_plan_mode", family: "plan" },
  skill: { action: "read", copyKey: "tool.exact.skill" },
  ask_user_question: { action: "request", copyKey: "tool.exact.ask_user_question", family: "question" },
  request_human_input: { action: "request", copyKey: "tool.exact.request_human_input", family: "question", group: group("task_operation") },
  agent: { action: "start", copyKey: "tool.exact.agent", family: "agent" },
  task: { action: "start", copyKey: "tool.exact.task", family: "agent" },
  task_output: { action: "read", copyKey: "tool.exact.task_output", family: "agent" },
  task_stop: { action: "stop", copyKey: "tool.exact.task_stop", family: "agent" },
  send_message: { action: "post", copyKey: "tool.exact.send_message", family: "agent" },
  spawn_agent: { action: "start", copyKey: "tool.exact.spawn_agent", family: "agent" },
  wait_agent: { action: "wait", copyKey: "tool.exact.wait_agent", family: "agent" },
  wait_threads: { action: "wait", copyKey: "tool.exact.wait_threads", family: "agent" },
  interrupt_agent: { action: "stop", copyKey: "tool.exact.interrupt_agent", family: "agent" },
  report_findings: { action: "post", copyKey: "tool.exact.report_findings", family: "safety" },
  guardian_review: { action: "think", copyKey: "tool.exact.guardian_review", family: "safety" },
  lsp: { action: "read", copyKey: "tool.exact.lsp" },
  compact_conversation: { action: "think", copyKey: "tool.exact.compact_conversation" },
  image_generation: { action: "create", copyKey: "tool.exact.image_generation", family: "image" },
  view_image: { action: "read", copyKey: "tool.exact.view_image", family: "image" },
  multi_tool_use_parallel: { action: "run", copyKey: "tool.exact.multi_tool_use_parallel" },
  get_task_context: { action: "read", copyKey: "tool.exact.get_task_context" },
  get_task_history: { action: "read", copyKey: "tool.exact.get_task_history" },
  list_documents: { action: "list", copyKey: "tool.exact.list_documents" },
  read_document: { action: "read", copyKey: "tool.exact.read_document" },
  list_document_revisions: { action: "list", copyKey: "tool.exact.list_document_revisions" },
  report_progress: { action: "post", copyKey: "tool.exact.report_progress" },
  answer_status_question: { action: "post", copyKey: "tool.exact.answer_status_question" },
  write_document: { action: "update", copyKey: "tool.exact.write_document" },
  register_deliverable: { action: "create", copyKey: "tool.exact.register_deliverable" },
  finish_task: { action: "finish", copyKey: "tool.exact.finish_task" },
  paperclip_finish: { action: "finish", copyKey: "tool.exact.paperclip_finish" },
  block_task: { action: "block", copyKey: "tool.exact.block_task" },
  paperclip_block: { action: "block", copyKey: "tool.exact.paperclip_block" },
  request_review: { action: "request", copyKey: "tool.exact.request_review" },
  list_agents: { action: "list", copyKey: "tool.exact.list_agents" },
  get_agent: { action: "read", copyKey: "tool.exact.get_agent" },
  search_tasks: { action: "search", copyKey: "tool.exact.search_tasks" },
  list_approvals: { action: "list", copyKey: "tool.exact.list_approvals" },
  get_approval: { action: "read", copyKey: "tool.exact.get_approval" },
  get_approval_context: { action: "read", copyKey: "tool.exact.get_approval_context" },
  get_workspace_runtime: { action: "read", copyKey: "tool.exact.get_workspace_runtime" },
  control_workspace_service: { action: "run", copyKey: "tool.exact.control_workspace_service" },
  set_dependencies: { action: "update", copyKey: "tool.exact.set_dependencies" },
  set_task_title: { action: "update", copyKey: "tool.exact.set_task_title" },
  create_task: { action: "create", copyKey: "tool.exact.create_task" },
  request_approval: { action: "request", copyKey: "tool.exact.request_approval" },
  decide_approval: { action: "update", copyKey: "tool.exact.decide_approval" },
  comment_on_approval: { action: "post", copyKey: "tool.exact.comment_on_approval" },
  schedule_wake: { action: "create", copyKey: "tool.exact.schedule_wake", family: "wait" },
  generic_api_request: { action: "request", copyKey: "tool.exact.generic_api_request" },
};

const ACTION_PREFIXES: Record<Action, readonly string[]> = {
  read: ["get", "read", "inspect", "view"],
  list: ["list", "glob"],
  search: ["find", "search", "grep", "query", "lookup"],
  fetch: ["fetch", "browse"],
  open: ["open"],
  update: ["write", "edit", "update", "set", "patch", "upsert", "sync"],
  create: ["create", "add", "register", "upload"],
  delete: ["delete", "remove"],
  move: ["move", "rename"],
  run: ["run", "execute", "bash", "shell", "command"],
  request: ["request", "ask", "prompt"],
  post: ["send", "message", "comment", "report", "answer"],
  start: ["start", "spawn", "delegate"],
  stop: ["stop", "cancel", "interrupt"],
  wait: ["wait", "sleep", "poll"],
  finish: ["finish", "complete"],
  block: ["block"],
  think: ["think", "reason", "compact", "review"],
  switch: ["switch", "enter", "exit"],
  other: [],
};

const OPERATION_ACTIONS: Record<string, Action> = {
  read: "read",
  edit: "update",
  delete: "delete",
  move: "move",
  search: "search",
  list: "list",
  execute: "run",
  think: "think",
  fetch: "fetch",
  switch_mode: "switch",
};

function normalizedKey(name: string): string {
  return identifierWords(name).join("_");
}

function inferredAction(words: readonly string[]): Action | null {
  const first = words[0];
  if (!first) return null;
  for (const [action, prefixes] of Object.entries(ACTION_PREFIXES) as Array<[Action, readonly string[]]>) {
    if (prefixes.includes(first)) return action;
  }
  return null;
}

function actionFamily(action: Action): ToolFamily {
  if (action === "run") return "terminal";
  if (action === "read" || action === "list") return "read";
  if (action === "search") return "search";
  if (action === "fetch" || action === "open") return "web";
  if (["update", "create", "delete", "move"].includes(action)) return "edit";
  if (action === "request") return "question";
  if (action === "start" || action === "stop") return "agent";
  if (action === "wait") return "wait";
  return "other";
}

const FAMILY_ICONS: Record<ToolFamily, ToolIcon> = {
  terminal: Terminal,
  grep: SearchCode,
  search: Search,
  read: BookOpen,
  edit: FilePenLine,
  web: ChevronsLeftRightEllipsis,
  plan: ListChecks,
  question: CircleHelp,
  agent: Network,
  safety: ShieldCheck,
  image: Image,
  wait: Clock3,
  mcp: McpIcon,
  other: Wrench,
};

function actionCopy(key: string, object?: string) {
  return {
    running: t(`activity-ui:${key}.running`, { object }),
    completed: t(`activity-ui:${key}.completed`, { object }),
    failed: t(`activity-ui:${key}.failed`, { object }),
    interrupted: t(`activity-ui:${key}.interrupted`, { object }),
  };
}

function defaultSummaryGroup(action: Action): string {
  switch (action) {
    case "run": return group("command");
    case "read":
    case "list": return group("read");
    case "search": return group("search");
    case "update":
    case "create":
    case "delete":
    case "move": return group("file_change");
    case "start":
    case "stop": return group("delegation");
    case "wait": return group("wait");
    default: return group("tool_action");
  }
}

function paperclipSummaryGroup(action: Action): string {
  if (action === "read" || action === "list") return group("paperclip_read");
  return group("task_operation");
}

/**
 * Resolve one tool into status-specific copy and iconography. Precedence is:
 * exact aliases, canonical ACP operation/kind, normalized verb, then a named
 * fallback. MCP remains visible as the source icon without losing semantics.
 */
export function toolActivityPresentation(input: ToolActivityPresentationInput): ToolActivityPresentation {
  const rawName = (input.name ?? "").trim();
  const parsedMcp = mcpToolIdentity(rawName);
  const namespace = (input.namespace ?? parsedMcp?.namespace ?? "").trim();
  // The name itself is authoritative for historical ACPX records that were
  // persisted as builtin before MCP transport normalization existed.
  const transport = (parsedMcp ? "mcp" : input.transport ?? "builtin").toLowerCase();
  const semanticName = (parsedMcp?.name ?? rawName).trim();
  const words = identifierWords(semanticName);
  const key = normalizedKey(semanticName);
  const exact = EXACT_ACTIONS[key];
  const operationAction = OPERATION_ACTIONS[(input.operation ?? "").trim().toLowerCase()];
  const inferred = inferredAction(words);
  const action = exact?.action ?? operationAction ?? inferred ?? "other";
  const confidence: ToolClassificationConfidence = exact
    ? "exact"
    : operationAction
      ? "kind"
      : inferred
        ? "inferred"
        : isGenericToolName(semanticName)
          ? "unnamed"
          : "fallback";
  const displayName = humanizeToolName(semanticName);
  const identifierLikeName = /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(semanticName);
  const objectWords = inferred && identifierLikeName && words.length > 1 ? words.slice(1) : [];
  const object = objectWords.length ? sentenceCase(objectWords).replace(/^./, (letter) => letter.toLowerCase()) : undefined;
  const copyKey = exact?.copyKey
    ?? (action === "other"
      ? isGenericToolName(semanticName) ? "tool.unnamedAction" : "tool.namedAction"
      : `tool.action.${action}.${!exact && object ? "object" : "default"}`);
  const copy = actionCopy(copyKey, action === "other" ? displayName : object);
  const semanticFamily = exact?.family ?? actionFamily(action);
  const family = transport === "mcp" ? "mcp" : semanticFamily;
  const sourceLabel = namespace
    ? humanizeToolName(namespace)
    : transport === "mcp"
      ? "MCP"
      : undefined;
  const summaryGroupKey = namespace.toLowerCase() === "paperclip"
    ? paperclipSummaryGroup(action)
    : exact?.group ?? defaultSummaryGroup(action);

  return {
    icon: FAMILY_ICONS[family],
    family,
    runningLabel: copy.running,
    completedLabel: copy.completed,
    failedLabel: copy.failed,
    interruptedLabel: copy.interrupted,
    displayName,
    sourceLabel,
    technicalName: rawName || undefined,
    confidence,
    summaryGroup: {
      key: summaryGroupKey,
      singular: t(`activity-ui:tool.group.${summaryGroupKey}.singular`),
      plural: t(`activity-ui:tool.group.${summaryGroupKey}.plural`),
    },
  };
}

/** Compact compatibility mapping used by legacy tool rows and live pills. */
export function toolTaxonomy(name: string | undefined | null): ToolTaxonomyEntry {
  const presentation = toolActivityPresentation({ name });
  return {
    family: presentation.family,
    icon: presentation.icon,
    verbLabel: presentation.runningLabel,
  };
}

/** Icons for tool-free informative statuses. */
export function statusLabelIcon(label: string | undefined | null): ToolIcon | null {
  const raw = (label ?? "").trim().toLowerCase();
  if (raw === "thinking") return Brain;
  if (raw === "responding" || raw.startsWith("responding (")) return MessageSquareReply;
  return null;
}
