import type { LiveEvent } from "@paperclipai/shared";

interface WebSocketLike {
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

interface Subscriber {
  onEvent?: (event: LiveEvent) => void;
  onOpen?: (info: { isReconnect: boolean }) => void;
  onClose?: () => void;
}

interface RegistryOptions {
  createSocket?: (url: string) => WebSocketLike;
  getLocation?: () => { protocol: string; host: string };
}

interface Entry {
  reconnectAttempt: number;
  reconnectTimer: number | null;
  socket: WebSocketLike | null;
  socketOpen: boolean;
  subscribers: Set<Subscriber>;
}

function buildLiveEventsUrl(companyId: string, location: { protocol: string; host: string }) {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
}

export function createCompanyLiveEventsRegistry(opts: RegistryOptions = {}) {
  const entries = new Map<string, Entry>();
  const createSocket = opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const getLocation = opts.getLocation ?? (() => window.location);

  const clearReconnect = (entry: Entry) => {
    if (entry.reconnectTimer !== null) {
      window.clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  };

  const cleanupEntry = (companyId: string, entry: Entry, reason: string) => {
    clearReconnect(entry);
    if (entry.socket) {
      entry.socket.onopen = null;
      entry.socket.onmessage = null;
      entry.socket.onerror = null;
      entry.socket.onclose = null;
      entry.socket.close(1000, reason);
      entry.socket = null;
    }
    entry.socketOpen = false;
    entries.delete(companyId);
  };

  const notifyClose = (entry: Entry) => {
    for (const subscriber of entry.subscribers) {
      subscriber.onClose?.();
    }
  };

  const notifyOpen = (entry: Entry, isReconnect: boolean) => {
    for (const subscriber of entry.subscribers) {
      subscriber.onOpen?.({ isReconnect });
    }
  };

  const connect = (companyId: string, entry: Entry) => {
    const socket = createSocket(buildLiveEventsUrl(companyId, getLocation()));
    entry.socket = socket;
    entry.socketOpen = false;

    socket.onopen = () => {
      const isReconnect = entry.reconnectAttempt > 0;
      entry.reconnectAttempt = 0;
      entry.socketOpen = true;
      notifyOpen(entry, isReconnect);
    };

    socket.onmessage = (message: { data: unknown }) => {
      if (typeof message.data !== "string" || message.data.length === 0) return;

      try {
        const event = JSON.parse(message.data) as LiveEvent;
        for (const subscriber of entry.subscribers) {
          subscriber.onEvent?.(event);
        }
      } catch {
        // Ignore malformed payloads from the shared stream.
      }
    };

    socket.onerror = () => {
      entry.socket?.close();
    };

    socket.onclose = () => {
      entry.socketOpen = false;
      entry.socket = null;
      notifyClose(entry);

      if (entry.subscribers.size === 0) {
        entries.delete(companyId);
        return;
      }

      entry.reconnectAttempt += 1;
      const delayMs = Math.min(15_000, 1000 * 2 ** Math.min(entry.reconnectAttempt - 1, 4));
      entry.reconnectTimer = window.setTimeout(() => {
        entry.reconnectTimer = null;
        connect(companyId, entry);
      }, delayMs);
    };
  };

  return {
    subscribe(companyId: string, subscriber: Subscriber) {
      let entry = entries.get(companyId);
      if (!entry) {
        entry = {
          reconnectAttempt: 0,
          reconnectTimer: null,
          socket: null,
          socketOpen: false,
          subscribers: new Set(),
        };
        entries.set(companyId, entry);
        connect(companyId, entry);
      }

      entry.subscribers.add(subscriber);
      if (entry.socketOpen) {
        subscriber.onOpen?.({ isReconnect: false });
      }

      return () => {
        const currentEntry = entries.get(companyId);
        if (!currentEntry) return;
        currentEntry.subscribers.delete(subscriber);
        if (currentEntry.subscribers.size === 0) {
          cleanupEntry(companyId, currentEntry, "last_subscriber");
        }
      };
    },
  };
}

const defaultRegistry = createCompanyLiveEventsRegistry();

export function subscribeToCompanyLiveEvents(companyId: string, subscriber: Subscriber) {
  return defaultRegistry.subscribe(companyId, subscriber);
}
