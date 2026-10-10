/**
 * Cross-tab shared polling coordination (PAP-12557 / Phase 2 of PAP-12542).
 *
 * Goal: when a user restores many Paperclip tabs at once, we do not want every
 * tab independently polling the same company-scoped hot endpoints (live-runs,
 * dashboard, inbox list, activity). Instead we elect ONE visible leader tab per
 * company to poll, and the leader broadcasts fresh results to the other tabs.
 *
 * Two independent primitives make this robust:
 *
 *   1. `LeaderElection` — a localStorage-lease election that is the source of
 *      truth for "who polls". It works with nothing but a Storage-like object
 *      and a clock, so it survives even when `BroadcastChannel` is unavailable,
 *      and it is fully unit-testable with injected fakes (no DOM required).
 *
 *   2. `SharedChannel` — a best-effort message bus for sharing poll results.
 *      Prefers `BroadcastChannel`; falls back to a `localStorage` + `storage`
 *      event relay when it is not available.
 *
 * The lease is authoritative; the channel is an optimisation. If the channel is
 * missing, followers still stop polling (lease) and rely on their react-query
 * cache / a slow safety poll, so we never regress to worse than a single tab.
 *
 * Design rules (from the approved plan, Phase 2 acceptance):
 *   - At most one active leader per company under normal browser conditions.
 *   - Hidden tabs do NOT become leader while a visible tab exists.
 *   - Leader failover happens within ~one poll interval + lease grace when the
 *     leader closes or crashes (its lease expires and a follower reclaims it).
 */

// ---------------------------------------------------------------------------
// Leader election (pure, injectable — the tested core)
// ---------------------------------------------------------------------------

export interface LeaseRecord {
  /** Tab id of the current leader. */
  leader: string;
  /** Epoch ms after which the lease is considered dead. */
  expiresAt: number;
  /** Whether the leader tab was visible at its last renewal. */
  visible: boolean;
}

export type LeaderRole = "leader" | "follower";

/** Minimal persistence contract — a single JSON slot keyed by resource. */
export interface LeaseStore {
  /** Parsed record, or null if absent/corrupt. Callers check expiry themselves. */
  read(): LeaseRecord | null;
  write(record: LeaseRecord): void;
  clear(): void;
}

export interface LeaderElectionEnv {
  now: () => number;
  store: LeaseStore;
  /** Injectable RNG in [0,1) for grace jitter. Defaults to Math.random. */
  random?: () => number;
}

export interface LeaderElectionOptions {
  /** Stable, unique id for this tab. */
  tabId: string;
  /** How long a claimed lease is valid (ms). Default 8000. */
  leaseTtlMs?: number;
  /**
   * Base delay a *hidden* tab waits, after first observing an empty/expired
   * lease, before it will claim leadership. Gives any visible tab (which claims
   * immediately) a chance to win first. Default 4000.
   */
  hiddenGraceMs?: number;
  /** Random extra grace added once per instance to de-sync hidden tabs. Default 4000. */
  hiddenGraceJitterMs?: number;
}

export const DEFAULT_LEASE_TTL_MS = 8_000;

/**
 * localStorage-lease leader election. Call `step(visible)` on a regular tick
 * (and on visibility changes); it returns this tab's current role and, as a
 * side effect, claims/renews/releases the lease.
 *
 * The election is deliberately last-writer-wins with a read-back confirm: after
 * writing a claim we re-read the slot and only consider ourselves leader if the
 * slot still names us. In real browsers localStorage writes are synchronous, so
 * two tabs racing to claim resolve to a single winner within a tick or two.
 */
export class LeaderElection {
  private readonly tabId: string;
  private readonly ttl: number;
  private readonly hiddenGrace: number;
  private readonly env: LeaderElectionEnv;
  private role: LeaderRole = "follower";
  /** When (ms) this hidden tab first saw an empty lease; null once non-empty. */
  private hiddenEmptySince: number | null = null;

  constructor(env: LeaderElectionEnv, options: LeaderElectionOptions) {
    this.env = env;
    this.tabId = options.tabId;
    this.ttl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const base = options.hiddenGraceMs ?? 4_000;
    const jitterMax = options.hiddenGraceJitterMs ?? 4_000;
    const rng = env.random ?? Math.random;
    this.hiddenGrace = base + Math.round(Math.min(Math.max(rng(), 0), 0.999999) * jitterMax);
  }

