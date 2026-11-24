import sample from "../../../fixtures/antigravity-swarm.sample.json";

export type SwarmSource = "live" | "files" | "text" | "google";

export const SOURCE_LABEL: Record<SwarmSource, string> = {
  live: "Live",
  files: "Swarm files",
  text: "Parsed text",
  google: "Needs Google",
};

export const SOURCE_DETAIL: Record<SwarmSource, string> = {
  live: "Sent live by the coordinator while it works",
  files: "Read from the files the swarm keeps in Paperclip's private folder",
  text: "Parsed from what the coordinator writes",
  google: "Not sent by Google today",
};

export type SwarmStatus = "starting" | "running" | "stopping" | "stopped" | "failed" | "refused" | "completed";
export type HelperState = "starting" | "working" | "waiting" | "in_review" | "done" | "blocked" | "stopped";
export type HelperRole = "helper" | "verifier" | "monitor";
export type PostKind = "brief" | "done" | "update" | "blocked" | "stall" | "finish";

export interface SwarmHelper {
  name: string;
  role: HelperRole;
  task: string;
  brief: string;
  state: HelperState;
  action?: string;
  model?: string;
  tokens?: { input: number; output: number };
}

export interface SwarmPost {
  seq: number;
  author: string;
  text: string;
  at: string;
  kind: PostKind;
}

export interface SwarmThread {
  id: string;
  title: string;
  goal: string;
  helpers: string[];
}

export interface SwarmView {
  request: string;
  title: string;
  goal: { title: string; line: string };
  status: SwarmStatus;
  startedAt: string;
  helpers: SwarmHelper[];
  posts: SwarmPost[];
  threads: SwarmThread[];
  usage?: { total: number; input: number; output: number };
  model: string;
  reason?: string;
  files?: string[];
  synthetic?: boolean;
}

interface SampleAction { at: string; tool: string; summary?: string; target?: string }
interface SampleWorker { model?: string; tokens: { input: number; output: number }; actions: SampleAction[] }
interface SampleBoardPost { seq: number; agent: string; text: string; time: string; kind?: string }
interface SampleAcp { kind: string; name?: string; rawInput?: Record<string, unknown>; result?: { usage?: Record<string, number> } }
interface SamplePlan { goal: { title: string; line: string }; tasks: Record<string, string>; threads: { id: string; title: string; goal: string; tasks: string[] }[] }

const acp = sample.acp as SampleAcp[];
const files = sample.files as Record<string, unknown>;
const plan = files["swarm/plan.json"] as SamplePlan;
const board = files["swarm/board.jsonl"] as SampleBoardPost[];
const workers = files["worker transcripts (summarised)"] as Record<string, SampleWorker>;

function fileName(path?: string): string | undefined {
  if (!path) return undefined;
  return path.replace(/^<task-folder>\/?/, "").split("/").pop() || undefined;
}

export function actionLabel(action: SampleAction): string {
  if (action.summary) return action.summary;
  switch (action.tool) {
    case "read_board": return "Reading the messages";
    case "swarm_wait": return "Waiting for a message";
    case "post_message": return "Posting an update";
    case "write_file": return `Writing ${fileName(action.target) ?? "a file"}`;
    case "read_file": return `Reading ${fileName(action.target) ?? "a file"}`;
    case "schedule": return "Setting a stall timer";
    case "run_command": return "Running a command";
    default: return "Working";
  }
}

export function plainBrief(brief: string): string {
  const first = /^(.+?[.!?])(\s|$)/.exec(brief.replace(/\s+/g, " ").trim())?.[1] ?? brief;
  return first.replace(/\s*ONLY\b/g, "").replace(/[.!?]$/, "");
}

function roleOf(name: string): HelperRole {
  if (/^verifier/.test(name)) return "verifier";
  if (/^monitor/.test(name)) return "monitor";
  return "helper";
}

export function postKind(author: string, text: string, kind?: string): PostKind {
  if (kind === "brief") return "brief";
  if (/\[stall\]/i.test(text)) return "stall";
  if (/\[blocked\]|permission check failed|timed out waiting/i.test(text)) return "blocked";
  if (/\[done\]/i.test(text)) return author === "coordinator" ? "finish" : "done";
  return "update";
}

