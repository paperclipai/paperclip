import { createHash } from "node:crypto";
import type { CursorCloudClient, CursorCloudSseEvent } from "../../packages/paperclip-runner/src/drivers/cursor-cloud/cloud-client.js";

export interface CursorCloudPendingCommand { callId: string; toolName: string; commandSha256: string }
type Row = Record<string, any>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export class CursorCloudStopCommandTracker {
  readonly #pending = new Map<string, CursorCloudPendingCommand>();
  readonly #completed = new Set<string>();
  #terminal = false;
  constructor(readonly artifactName: string, readonly runId: string) {}
  consume(event: CursorCloudSseEvent): void {
    const data = record(event.data);
    if (["status", "result"].includes(event.event) && data.runId !== undefined && data.runId !== this.runId) throw new Error("Cloud Stop observer received a foreign native run");
    if (event.event === "done" || event.event === "result" || event.event === "status" && ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(data.status)) {
      this.#terminal = true; this.#pending.clear(); return;
    }
    if (event.event !== "tool_call" || this.#terminal) return;
    if (typeof data.callId !== "string" || !data.callId || data.callId.length > 512 || typeof data.name !== "string" || !data.name || data.name.length > 512 || !["running", "completed", "error"].includes(data.status)) throw new Error("Cloud Stop observer received an invalid native tool event");
    if (data.status !== "running") {
      if (this.#completed.size >= 256) throw new Error("Cloud Stop observer tool bound exceeded");
      this.#completed.add(data.callId); this.#pending.delete(data.callId); return;
    }
    if (this.#completed.has(data.callId)) return;
    const command = record(data.args).command;
    if (typeof command !== "string" || command.length > 16_384) return;
    const match = /^sleep 180 && printf 'MUST_NOT_APPEAR\\n' > '([^'\n\r\0]+)'$/u.exec(command);
    if (!match || !match[1]!.startsWith("/") || match[1]!.split("/").includes("..") || match[1]!.split("/").at(-1) !== this.artifactName) return;
    this.#pending.set(data.callId, { callId: data.callId, toolName: data.name, commandSha256: createHash("sha256").update(command).digest("hex") });
    if (this.#pending.size > 1) throw new Error("Cloud Stop observer saw multiple delayed commands");
  }
  pending(): CursorCloudPendingCommand | undefined { return this.#terminal ? undefined : [...this.#pending.values()][0]; }
}

export class CursorCloudStopCommandObserver {
  readonly #abort = new AbortController();
  readonly #tracker: CursorCloudStopCommandTracker;
  readonly #done: Promise<void>;
  readonly #timer: NodeJS.Timeout;
  #failure: Error | undefined;
  #closed = false;
  constructor(input: { client: Pick<CursorCloudClient, "streamRun">; agentId: string; runId: string; artifactName: string; deadlineAt: number }) {
    if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt - Date.now() > 480_000) throw new Error("Cloud Stop observer deadline expired");
    const tracker = new CursorCloudStopCommandTracker(input.artifactName, input.runId);
    this.#tracker = tracker;
    const timer = setTimeout(() => { this.#failure = new Error("Cloud Stop observer deadline expired"); this.#abort.abort(); }, input.deadlineAt - Date.now());
    this.#timer = timer;
    timer.unref();
    this.#done = (async () => {
      try {
        for await (const event of input.client.streamRun(input.agentId, input.runId, { signal: this.#abort.signal })) tracker.consume(event);
        if (!this.#closed) this.#failure = new Error("Cloud Stop native observation stream ended");
      } catch { if (!this.#closed) this.#failure ??= new Error("Cloud Stop native observation stream was lost"); }
      finally { clearTimeout(timer); }
    })();
  }
  pending(): CursorCloudPendingCommand | undefined {
    if (this.#failure) throw this.#failure;
    return this.#closed ? undefined : this.#tracker.pending();
  }
  async close(): Promise<void> { this.#closed = true; clearTimeout(this.#timer); this.#abort.abort(); await this.#done; }
}

export function readPendingCursorCloudStopExecution(events: readonly Row[], runId: string, pending?: CursorCloudPendingCommand): string | undefined {
  if (!pending) return;
  const canonical = events.filter(row => row.runId === runId && row.protocolSchemaVersion === 1).map(row => row.payload?.prpEvent)
    .filter(event => event?.schema === "paperclip.prp.event.v1" && event.schemaVersion === 1 && event.sourceKind === "runner" && event.runId === runId);
  if (canonical.some(event => ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.eventType))) return;
  const matches = canonical.filter(event => event.payload?.executionId === pending.callId);
  if (matches.some(event => event.eventType === "tool.execution.completed" || event.eventType === "tool.execution.progressed" && event.payload.status !== "running")) return;
  const starts = matches.filter(event => event.eventType === "tool.execution.started");
  return starts.length > 0 && starts.every(event => event.payload.schema === "paperclip.tool.execution.v1" && event.payload.transport === "builtin" && event.payload.status === "running" && event.payload.name === pending.toolName) ? pending.callId : undefined;
}
