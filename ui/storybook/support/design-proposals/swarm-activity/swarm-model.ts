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
  usage?: { total: number; input: number; output: number; helpers?: { input: number; output: number } };
  model: string;
  reason?: string;
  files?: string[];
  synthetic?: boolean;
}

export interface SwarmAction { at: string; tool: string; summary?: string; target?: string }
export interface SwarmWorker { model?: string; tokens: { input: number; output: number }; actions: SwarmAction[] }
export interface SwarmBoardPost { seq: number; agent: string; text: string; time: string; kind?: string }
export interface SwarmAdd { name: string; brief: string }
export interface SwarmPlan { goal: { title: string; line: string }; tasks: Record<string, string>; threads: { id: string; title: string; goal: string; tasks: string[] }[] }

export interface SwarmFixture {
  request: string;
  model: string;
  filesChanged: string[];
  title: string;
  adds: SwarmAdd[];
  coordinatorUsage: { total: number; input: number; output: number } | null;
  plan: SwarmPlan;
  board: SwarmBoardPost[];
  workers: Record<string, SwarmWorker>;
  recordedBlock: { helper: string; text: string };
}

type Json = Record<string, unknown>;

function fail(path: string, expected: string): never {
  throw new Error(`Swarm fixture: ${path} should be ${expected}`);
}

function object(value: unknown, path: string): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : fail(path, "an object");
}

function array(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : fail(path, "an array");
}

function text(value: unknown, path: string): string {
  return typeof value === "string" ? value : fail(path, "a string");
}

function count(value: unknown, path: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail(path, "a number");
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

export function parseSwarmFixture(raw: unknown): SwarmFixture {
  const root = object(raw, "fixture");
  const run = object(root.run, "run");
  const files = object(root.files, "files");
  const events = array(root.acp, "acp").map((event, index) => object(event, `acp[${index}]`));
  const swarmInputs = events
    .filter((event) => event.name === "swarm")
    .map((event, index) => object(event.rawInput, `swarm call ${index}.rawInput`));
  const titleInput = swarmInputs.find((input) => input.action === "title");
  const usageEvent = events.find((event) => event.kind === "prompt_result");
  const usage = usageEvent ? object(object(usageEvent.result, "prompt_result.result").usage, "prompt_result.result.usage") : null;
  const planRaw = object(files.plan, "files.plan");
  const goal = object(planRaw.goal, "files.plan.goal");
  const tasks = object(planRaw.tasks, "files.plan.tasks");
  const board = array(files.board, "files.board").map((value, index) => {
    const post = object(value, `files.board[${index}]`);
    return { seq: count(post.seq, `files.board[${index}].seq`), agent: text(post.agent, `files.board[${index}].agent`), text: text(post.text, `files.board[${index}].text`), time: text(post.time, `files.board[${index}].time`), kind: optionalText(post.kind, `files.board[${index}].kind`) };
  });
  if (!board.length) fail("files.board", "non-empty");
  const workers = Object.fromEntries(Object.entries(object(files.workers, "files.workers")).map(([name, value]) => {
    const worker = object(value, `files.workers.${name}`);
    const tokens = object(worker.tokens, `files.workers.${name}.tokens`);
    const actions = array(worker.actions, `files.workers.${name}.actions`).map((entry, index) => {
      const action = object(entry, `files.workers.${name}.actions[${index}]`);
      const at = text(action.at, `files.workers.${name}.actions[${index}].at`);
      return { at, tool: text(action.tool, `files.workers.${name}.actions[${index}].tool`), summary: optionalText(action.summary, "summary"), target: optionalText(action.target, "target") };
    });
    return [name, { model: optionalText(worker.model, `files.workers.${name}.model`), tokens: { input: count(tokens.input, "tokens.input"), output: count(tokens.output, "tokens.output") }, actions }];
  }));
  const block = object(root.recordedBlock, "recordedBlock");
  return {
    request: text(root.request, "request"),
    model: text(run.model, "run.model"),
    filesChanged: array(run.filesChanged, "run.filesChanged").map((value, index) => text(value, `run.filesChanged[${index}]`)),
    title: titleInput ? text(titleInput.title, "swarm title") : text(goal.title, "files.plan.goal.title"),
    adds: swarmInputs.filter((input) => input.action === "add").map((input, index) => ({ name: text(input.name, `swarm add ${index}.name`), brief: text(input.brief, `swarm add ${index}.brief`) })),
    coordinatorUsage: usage ? { total: count(usage.totalTokens, "usage.totalTokens"), input: count(usage.inputTokens, "usage.inputTokens"), output: count(usage.outputTokens, "usage.outputTokens") } : null,
    plan: {
      goal: { title: text(goal.title, "files.plan.goal.title"), line: text(goal.line, "files.plan.goal.line") },
      tasks: Object.fromEntries(Object.entries(tasks).map(([name, value]) => [name, text(value, `files.plan.tasks.${name}`)])),
      threads: array(planRaw.threads, "files.plan.threads").map((value, index) => {
        const thread = object(value, `files.plan.threads[${index}]`);
        return { id: text(thread.id, "thread.id"), title: text(thread.title, "thread.title"), goal: text(thread.goal, "thread.goal"), tasks: array(thread.tasks, "thread.tasks").map((name) => text(name, "thread.tasks[]")) };
      }),
    },
    board,
    workers,
    recordedBlock: { helper: text(block.helper, "recordedBlock.helper"), text: text(block.text, "recordedBlock.text") },
  };
}

export const FIXTURE = parseSwarmFixture(sample);

function fileName(path?: string): string | undefined {
  if (!path) return undefined;
  return path.replace(/^<task-folder>\/?/, "").split("/").pop() || undefined;
}

export function actionLabel(action: SwarmAction): string {
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

export function blockedReason(text: string): string {
  const target = /permission check failed for \w+ "([^"]+)"/i.exec(text)?.[1];
  return target ? `Blocked: tried to change ${target}, outside the task folder` : "Blocked by the task folder boundary";
}

