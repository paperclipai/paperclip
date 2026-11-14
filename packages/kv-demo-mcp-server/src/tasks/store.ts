import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Task states from the MCP Tasks extension (2026-07-28). */
export type DemoTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export type DemoInputRequest = { method: string; params: Record<string, unknown> };

export interface DemoTask {
  taskId: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: DemoTaskStatus;
  /** Epoch ms. */
  createdAt: number;
  lastUpdatedAt: number;
  ttlMs: number;
  pollIntervalMs: number;
  /** When a `working` task settles on its own (epoch ms). */
  settlesAt: number | null;
  /** How a `working` task settles at `settlesAt`. */
  outcome: "complete" | "fail";
  inputRequests?: Record<string, DemoInputRequest>;
  /** The person's answer from `tasks/update`, kept for the result. */
  answer?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  /** How many `tasks/get` requests this task has answered. */
  polls: number;
}

export interface DemoEvent {
  at: number;
  method: string;
  tool?: string;
  taskId?: string;
  detail: string;
}

export interface DemoState {
  tasks: DemoTask[];
  /** Every `tools/call` received, by tool name. Proves "started exactly once". */
  toolCalls: Record<string, number>;
  events: DemoEvent[];
}

const MAX_EVENTS = 200;
const MAX_TASKS = 500;

/**
 * In-memory task state, optionally mirrored to a JSON file so the server can
 * be stopped and started again mid-task. A task's progress is derived from the
 * clock (`settlesAt`), so a restart never resets or repeats work.
 */
/**
 * The state directory must be a real directory owned by this user and not
 * writable by anyone else, so no other local user can plant files in it.
 */
function assertPrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0) {
    throw new Error(`Task state directory ${dir} must be a directory you own that others cannot write to. Choose another TASKS_DEMO_STATE_FILE.`);
  }
}

export class DemoTaskStore {
  private state: DemoState = { tasks: [], toolCalls: {}, events: [] };

  constructor(
    private readonly options: { file?: string | null; now?: () => number } = {},
  ) {
    if (options.file) {
      assertPrivateDirectory(dirname(options.file));
      this.load(options.file);
    }
  }

  now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private load(file: string): void {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DemoState>;
      this.state = {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        toolCalls: parsed.toolCalls && typeof parsed.toolCalls === "object" ? parsed.toolCalls : {},
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  private save(): void {
    const file = this.options.file;
    if (!file) return;
    // A fresh, unguessable temp name, created exclusively: nothing another
    // user placed in the directory (such as a symlink) is ever written through.
    const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  }

  log(event: Omit<DemoEvent, "at">): void {
    this.state.events.push({ at: this.now(), ...event });
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    this.save();
  }

  countToolCall(tool: string): void {
    this.state.toolCalls[tool] = (this.state.toolCalls[tool] ?? 0) + 1;
    this.save();
  }

  create(input: Omit<DemoTask, "taskId" | "createdAt" | "lastUpdatedAt" | "polls">): DemoTask {
    const now = this.now();
    const task: DemoTask = { ...input, taskId: `demo-${randomUUID()}`, createdAt: now, lastUpdatedAt: now, polls: 0 };
    this.state.tasks.push(task);
    if (this.state.tasks.length > MAX_TASKS) this.state.tasks.splice(0, this.state.tasks.length - MAX_TASKS);
    this.save();
    return task;
  }

  /**
   * The task as it is now, or null when unknown or past its TTL. An expired
   * task is forgotten, as the specification allows.
   */
  get(taskId: string): DemoTask | null {
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) return null;
    const now = this.now();
    if (now >= task.createdAt + task.ttlMs) {
      this.state.tasks = this.state.tasks.filter((candidate) => candidate !== task);
      this.log({ method: "expired", tool: task.tool, taskId, detail: `TTL of ${Math.round(task.ttlMs / 1000)} s passed; task forgotten` });
      return null;
    }
    return task;
  }

  update(task: DemoTask, patch: Partial<DemoTask>): DemoTask {
    Object.assign(task, patch, { lastUpdatedAt: this.now() });
    this.save();
    return task;
  }

  touch(): void {
    this.save();
  }

  snapshot(): DemoState {
    return structuredClone(this.state);
  }
}
