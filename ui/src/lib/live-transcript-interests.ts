import type { LiveDeliveryClientMessage } from "@paperclipai/shared";

export interface TranscriptStreamState { healthy: boolean; epoch: number; subscribedRunIds: ReadonlySet<string> }
export const DISCONNECTED_TRANSCRIPT_STREAM: TranscriptStreamState = { healthy: false, epoch: 0, subscribedRunIds: new Set() };
interface Sender { send(data: string): void }

export class LiveTranscriptInterests {
  readonly #counts = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  #socket: Sender | null = null;
  #capable = false;
  #revision = 0;
  #acknowledged = 0;
  #lastResyncRevision = 0;
  #recovering = false;
  #subscribedRunIds = new Set<string>();
  #sentRunIds: string[] = [];
  #snapshot: TranscriptStreamState = DISCONNECTED_TRANSCRIPT_STREAM;
  readonly snapshot = () => this.#snapshot;
  readonly subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #publish(healthy: boolean, resync = false) {
    this.#snapshot = { healthy, epoch: this.#snapshot.epoch + (resync ? 1 : 0), subscribedRunIds: this.#subscribedRunIds };
    for (const listener of this.#listeners) listener();
  }
  #send(message: LiveDeliveryClientMessage) {
    try { this.#socket?.send(JSON.stringify(message)); }
    catch { this.close(); }
  }
  #replace() {
    if (!this.#socket || !this.#capable) return;
    const message: LiveDeliveryClientMessage = { type: "live.interests", version: 1, revision: ++this.#revision,
      runIds: [...this.#counts.keys()].sort().slice(0, 1_000) };
    this.#sentRunIds = message.runIds;
    this.#subscribedRunIds = new Set(this.#sentRunIds.filter(id => this.#subscribedRunIds.has(id)));
    this.#publish(this.#snapshot.healthy);
    this.#send(message);
  }
  acquire(runIds: readonly string[]): () => void {
    const unique = [...new Set(runIds)];
    let changed = false;
    for (const id of unique) { const count = this.#counts.get(id) ?? 0; this.#counts.set(id, count + 1); changed ||= count === 0; }
    if (changed) this.#replace();
    let released = false;
    return () => {
      if (released) return;
      released = true; changed = false;
      for (const id of unique) {
        const count = this.#counts.get(id) ?? 0;
        if (count <= 1) { this.#counts.delete(id); changed = true; }
        else this.#counts.set(id, count - 1);
      }
      if (changed) this.#replace();
    };
  }
  open(socket: Sender) {
    this.#socket = socket; this.#capable = false; this.#revision = 0; this.#acknowledged = 0; this.#lastResyncRevision = 0;
    this.#subscribedRunIds = new Set(); this.#recovering = false;
    this.#publish(false, true);
    this.#send({ type: "live.hello", version: 1, capabilities: ["run-interests"] });
  }
  close() { this.#socket = null; this.#capable = false; this.#recovering = false; this.#subscribedRunIds = new Set(); this.#publish(false, true); }
  receive(value: unknown, onRecoveryAcknowledged?: () => void): boolean {
    if (!value || typeof value !== "object") return false;
    const frame = value as { type?: string; version?: number; capabilities?: unknown; revision?: number };
    if (typeof frame.type !== "string" || !frame.type.startsWith("live.")) return false;
    if (frame.version !== 1 || !this.#socket) return true;
    if (frame.type === "live.capabilities" && Array.isArray(frame.capabilities) && frame.capabilities.includes("run-interests")) {
      if (!this.#capable) { this.#capable = true; this.#replace(); }
    } else if (frame.type === "live.subscribed" && frame.revision === this.#revision && this.#acknowledged !== frame.revision) {
      this.#acknowledged = frame.revision;
      this.#subscribedRunIds = new Set(this.#sentRunIds);
      this.#publish(this.#counts.size <= 1_000);
      if (this.#recovering) { this.#recovering = false; onRecoveryAcknowledged?.(); }
    } else if (frame.type === "live.resync" && Number.isSafeInteger(frame.revision)
      && Number(frame.revision) > this.#lastResyncRevision && Number(frame.revision) <= this.#revision) {
      this.#lastResyncRevision = Number(frame.revision);
      this.#recovering = true;
      this.#subscribedRunIds = new Set();
      this.#publish(false, true);
      this.#replace();
    }
    return true;
  }
}