export function plainPost(text: string): string {
  return text.replace(/^(@[a-z0-9#_-]+\s*)+/i, "").replace(/\[(done|blocked|stall|update)\]\s*/gi, "").replace(/\s+/g, " ").trim();
}

const adds = acp.filter((event) => event.name === "swarm" && event.rawInput?.action === "add");
const titleEvent = acp.find((event) => event.name === "swarm" && event.rawInput?.action === "title");
const usageEvent = acp.find((event) => event.kind === "prompt_result");

export const REAL_RUN = {
  request: sample.request,
  title: String(titleEvent?.rawInput?.title ?? plan.goal.title),
  startedAt: board[0]!.time,
  lastSeq: board.at(-1)!.seq,
  addedHelpers: adds.map((event) => ({ name: String(event.rawInput?.name), brief: String(event.rawInput?.brief ?? "") })),
};

function seqTime(seq: number): string {
  return board.find((post) => post.seq === seq)?.time ?? board.at(-1)!.time;
}

export function deriveRealSwarm(atSeq: number, status: SwarmStatus = "running"): SwarmView {
  const until = seqTime(atSeq);
  const posts: SwarmPost[] = board
    .filter((post) => post.seq <= atSeq)
    .map((post) => ({ seq: post.seq, author: post.agent, text: post.text, at: post.time, kind: postKind(post.agent, post.text, post.kind) }));
  const verified = posts.some((post) => post.author.startsWith("verifier") && post.kind === "done");
  const helpers: SwarmHelper[] = adds.map((event) => {
    const name = String(event.rawInput?.name);
    const role = roleOf(name);
    const worker = workers[name];
    const seen = (worker?.actions ?? []).filter((action) => action.at <= until);
    const last = seen.at(-1);
    const posted = posts.some((post) => post.author === name && post.kind === "done");
    let state: HelperState = seen.length ? "working" : "starting";
    if (role === "monitor") state = "waiting";
    else if (posted && role === "verifier") state = "done";
    else if (posted) state = verified ? "done" : "in_review";
    else if (last?.tool === "swarm_wait") state = "waiting";
    if (status === "stopped" && state !== "done") state = "stopped";
    const settled = state === "done" || state === "in_review" || state === "stopped";
    return {
      name,
      role,
      task: plan.tasks[name] ?? plainBrief(String(event.rawInput?.brief ?? "")),
      brief: plainBrief(String(event.rawInput?.brief ?? "")),
      state,
      action: settled ? undefined : role === "monitor" ? "Watching for stalls" : last ? actionLabel(last) : undefined,
      model: worker?.model,
      tokens: worker ? { input: worker.tokens.input, output: worker.tokens.output } : undefined,
    };
  });
  const usage = usageEvent?.result?.usage;
  const finished = status === "completed" || status === "stopped";
  return {
    request: REAL_RUN.request,
    title: REAL_RUN.title,
    goal: plan.goal,
    status,
    startedAt: REAL_RUN.startedAt,
    helpers,
    posts,
    threads: plan.threads.map((thread) => ({ id: thread.id, title: thread.title, goal: thread.goal, helpers: thread.tasks })),
    usage: finished && usage ? { total: usage.totalTokens ?? 0, input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } : undefined,
    model: "Gemini 4 Neon",
    files: status === "completed" ? ["README.md", "convert.js", "index.html", "style.css"] : undefined,
  };
}

export interface SwarmProgress {
  done: number;
  inReview: number;
  blocked: number;
  total: number;
  threadsOpen: number;
}

function members(view: SwarmView, thread: SwarmThread): SwarmHelper[] {
  return thread.helpers
    .map((name) => view.helpers.find((helper) => helper.name === name))
    .filter((helper): helper is SwarmHelper => Boolean(helper && helper.role !== "monitor"));
}

export function swarmProgress(view: SwarmView): SwarmProgress {
  const workers = view.helpers.filter((helper) => helper.role !== "monitor");
  return {
    done: workers.filter((helper) => helper.state === "done").length,
    inReview: workers.filter((helper) => helper.state === "in_review").length,
    blocked: workers.filter((helper) => helper.state === "blocked").length,
    total: workers.length,
    threadsOpen: view.threads.filter((thread) => members(view, thread).some((helper) => helper.state !== "done")).length,
  };
}

export function progressLine(view: SwarmView): string {
  const progress = swarmProgress(view);
  const parts = [`${progress.done} of ${progress.total} done`];
  if (progress.inReview) parts.push(`${progress.inReview} in review`);
  if (progress.blocked) parts.push(`${progress.blocked} blocked`);
  if (view.threads.length) parts.push(`${progress.threadsOpen} ${progress.threadsOpen === 1 ? "thread" : "threads"} open`);
  return parts.join(" · ");
}

export function threadState(view: SwarmView, thread: SwarmThread): HelperState {
  const list = members(view, thread);
  if (list.some((helper) => helper.state === "blocked")) return "blocked";
  if (list.length && list.every((helper) => helper.state === "done")) return "done";
  if (list.some((helper) => helper.state === "stopped")) return "stopped";
  if (list.some((helper) => helper.state === "working" || helper.state === "starting")) return "working";
  if (list.some((helper) => helper.state === "in_review")) return "in_review";
  return "waiting";
}

export function threadNow(view: SwarmView, thread: SwarmThread): string {
  const list = members(view, thread);
  const blocked = list.find((helper) => helper.state === "blocked");
  if (blocked) return `${blocked.name} is blocked`;
  const active = list.find((helper) => helper.state === "working" && helper.action);
  if (active) return `${active.name}: ${active.action}`;
  if (list.length && list.every((helper) => helper.state === "done")) return "Delivered";
  if (list.some((helper) => helper.state === "in_review")) return "Waiting for the verifier";
  return "Waiting";
}

export function threadCount(view: SwarmView, thread: SwarmThread): string {
  const list = members(view, thread);
  return `${list.filter((helper) => helper.state === "done").length}/${list.length}`;
}
