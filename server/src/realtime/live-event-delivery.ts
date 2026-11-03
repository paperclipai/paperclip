import type { LiveEvent } from "@paperclipai/shared";

export const LIVE_DELIVERY_MAX_ITEMS = 1_000;
export const LIVE_DELIVERY_MAX_BYTES = 1024 * 1024;
const CONGESTION_DEADLINE_MS = 5_000;
const transcript = (event: LiveEvent) => event.type === "heartbeat.run.event" || event.type === "heartbeat.run.log";
const runId = (event: LiveEvent) => typeof event.payload.runId === "string" ? event.payload.runId : null;
interface Socket {
  readyState: number;
  bufferedAmount?: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export function createLiveEventDelivery(input: {
  socket: Socket;
  authorize(event: LiveEvent): Promise<LiveEvent | null>;
  decorate(event: LiveEvent): Promise<LiveEvent>;
  onError(error: unknown): void;
}) {
  const { socket } = input;
  let negotiated = false;
  let revision = 0;
  let interests = new Set<string>();
  let queued: Array<{ event: LiveEvent; bytes: number; epoch: number }> = [];
  let retainedBytes = 0;
  let retainedItems = 0;
  let epoch = 0;
  let draining = false;
  let disposed = false;
  let needsResync = false;
  let resyncReason = "delivery_overflow";
  let notifiedRevision = -1;
  let congestionTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingReadTimer: ReturnType<typeof setTimeout> | undefined;
  const activityAt = new Map<string, number>();
  const isOpen = () => !disposed && socket.readyState === 1;
  const room = (bytes: number, items = 1) => retainedItems + items <= LIVE_DELIVERY_MAX_ITEMS
    && retainedBytes + bytes + (socket.bufferedAmount ?? 0) <= LIVE_DELIVERY_MAX_BYTES;
  const wants = (event: LiveEvent) => !negotiated || !transcript(event) || interests.has(runId(event) ?? "");
  function dispose() {
    disposed = true; epoch += 1;
    for (const item of queued) { retainedBytes -= item.bytes; retainedItems -= 1; }
    queued = []; activityAt.clear();
    if (congestionTimer) clearTimeout(congestionTimer);
    if (pendingReadTimer) clearTimeout(pendingReadTimer);
    congestionTimer = pendingReadTimer = undefined;
  }
  function closeBacklog() {
    dispose();
    socket.close(1013, "persistent event backlog");
  }
  function control(value: object): boolean {
    const encoded = JSON.stringify(value);
    if (!isOpen() || !room(Buffer.byteLength(encoded))) return false;
    socket.send(encoded, error => { if (error) socket.close(1011, "live delivery failed"); });
    return true;
  }
  function resync() {
    if (!needsResync || !isOpen() || notifiedRevision === revision) return;
    if (control({ type: "live.resync", version: 1, revision, reason: resyncReason })) notifiedRevision = revision;
  }
  function overflow(reason = "delivery_overflow") {
    if (!negotiated) { socket.close(1013, "event backlog"); return; }
    epoch += 1;
    for (const item of queued) { retainedBytes -= item.bytes; retainedItems -= 1; }
    queued = [];
    needsResync = true;
    resyncReason = reason;
    if (!congestionTimer) {
      congestionTimer = setTimeout(() => {
        congestionTimer = undefined;
        if (needsResync || draining || (socket.bufferedAmount ?? 0) >= LIVE_DELIVERY_MAX_BYTES / 2) closeBacklog();
      }, CONGESTION_DEADLINE_MS);
      congestionTimer.unref?.();
    }
    resync();
  }
  function project(event: LiveEvent): LiveEvent | null {
    if (wants(event)) return event;
    const id = runId(event);
    if (!id) return null;
    const now = Date.now();
    if (now - (activityAt.get(id) ?? -Infinity) < 1_000) return null;
    if (activityAt.size >= LIVE_DELIVERY_MAX_ITEMS) activityAt.delete(activityAt.keys().next().value!);
    activityAt.set(id, now);
    return { ...event, type: "heartbeat.run.activity", payload: { runId: id, agentId: event.payload.agentId,
      lastOutputAt: event.createdAt } };
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queued.length && isOpen()) {
        const item = queued.shift()!;
        try {
          if (item.epoch !== epoch || !wants(item.event)) continue;
          pendingReadTimer = setTimeout(closeBacklog, CONGESTION_DEADLINE_MS);
          pendingReadTimer.unref?.();
          const visible = await input.authorize(item.event);
          if (!visible || item.epoch !== epoch || !wants(item.event) || !isOpen()) continue;
          const decorated = transcript(visible) || visible.type === "heartbeat.run.activity"
            ? visible : await input.decorate(visible);
          if (item.epoch !== epoch || !wants(item.event) || !isOpen()) continue;
          const encoded = JSON.stringify(decorated);
          const bytes = Buffer.byteLength(encoded);
          if (bytes > LIVE_DELIVERY_MAX_BYTES || retainedBytes - item.bytes + bytes + (socket.bufferedAmount ?? 0) > LIVE_DELIVERY_MAX_BYTES) {
            overflow(); continue;
          }
          socket.send(encoded, error => {
            if (error) socket.close(1011, "live delivery failed");
            else resync();
          });
        } catch (error) {
          if (!isOpen()) continue;
          input.onError(error);
          if (negotiated) overflow();
        } finally {
          if (pendingReadTimer) clearTimeout(pendingReadTimer);
          pendingReadTimer = undefined;
          retainedBytes -= item.bytes; retainedItems -= 1;
        }
      }
    } finally { draining = false; resync(); }
  }
  return {
    receive(raw: string) {
      if (!isOpen()) return;
      if (Buffer.byteLength(raw) > 64 * 1024) { socket.close(1009, "interest message too large"); return; }
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return; }
      if (!value || typeof value !== "object") return;
      if ((value as { type?: unknown }).type === "live.hello") {
        if ((value as { version?: unknown }).version === 1) control({ type: "live.capabilities", version: 1, capabilities: ["run-interests"] });
        return;
      }
      if ((value as { type?: unknown }).type !== "live.interests") return;
      const message = value as { version?: unknown; revision?: unknown; runIds?: unknown };
      if (message.version !== 1 || !Number.isSafeInteger(message.revision) || Number(message.revision) <= revision
        || !Array.isArray(message.runIds) || message.runIds.length > LIVE_DELIVERY_MAX_ITEMS
        || message.runIds.some(id => typeof id !== "string" || id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(id))) {
        socket.close(1008, "invalid run interests"); return;
      }
      negotiated = true;
      const unnotifiedGap = needsResync && notifiedRevision !== revision;
      revision = Number(message.revision);
      interests = new Set(message.runIds);
      needsResync = unnotifiedGap;
      if (control({ type: "live.subscribed", version: 1, revision })) {
        resync();
        if (!needsResync && !draining && (socket.bufferedAmount ?? 0) < LIVE_DELIVERY_MAX_BYTES / 2 && congestionTimer) {
          clearTimeout(congestionTimer); congestionTimer = undefined;
        }
      } else overflow();
    },
    enqueue(source: LiveEvent) {
      if (!isOpen()) return;
      if (source.type === "heartbeat.run.status") activityAt.delete(runId(source) ?? "");
      if (needsResync) return;
      const event = project(source);
      if (!event) return;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (!room(bytes)) { overflow(); return; }
      queued.push({ event, bytes, epoch }); retainedBytes += bytes; retainedItems += 1;
      void drain();
    },
    requestResync: () => overflow("controller_change"),
    dispose,
    metrics: () => ({ retainedBytes, retainedItems, negotiated, revision, needsResync }),
  };
}