  get id(): string {
    return this.tabId;
  }

  isLeader(): boolean {
    return this.role === "leader";
  }

  getRole(): LeaderRole {
    return this.role;
  }

  /** Advance the election given the current visibility. Returns the new role. */
  step(visible: boolean): LeaderRole {
    const now = this.env.now();
    const lease = this.env.store.read();
    const valid = lease != null && lease.expiresAt > now;

    if (valid && lease!.leader === this.tabId) {
      // We already hold a valid lease — renew it (and refresh our visibility).
      this.hiddenEmptySince = null;
      this.writeClaim(visible, now);
      this.role = "leader";
      return this.role;
    }

    if (valid) {
      // Someone else holds a valid lease.
      this.hiddenEmptySince = null;
      // A visible tab may preempt a hidden leader so the active window polls.
      if (visible && lease!.visible === false) {
        return this.tryClaim(visible, now);
      }
      this.role = "follower";
      return this.role;
    }

    // No valid lease (absent or expired) — up for grabs.
    if (visible) {
      this.hiddenEmptySince = null;
      return this.tryClaim(visible, now);
    }

    // Hidden tab: defer claiming so a visible tab can win the empty lease first.
    if (this.hiddenEmptySince == null) this.hiddenEmptySince = now;
    if (now - this.hiddenEmptySince >= this.hiddenGrace) {
      return this.tryClaim(visible, now);
    }
    this.role = "follower";
    return this.role;
  }

  /** Voluntarily give up leadership (call on unmount/close). */
  release(): void {
    if (this.role === "leader") {
      const lease = this.env.store.read();
      if (lease?.leader === this.tabId) this.env.store.clear();
    }
    this.role = "follower";
    this.hiddenEmptySince = null;
  }

  private writeClaim(visible: boolean, now: number): void {
    this.env.store.write({ leader: this.tabId, expiresAt: now + this.ttl, visible });
  }

  private tryClaim(visible: boolean, now: number): LeaderRole {
    this.writeClaim(visible, now);
    // Read-back confirm resolves races: only the last writer keeps leadership.
    const after = this.env.store.read();
    if (after != null && after.leader === this.tabId) {
      this.hiddenEmptySince = null;
      this.role = "leader";
    } else {
      this.role = "follower";
    }
    return this.role;
  }
}

function stableFingerprint(value: unknown): string {
  const seen = new WeakSet<object>();
  let hashA = 0xdeadbeef;
  let hashB = 0x41c6ce57;

  const write = (chunk: string) => {
    for (let index = 0; index < chunk.length; index += 1) {
      const code = chunk.charCodeAt(index);
      hashA = Math.imul(hashA ^ code, 2654435761);
      hashB = Math.imul(hashB ^ code, 1597334677);
    }
  };

  const visit = (entry: unknown, inArray = false): void => {
    if (entry === null) {
      write("null");
      return;
    }
    switch (typeof entry) {
      case "string":
        write(JSON.stringify(entry));
        return;
      case "boolean":
        write(entry ? "true" : "false");
        return;
      case "number":
        write(Number.isFinite(entry) ? String(entry) : "null");
        return;
      case "undefined":
        write(inArray ? "null" : "undefined");
        return;
      case "bigint":
        write(`bigint:${entry}`);
        return;
      case "symbol":
        write(`symbol:${String(entry)}`);
        return;
      case "function":
        write(`function:${String(entry)}`);
        return;
      case "object":
        break;
    }

    const object = entry as Record<string, unknown>;
    if (seen.has(object)) {
      write("[Circular]");
      return;
    }
    seen.add(object);
    const toJSON = object.toJSON;
    if (typeof toJSON === "function") {
      visit(toJSON.call(object), inArray);
      return;
    }
    if (Array.isArray(object)) {
      write("[");
      for (const item of object) {
        visit(item, true);
        write(",");
      }
      write("]");
      return;
    }

    write("{");
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      write(JSON.stringify(key));
      write(":");
      visit(item);
      write(",");
    }
    write("}");
  };

  try {
    visit(value);
    hashA = Math.imul(hashA ^ (hashA >>> 16), 2246822507) ^ Math.imul(hashB ^ (hashB >>> 13), 3266489909);
    hashB = Math.imul(hashB ^ (hashB >>> 16), 2246822507) ^ Math.imul(hashA ^ (hashA >>> 13), 3266489909);
    return `${(hashB >>> 0).toString(36)}${(hashA >>> 0).toString(36)}`;
  } catch {
    return String(value);
  }
}