export const REAL_RUN = {
  request: FIXTURE.request,
  title: FIXTURE.title,
  startedAt: FIXTURE.board[0]!.time,
  lastSeq: FIXTURE.board[FIXTURE.board.length - 1]!.seq,
  addedHelpers: FIXTURE.adds,
};

export function boardPost(fixture: SwarmFixture, post: SwarmBoardPost): SwarmPost {
  return { seq: post.seq, author: post.agent, text: post.text, at: post.time, kind: postKind(post.agent, post.text, post.kind) };
}

export function deriveSwarm(fixture: SwarmFixture, atSeq: number, status: SwarmStatus = "running", extraPosts: SwarmBoardPost[] = []): SwarmView {
  const lastSeq = fixture.board[fixture.board.length - 1]!.seq;
  const cutoff = fixture.board.find((post) => post.seq === atSeq) ?? fixture.board[fixture.board.length - 1]!;
  const until = Date.parse(cutoff.time);
  const posts = [...fixture.board.filter((post) => post.seq <= atSeq), ...extraPosts].map((post) => boardPost(fixture, post));
  const verified = posts.some((post) => post.author.startsWith("verifier") && post.kind === "done");
  const helpers: SwarmHelper[] = fixture.adds.map(({ name, brief }) => {
    const role = roleOf(name);
    const worker = fixture.workers[name];
    const seen = (worker?.actions ?? []).filter((action) => Date.parse(action.at) <= until);
    const last = seen[seen.length - 1];
    const own = posts.filter((post) => post.author === name);
    const latest = own.filter((post) => post.kind === "blocked" || post.kind === "done").pop();
    const blocked = latest?.kind === "blocked" ? latest : undefined;
    const posted = own.some((post) => post.kind === "done");
    let state: HelperState = seen.length ? "working" : "starting";
    if (role === "monitor") state = "waiting";
    else if (blocked) state = "blocked";
    else if (posted && role === "verifier") state = "done";
    else if (posted) state = verified ? "done" : "in_review";
    else if (last?.tool === "swarm_wait") state = "waiting";
    if (status === "stopped" && state !== "done") state = "stopped";
    const settled = state === "done" || state === "in_review" || state === "stopped";
    return {
      name,
      role,
      task: fixture.plan.tasks[name] ?? plainBrief(brief),
      brief: plainBrief(brief),
      state,
      action: state === "blocked" ? blockedReason(blocked!.text) : settled ? undefined : role === "monitor" ? "Watching for stalls" : last ? actionLabel(last) : undefined,
      model: worker?.model,
      tokens: worker ? { ...worker.tokens } : undefined,
    };
  });
  const turnEnded = status === "completed" && atSeq >= lastSeq;
  const helperTokens = Object.values(fixture.workers).reduce((sum, worker) => ({ input: sum.input + worker.tokens.input, output: sum.output + worker.tokens.output }), { input: 0, output: 0 });
  return {
    request: fixture.request,
    title: fixture.title,
    goal: fixture.plan.goal,
    status,
    startedAt: fixture.board[0]!.time,
    helpers,
    posts,
    threads: fixture.plan.threads.map((thread) => ({ id: thread.id, title: thread.title, goal: thread.goal, helpers: thread.tasks })),
    usage: turnEnded && fixture.coordinatorUsage ? { ...fixture.coordinatorUsage, helpers: helperTokens } : undefined,
    model: fixture.model,
    files: turnEnded ? fixture.filesChanged : undefined,
  };
}

export function deriveRealSwarm(atSeq: number, status: SwarmStatus = "running", extraPosts: SwarmBoardPost[] = []): SwarmView {
  return deriveSwarm(FIXTURE, atSeq, status, extraPosts);
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
