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
  if (isGenericToolName(raw)) return "Unnamed tool";
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
  running?: string;
  completed?: string;
  group?: ToolSummaryGroup;
  family?: ToolFamily;
}

const group = (key: string, singular: string, plural: string): ToolSummaryGroup => ({ key, singular, plural });

const EXACT_ACTIONS: Record<string, ExactAction> = {
  bash: { action: "run" },
  terminal: { action: "run" },
  shell: { action: "run" },
  command: { action: "run" },
  run: { action: "run" },
  execute: { action: "run" },
  exec_command: { action: "run" },
  apply_patch: { action: "update", running: "Applying a patch", completed: "Applied a patch" },
  read: { action: "read", running: "Reading a file", completed: "Read a file" },
  write: { action: "update", running: "Writing a file", completed: "Wrote a file" },
  edit: { action: "update", running: "Editing a file", completed: "Edited a file" },
  notebook_read: { action: "read", running: "Reading a notebook", completed: "Read a notebook" },
  notebook_edit: { action: "update", running: "Editing a notebook", completed: "Edited a notebook" },
  glob: { action: "search", running: "Searching files", completed: "Searched files" },
  grep: { action: "search", running: "Searching file contents", completed: "Searched file contents", family: "grep" },
  tool_search: { action: "search", running: "Searching available tools", completed: "Searched available tools", group: group("tool_search", "tool search", "tool searches") },
  web_search: { action: "search", running: "Searching the web", completed: "Searched the web", family: "web" },
  web_fetch: { action: "fetch", running: "Fetching a web page", completed: "Fetched a web page", family: "web" },
  todo_write: { action: "update", running: "Updating the task list", completed: "Updated the task list", family: "plan", group: group("task_operation", "task operation", "task operations") },
  task_create: { action: "create", running: "Creating a task", completed: "Created a task", family: "plan", group: group("task_operation", "task operation", "task operations") },
  task_update: { action: "update", running: "Updating a task", completed: "Updated a task", family: "plan", group: group("task_operation", "task operation", "task operations") },
  task_list: { action: "list", running: "Listing tasks", completed: "Listed tasks", family: "plan", group: group("task_operation", "task operation", "task operations") },
  task_get: { action: "read", running: "Reading a task", completed: "Read a task", family: "plan", group: group("task_operation", "task operation", "task operations") },
  enter_plan_mode: { action: "switch", running: "Entering plan mode", completed: "Entered plan mode", family: "plan" },
  exit_plan_mode: { action: "switch", running: "Leaving plan mode", completed: "Left plan mode", family: "plan" },
  skill: { action: "read", running: "Loading a skill", completed: "Loaded a skill" },
  ask_user_question: { action: "request", running: "Requesting input", completed: "Requested input", family: "question" },
  request_human_input: { action: "request", running: "Requesting input", completed: "Requested input", family: "question", group: group("task_operation", "task operation", "task operations") },
  agent: { action: "start", running: "Starting a subagent", completed: "Started a subagent", family: "agent" },
  task: { action: "start", running: "Starting a subagent", completed: "Started a subagent", family: "agent" },
  task_output: { action: "read", running: "Checking subagent progress", completed: "Checked subagent progress", family: "agent" },
  task_stop: { action: "stop", running: "Stopping a subagent", completed: "Stopped a subagent", family: "agent" },
  send_message: { action: "post", running: "Messaging a subagent", completed: "Messaged a subagent", family: "agent" },
  spawn_agent: { action: "start", running: "Starting a subagent", completed: "Started a subagent", family: "agent" },
  wait_agent: { action: "wait", running: "Checking subagent progress", completed: "Checked subagent progress", family: "agent" },
  wait_threads: { action: "wait", running: "Checking task progress", completed: "Checked task progress", family: "agent" },
  interrupt_agent: { action: "stop", running: "Interrupting a subagent", completed: "Interrupted a subagent", family: "agent" },
  report_findings: { action: "post", running: "Reporting findings", completed: "Reported findings", family: "safety" },
  guardian_review: { action: "think", running: "Reviewing safety", completed: "Reviewed safety", family: "safety" },
  lsp: { action: "read", running: "Inspecting code intelligence", completed: "Inspected code intelligence" },
  compact_conversation: { action: "think", running: "Compacting context", completed: "Compacted context" },
  image_generation: { action: "create", running: "Generating an image", completed: "Generated an image", family: "image" },
  view_image: { action: "read", running: "Viewing an image", completed: "Viewed an image", family: "image" },
  multi_tool_use_parallel: { action: "run", running: "Running tools in parallel", completed: "Ran tools in parallel" },
  get_task_context: { action: "read", running: "Reading task context", completed: "Read task context" },
  get_task_history: { action: "read", running: "Reading task history", completed: "Read task history" },
  list_documents: { action: "list", running: "Listing documents", completed: "Listed documents" },
  read_document: { action: "read", running: "Reading a document", completed: "Read a document" },
  list_document_revisions: { action: "list", running: "Listing document revisions", completed: "Listed document revisions" },
  report_progress: { action: "post", running: "Reporting progress", completed: "Reported progress" },
  answer_status_question: { action: "post", running: "Answering a status question", completed: "Answered a status question" },
  write_document: { action: "update", running: "Writing a document", completed: "Wrote a document" },
  register_deliverable: { action: "create", running: "Registering a deliverable", completed: "Registered a deliverable" },
  finish_task: { action: "finish", running: "Reporting completion", completed: "Reported completion" },
  paperclip_finish: { action: "finish", running: "Reporting completion", completed: "Reported completion" },
  block_task: { action: "block", running: "Reporting a blocker", completed: "Reported a blocker" },
  paperclip_block: { action: "block", running: "Reporting a blocker", completed: "Reported a blocker" },
  request_review: { action: "request", running: "Requesting review", completed: "Requested review" },
  list_agents: { action: "list", running: "Listing agents", completed: "Listed agents" },
  get_agent: { action: "read", running: "Reading agent details", completed: "Read agent details" },
  search_tasks: { action: "search", running: "Searching tasks", completed: "Searched tasks" },
  list_approvals: { action: "list", running: "Listing approvals", completed: "Listed approvals" },
  get_approval: { action: "read", running: "Reading an approval", completed: "Read an approval" },
  get_approval_context: { action: "read", running: "Reading approval context", completed: "Read approval context" },
  get_workspace_runtime: { action: "read", running: "Reading workspace status", completed: "Read workspace status" },
  control_workspace_service: { action: "run", running: "Controlling a workspace service", completed: "Controlled a workspace service" },
  set_dependencies: { action: "update", running: "Updating task dependencies", completed: "Updated task dependencies" },
  create_task: { action: "create", running: "Creating a task", completed: "Created a task" },
  request_approval: { action: "request", running: "Requesting approval", completed: "Requested approval" },
  decide_approval: { action: "update", running: "Deciding an approval", completed: "Decided an approval" },
  comment_on_approval: { action: "post", running: "Commenting on an approval", completed: "Commented on an approval" },
  schedule_wake: { action: "create", running: "Scheduling a wake-up", completed: "Scheduled a wake-up", family: "wait" },
  generic_api_request: { action: "request", running: "Calling the Paperclip API", completed: "Called the Paperclip API" },
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

function actionCopy(action: Action, object: string | undefined): { running: string; completed: string } {
  const suffix = object ? ` ${object}` : "";
  switch (action) {
    case "read": return { running: `Reading${suffix || " data"}`, completed: `Read${suffix || " data"}` };
    case "list": return { running: `Listing${suffix || " items"}`, completed: `Listed${suffix || " items"}` };
    case "search": return { running: `Searching${suffix || ""}`, completed: `Searched${suffix || ""}` };
    case "fetch": return { running: `Fetching${suffix || " data"}`, completed: `Fetched${suffix || " data"}` };
    case "open": return { running: `Opening${suffix || " an item"}`, completed: `Opened${suffix || " an item"}` };
    case "update": return { running: `Updating${suffix || " data"}`, completed: `Updated${suffix || " data"}` };
    case "create": return { running: `Creating${suffix || " an item"}`, completed: `Created${suffix || " an item"}` };
    case "delete": return { running: `Deleting${suffix || " an item"}`, completed: `Deleted${suffix || " an item"}` };
    case "move": return { running: `Moving${suffix || " an item"}`, completed: `Moved${suffix || " an item"}` };
    case "run": return { running: "Running a command", completed: "Ran a command" };
    case "request": return { running: `Requesting${suffix || " input"}`, completed: `Requested${suffix || " input"}` };
    case "post": return { running: `Posting${suffix || " an update"}`, completed: `Posted${suffix || " an update"}` };
    case "start": return { running: `Starting${suffix || " an operation"}`, completed: `Started${suffix || " an operation"}` };
    case "stop": return { running: `Stopping${suffix || " an operation"}`, completed: `Stopped${suffix || " an operation"}` };
    case "wait": return { running: "Waiting", completed: "Finished waiting" };
    case "finish": return { running: "Reporting completion", completed: "Reported completion" };
    case "block": return { running: "Reporting a blocker", completed: "Reported a blocker" };
    case "think": return { running: "Thinking", completed: "Finished thinking" };
    case "switch": return { running: `Switching${suffix || " mode"}`, completed: `Switched${suffix || " mode"}` };
    case "other": return { running: "Running", completed: "Ran" };
  }
}

function defaultSummaryGroup(action: Action): ToolSummaryGroup {
  switch (action) {
    case "run": return group("command", "command", "commands");
    case "read":
    case "list": return group("read", "read", "reads");
    case "search": return group("search", "search", "searches");
    case "update":
    case "create":
    case "delete":
    case "move": return group("file_change", "file change", "file changes");
    case "start":
    case "stop": return group("delegation", "delegation", "delegations");
    case "wait": return group("wait", "wait", "waits");
    default: return group("tool_action", "tool action", "tool actions");
  }
}

function paperclipSummaryGroup(action: Action): ToolSummaryGroup {
  if (action === "read" || action === "list") return group("paperclip_read", "Paperclip read", "Paperclip reads");
  return group("task_operation", "task operation", "task operations");
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
  const displayName = isGenericToolName(semanticName) ? "Unnamed tool" : humanizeToolName(semanticName);
  const identifierLikeName = /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(semanticName);
  const objectWords = inferred && identifierLikeName && words.length > 1 ? words.slice(1) : [];
  const object = objectWords.length ? sentenceCase(objectWords).replace(/^./, (letter) => letter.toLowerCase()) : undefined;
  const copy = exact?.running && exact.completed
    ? { running: exact.running, completed: exact.completed }
    : action === "other"
      ? isGenericToolName(semanticName)
        ? { running: "Running an unnamed tool", completed: "Ran an unnamed tool" }
        : { running: `Running ${displayName}`, completed: `Ran ${displayName}` }
      : actionCopy(action, exact ? undefined : object);
  const semanticFamily = exact?.family ?? actionFamily(action);
  const family = transport === "mcp" ? "mcp" : semanticFamily;
  const sourceLabel = namespace
    ? humanizeToolName(namespace)
    : transport === "mcp"
      ? "MCP"
      : undefined;
  const summaryGroup = namespace.toLowerCase() === "paperclip"
    ? paperclipSummaryGroup(action)
    : exact?.group ?? defaultSummaryGroup(action);

  return {
    icon: FAMILY_ICONS[family],
    family,
    runningLabel: copy.running,
    completedLabel: copy.completed,
    failedLabel: `${copy.completed} · failed`,
    interruptedLabel: `${copy.running} · stopped`,
    displayName,
    sourceLabel,
    technicalName: rawName || undefined,
    confidence,
    summaryGroup,
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