/** Build a `LeaseStore` backed by a Storage-like object under one key. */
export function createLeaseStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key: string,
): LeaseStore {
  return {
    read() {
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch {
        return null;
      }
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<LeaseRecord>;
        if (
          typeof parsed?.leader === "string" &&
          typeof parsed?.expiresAt === "number" &&
          typeof parsed?.visible === "boolean"
        ) {
          return parsed as LeaseRecord;
        }
        return null;
      } catch {
        return null;
      }
    },
    write(record) {
      try {
        storage.setItem(key, JSON.stringify(record));
      } catch {
        /* storage full / disabled — degrade to no lease */
      }
    },
    clear() {
      try {
        storage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared result channel (best-effort broadcast, with a storage fallback)
// ---------------------------------------------------------------------------

export interface SharedMessage {
  /** `result`: leader is publishing fresh data. `request`: a joiner wants the latest. */
  type: "result" | "request";
  /** Resource key, e.g. `live-runs:<companyId>`. */
  key: string;
  /** Sender tab id (so tabs ignore their own echoes). */
  from: string;
  /** Epoch ms the payload was produced. */
  at: number;
  /** React Query `dataUpdatedAt` for result freshness comparisons. */
  dataUpdatedAt?: number;
  /** Present on `result` messages. */
  data?: unknown;
}

export interface SharedChannel {
  post(message: SharedMessage): void;
  subscribe(handler: (message: SharedMessage) => void): () => void;
  close(): void;
}

/** No-op channel used when neither BroadcastChannel nor storage relay is usable. */
export function createNoopChannel(): SharedChannel {
  return {
    post() {},
    subscribe() {
      return () => {};
    },
    close() {},
  };
}

/** BroadcastChannel-backed shared channel. */
export function createBroadcastChannelShared(name: string): SharedChannel {
  const bc = new BroadcastChannel(name);
  return {
    post(message) {
      bc.postMessage(message);
    },
    subscribe(handler) {
      const listener = (ev: MessageEvent) => handler(ev.data as SharedMessage);
      bc.addEventListener("message", listener);
      return () => bc.removeEventListener("message", listener);
    },
    close() {
      bc.close();
    },
  };
}

export interface StorageRelayDeps {
  storage: Pick<Storage, "setItem">;
  /** Subscribe to cross-tab storage writes; returns an unsubscribe fn. */
  onStorage: (cb: (key: string | null, newValue: string | null) => void) => () => void;
  /** Monotonic nonce so repeated identical messages still trigger a `storage` event. */
  nextNonce: () => string;
}

/**
 * localStorage-relay shared channel used when `BroadcastChannel` is missing.
 * A post writes `{ n, msg }` to a storage key; other tabs receive the write via
 * the `storage` event. Note: `storage` events do not fire in the writing tab, so
 * the sender never receives its own message (which is what we want anyway).
 */
export function createStorageRelayShared(key: string, deps: StorageRelayDeps): SharedChannel {
  return {
    post(message) {
      try {
        deps.storage.setItem(key, JSON.stringify({ n: deps.nextNonce(), msg: message }));
      } catch {
        /* ignore */
      }
    },
    subscribe(handler) {
      return deps.onStorage((k, newValue) => {
        if (k !== key || !newValue) return;
        try {
          const parsed = JSON.parse(newValue) as { msg?: SharedMessage };
          if (parsed?.msg) handler(parsed.msg);
        } catch {
          /* ignore malformed relay payloads */
        }
      });
    },
    close() {},
  };
}

/**
 * Pick the best available shared channel for the current environment:
 * BroadcastChannel → localStorage relay → no-op.
 */
export function createSharedChannel(name: string): SharedChannel {
  if (typeof BroadcastChannel !== "undefined") {
    try {
      return createBroadcastChannelShared(name);
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
    let counter = 0;
    const relayKey = `${name}:relay`;
    return createStorageRelayShared(relayKey, {
      storage: localStorage,
      onStorage(cb) {
        const listener = (ev: StorageEvent) => cb(ev.key, ev.newValue);
        window.addEventListener("storage", listener);
        return () => window.removeEventListener("storage", listener);
      },
      nextNonce: () => `${Date.now()}-${counter++}`,
    });
  }
  return createNoopChannel();
}

// ---------------------------------------------------------------------------
// Browser coordinator (one leader lease + one channel per company)
// ---------------------------------------------------------------------------

export interface SharedPollingSnapshot {
  isLeader: boolean;
}

export type SharedPollingListener = (snapshot: SharedPollingSnapshot) => void;
export type SharedPollingResourceListener = (message: SharedMessage) => void;

export interface SharedPollingCoordinatorOptions {
  tabId?: string;
  channel?: SharedChannel;
  election?: LeaderElection;
  leaseTtlMs?: number;
  tickMs?: number;
  publishDebounceMs?: number;
  now?: () => number;
  getVisible?: () => boolean;
}

const DEFAULT_COORDINATOR_TICK_MS = 1_000;
const DEFAULT_PUBLISH_DEBOUNCE_MS = 1_000;
const MAX_COORDINATOR_CACHE_ENTRIES = 32;
const COORDINATOR_CACHE_TTL_MS = 5 * 60_000;
const TAB_ID_STORAGE_KEY = "paperclip:shared-poll:tab-id";

function sanitizeCompanyId(companyId: string): string {
  return encodeURIComponent(companyId);
}

export function sharedPollingLeaseKey(companyId: string): string {
  return `paperclip:shared-poll:${sanitizeCompanyId(companyId)}:leader`;
}

export function sharedPollingChannelName(companyId: string): string {
  return `paperclip:shared-poll:${sanitizeCompanyId(companyId)}`;
}

export function getSharedPollingTabId(): string {
  if (typeof sessionStorage !== "undefined") {
    try {
      const existing = sessionStorage.getItem(TAB_ID_STORAGE_KEY);
      if (existing) return existing;
      const next = createRandomId();
      sessionStorage.setItem(TAB_ID_STORAGE_KEY, next);
      return next;
    } catch {
      /* fall through */
    }
  }
  return createRandomId();
}

function createRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getBrowserVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
}

function createBrowserLeaseStore(companyId: string): LeaseStore | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const probeKey = `paperclip:shared-poll:${sanitizeCompanyId(companyId)}:probe`;
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
  } catch {
    return null;
  }
  return createLeaseStore(localStorage, sharedPollingLeaseKey(companyId));
}

/**
 * Per-company coordinator that owns one lease election and one result channel.
 * Multiple query hooks in the same tab share the same coordinator via a registry
 * in `useSharedPolling`, so unmounting one component does not release leadership
 * while another shared query is still active in the tab.
 */
export class SharedPollingCoordinator {
  readonly tabId: string;
  private readonly channel: SharedChannel;
  private readonly election: LeaderElection;
  private readonly localOnlyFallback: boolean;
  private readonly tickMs: number;
  private readonly publishDebounceMs: number;
  private readonly now: () => number;
  private readonly getVisible: () => boolean;
  private readonly listeners = new Set<SharedPollingListener>();
  private readonly resourceListeners = new Map<string, Set<SharedPollingResourceListener>>();
  private readonly latestResults = new Map<string, {
    message: SharedMessage;
    lastAccessedAt: number;
  }>();
  private readonly lastPublished = new Map<string, {
    dataUpdatedAt: number;
    fingerprint: string;
    sentAt: number;
    lastAccessedAt: number;
  }>();
  private readonly pendingPublishes = new Map<string, {
    data: unknown;
    dataUpdatedAt: number;
    fingerprint: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private unsubscribeChannel: (() => void) | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private releaseListeners: Array<() => void> = [];
  private snapshot: SharedPollingSnapshot = { isLeader: false };

  constructor(companyId: string, options: SharedPollingCoordinatorOptions = {}) {
    this.tabId = options.tabId ?? getSharedPollingTabId();
    this.channel = options.channel ?? createSharedChannel(sharedPollingChannelName(companyId));
    this.tickMs = options.tickMs ?? DEFAULT_COORDINATOR_TICK_MS;
    this.publishDebounceMs = options.publishDebounceMs ?? DEFAULT_PUBLISH_DEBOUNCE_MS;
    this.now = options.now ?? (() => Date.now());
    this.getVisible = options.getVisible ?? getBrowserVisible;
    const leaseStore = createBrowserLeaseStore(companyId);
    this.localOnlyFallback = !options.election && !leaseStore;
    this.election = options.election ?? new LeaderElection(
      {
        now: this.now,
        store: leaseStore ?? {
          read: () => null,
          write: () => {},
          clear: () => {},
        },
      },
      {
        tabId: this.tabId,
        leaseTtlMs: options.leaseTtlMs,
      },
    );
  }

  getSnapshot(): SharedPollingSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.intervalId != null) return;
    this.unsubscribeChannel = this.channel.subscribe((message) => this.handleMessage(message));
    this.tick();
    this.intervalId = setInterval(() => this.tick(), this.tickMs);
    this.attachReleaseListeners();
  }

  stop(): void {
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.unsubscribeChannel?.();
    this.unsubscribeChannel = null;
    this.clearPendingPublishes();
    for (const release of this.releaseListeners) release();
    this.releaseListeners = [];
    this.election.release();
    this.channel.close();
    this.setSnapshot({ isLeader: false });
  }

  subscribe(listener: SharedPollingListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeResource(key: string, listener: SharedPollingResourceListener): () => void {
    let listeners = this.resourceListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.resourceListeners.set(key, listeners);
    }
    listeners.add(listener);
    const latest = this.getLatestResult(key);
    if (latest) listener(latest);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.resourceListeners.delete(key);
        this.markInactive(key);
      }
    };
  }

  request(key: string): void {
    this.channel.post({
      type: "request",
      key,
      from: this.tabId,
      at: this.now(),
    });
  }

  publish(key: string, data: unknown, dataUpdatedAt = this.now()): void {
    if (!this.snapshot.isLeader) return;
    if (dataUpdatedAt <= 0) return;
    const last = this.getLastPublished(key);
    if (last && dataUpdatedAt <= last.dataUpdatedAt) return;
    const pending = this.pendingPublishes.get(key);
    if (pending && dataUpdatedAt < pending.dataUpdatedAt) return;
    const fingerprint = stableFingerprint(data);
    if (last && fingerprint === last.fingerprint) {
      this.cancelPendingPublish(key);
      return;
    }
    if (pending) {
      if (dataUpdatedAt < pending.dataUpdatedAt) return;
      if (dataUpdatedAt === pending.dataUpdatedAt && fingerprint === pending.fingerprint) return;
      this.pendingPublishes.set(key, {
        ...pending,
        data,
        dataUpdatedAt,
        fingerprint,
      });
      return;
    }

    const elapsedSinceLastPublish = last ? this.now() - last.sentAt : Number.POSITIVE_INFINITY;
    if (elapsedSinceLastPublish >= this.publishDebounceMs) {
      this.postResult(key, data, dataUpdatedAt, fingerprint);
      return;
    }

    const delay = Math.max(this.publishDebounceMs - elapsedSinceLastPublish, 0);
    const timer = setTimeout(() => this.flushPendingPublish(key), delay);
    this.pendingPublishes.set(key, { data, dataUpdatedAt, fingerprint, timer });
  }

  private postResult(key: string, data: unknown, dataUpdatedAt: number, fingerprint: string): void {
    const sentAt = this.now();
    const message: SharedMessage = {
      type: "result",
      key,
      from: this.tabId,
      at: sentAt,
      dataUpdatedAt,
      data,
    };
    this.setLastPublished(key, { dataUpdatedAt, fingerprint, sentAt, lastAccessedAt: sentAt });
    this.setLatestResult(key, message);
    this.channel.post(message);
  }

  private flushPendingPublish(key: string): void {
    const pending = this.pendingPublishes.get(key);
    if (!pending) return;
    this.pendingPublishes.delete(key);
    this.postResult(key, pending.data, pending.dataUpdatedAt, pending.fingerprint);
  }

  private cancelPendingPublish(key: string): void {
    const pending = this.pendingPublishes.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPublishes.delete(key);
  }

  private clearPendingPublishes(): void {
    for (const pending of this.pendingPublishes.values()) clearTimeout(pending.timer);
    this.pendingPublishes.clear();
  }

  private tick(): void {
    this.evictIdleEntries();
    if (this.localOnlyFallback) {
      this.setSnapshot({ isLeader: this.getVisible() });
      return;
    }
    const role = this.election.step(this.getVisible());
    this.setSnapshot({ isLeader: role === "leader" });
  }

  private handleMessage(message: SharedMessage): void {
    if (message.from === this.tabId) return;
    if (message.type === "request") {
      if (!this.snapshot.isLeader) return;
      const latest = this.getLatestResult(message.key);
      if (latest) this.channel.post({ ...latest, from: this.tabId });
      return;
    }

    this.setLatestResult(message.key, message);
    const listeners = this.resourceListeners.get(message.key);
    if (!listeners || listeners.size === 0) return;
    for (const listener of listeners) listener(message);
  }

  private getLatestResult(key: string): SharedMessage | undefined {
    const entry = this.latestResults.get(key);
    if (!entry) return undefined;
    entry.lastAccessedAt = this.now();
    this.latestResults.delete(key);
    this.latestResults.set(key, entry);
    return entry.message;
  }

  private setLatestResult(key: string, message: SharedMessage): void {
    this.latestResults.delete(key);
    this.latestResults.set(key, { message, lastAccessedAt: this.now() });
    this.evictLeastRecentlyUsed(this.latestResults);
  }

  private getLastPublished(key: string): {
    dataUpdatedAt: number;
    fingerprint: string;
    sentAt: number;
    lastAccessedAt: number;
  } | undefined {
    const entry = this.lastPublished.get(key);
    if (!entry) return undefined;
    entry.lastAccessedAt = this.now();
    this.lastPublished.delete(key);
    this.lastPublished.set(key, entry);
    return entry;
  }

  private setLastPublished(key: string, entry: {
    dataUpdatedAt: number;
    fingerprint: string;
    sentAt: number;
    lastAccessedAt: number;
  }): void {
    this.lastPublished.delete(key);
    this.lastPublished.set(key, entry);
    this.evictLeastRecentlyUsed(this.lastPublished);
  }

  private evictLeastRecentlyUsed<T>(entries: Map<string, T>): void {
    const inactiveKeys = Array.from(entries.keys()).filter(
      (key) => (this.resourceListeners.get(key)?.size ?? 0) === 0,
    );
    while (inactiveKeys.length > MAX_COORDINATOR_CACHE_ENTRIES) {
      const oldestInactiveKey = inactiveKeys.shift();
      if (oldestInactiveKey === undefined) return;
      entries.delete(oldestInactiveKey);
    }
  }

  private evictIdleEntries(): void {
    const expiresBefore = this.now() - COORDINATOR_CACHE_TTL_MS;
    for (const [key, entry] of this.latestResults) {
      if ((this.resourceListeners.get(key)?.size ?? 0) > 0) continue;
      if (entry.lastAccessedAt < expiresBefore) this.latestResults.delete(key);
    }
    for (const [key, entry] of this.lastPublished) {
      if ((this.resourceListeners.get(key)?.size ?? 0) > 0) continue;
      if (entry.lastAccessedAt < expiresBefore) this.lastPublished.delete(key);
    }
  }

  private markInactive(key: string): void {
    const inactiveAt = this.now();
    const latest = this.latestResults.get(key);
    if (latest) latest.lastAccessedAt = inactiveAt;
    const published = this.lastPublished.get(key);
    if (published) published.lastAccessedAt = inactiveAt;
    this.evictLeastRecentlyUsed(this.latestResults);
    this.evictLeastRecentlyUsed(this.lastPublished);
  }

  private setSnapshot(snapshot: SharedPollingSnapshot): void {
    if (snapshot.isLeader === this.snapshot.isLeader) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private attachReleaseListeners(): void {
    if (typeof window === "undefined" || this.releaseListeners.length > 0) return;
    const release = () => this.election.release();
    const visibilityChanged = () => this.tick();
    window.addEventListener("pagehide", release);
    window.addEventListener("beforeunload", release);
    window.addEventListener("visibilitychange", visibilityChanged);
    this.releaseListeners = [
      () => window.removeEventListener("pagehide", release),
      () => window.removeEventListener("beforeunload", release),
      () => window.removeEventListener("visibilitychange", visibilityChanged),
    ];
  }
}
