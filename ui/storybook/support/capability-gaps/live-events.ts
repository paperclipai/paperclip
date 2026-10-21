import type { LiveEvent } from "@paperclipai/shared";
const sockets: FixtureSocket[] = [];
const listeners = new Set<() => void>();
class FixtureSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor() {
    sockets.push(this);
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      for (const listener of listeners) listener();
    });
  }
  close() {
    this.readyState = 3;
  }
  send() {}
}
export function listenForFixtureSocket(listener: () => void) {
  listeners.add(listener);
  if (sockets.some((s) => s.readyState === 1)) listener();
  return () => {
    listeners.delete(listener);
  };
}
export function publishFixtureEvent(event: LiveEvent) {
  for (const socket of sockets)
    if (socket.readyState === 1)
      socket.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify(event) }),
      );
}
export function installLiveEventFixture() {
  const previous = window.WebSocket;
  sockets.splice(0);
  listeners.clear();
  window.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  return () => {
    for (const socket of sockets) socket.close();
    sockets.splice(0);
    listeners.clear();
    window.WebSocket = previous;
  };
}
