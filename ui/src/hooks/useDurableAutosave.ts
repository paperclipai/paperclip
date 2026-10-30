import { useCallback, useEffect, useId, useRef, useState } from "react";
import { classifyError, describeError, type ErrorDescription } from "@/api/errors";
import { loadStructuredDraft, saveStructuredDraft } from "@/lib/composer-draft";
import { useConnectivityStore } from "@/lib/connectivity";
import { classifySendFailure, MAX_ONLINE_RESENDS, resendDelayFor, type SendOutcome } from "@/lib/pending-send";
import { useAutoResend } from "./useDurableSubmit";
import { useDraftOwner, useDraftOwnerReader } from "./useDraftOwner";

export type DurableAutosaveStatus =
  | "idle"
  | "saving"
  | "saved"
  /** Kept locally; it saves when the connection allows. */
  | "waiting"
  | "stalled"
  | "error";

export type DurableAutosaveResult =
  | { kind: "saved" }
  | { kind: "waiting" }
  /** A definitive failure; the caller may handle it (a conflict view, a lock notice). */
  | { kind: "failed"; error: unknown };

/** Copy for the autosave indicator. */
export function autosaveLabel(status: DurableAutosaveStatus, error: ErrorDescription | null): string | null {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "waiting":
      return "Will save when reconnected";
    case "stalled":
      return "Automatic saving paused";
    case "error":
      return error ? `Couldn't save (${error.body.replace(/\.$/, "")})` : "Couldn't save";
    default:
      return null;
  }
}

export interface DurableAutosaveOptions<T> {
  sourceId: string;
  targetKey?: string;
  /** Writes `draft`. Only absolute-value writes (PUT a body, PATCH a field) are safe to retry. */
  save: (draft: T) => Promise<unknown>;
  /**
   * A 409 can be a replay after a lost response: our earlier save landed, so
   * the retry's base revision is stale. Return true when the server already
   * holds `draft`; the save then counts as done.
   */
  matchesServer?: (error: unknown, draft: T) => Promise<boolean> | boolean;
  /** Persist unsaved drafts here (localStorage); null keeps them in memory. */
  storageKey?: string | null;
  /** For error copy: "save the document". */
  action?: string;
}

/** Per-save overrides: a caller can bind the request and the 409 check to one draft. */
export interface DurableAutosaveJob<T> {
  save?: (draft: T) => Promise<unknown>;
  matchesServer?: (error: unknown, draft: T) => Promise<boolean> | boolean;
  /**
   * A background retry of this draft failed definitively. `run` returns that
   * outcome to its caller, but nobody awaits an automatic retry.
   */
  onRetryFailed?: (error: unknown) => void;
}

export interface DurableAutosave<T> {
  status: DurableAutosaveStatus;
  error: ErrorDescription | null;
  label: string | null;
  /** Save now. Never rejects: failures become a status, so no rejection goes unhandled. */
  run: (draft: T, job?: DurableAutosaveJob<T>) => Promise<DurableAutosaveResult>;
  /** The draft changed; drop a stale "Saved" or error. */
  markDirty: () => void;
  /** Forget pending work and go back to idle (the user cancelled or reverted). */
  reset: () => void;
  /** Write the current draft to storage so a reload or crash keeps it. */
  persistDraft: (draft: T) => void;
  /** An unsaved draft from an earlier session, if any. */
  readStoredDraft: () => T | null;
  clearStoredDraft: () => void;
  resendNow: () => void;
}

type AutosaveRevision = { latest: symbol; active: Set<symbol> };
const latestAutosaves = new WeakMap<object, Map<string, AutosaveRevision>>();
function autosaveRegistry(store: object): Map<string, AutosaveRevision> {
  let registry = latestAutosaves.get(store);
  if (!registry) { registry = new Map(); latestAutosaves.set(store, registry); }
  return registry;
}

const SAVING_DELAY_MS = 250;
const SAVED_LINGER_MS = 1600;

/**
 * Autosave that does not lose text across outages:
 *
 * - The draft can be persisted on every change (`persistDraft`) and is
 *   cleared only after a confirmed save.
 * - A transient failure keeps the draft and saves it again with backoff and
 *   right after the connection recovers. While the app is offline it does not
 *   send at all.
 * - A 409 whose server copy equals our draft counts as saved.
 * - Errors become readable copy for "Couldn't save (reason)".
 */
export function useDurableAutosave<T>(options: DurableAutosaveOptions<T>): DurableAutosave<T> {
  const owner = useDraftOwner();
  const readOwner = useDraftOwnerReader();
  const instanceId = useId();
  const detachedWork = useRef<() => void>(() => {});
  const detachedWake = useRef<(() => void) | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const targetKey = options.targetKey ?? options.sourceId;
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  type Job = { token: symbol; registryKey: string; resends: number; saving?: boolean; id: number; target: string; owner: string | undefined; draft: T;
    save: (draft: T) => Promise<unknown>; matchesServer?: DurableAutosaveOptions<T>["matchesServer"];
    onRetryFailed?: DurableAutosaveJob<T>["onRetryFailed"]; storageKey: string | null; action: string };
  const jobs = useRef(new Map<string, Job>());
  const generations = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const [, refresh] = useState(0);
  type View = { target: string; status: DurableAutosaveStatus; error: ErrorDescription | null };
  const [view, setViewState] = useState<View>({ target: targetKey, status: "idle", error: null });
  const setView = useCallback((next: View | ((current: View) => View)) => {
    setViewState(current => {
      const value = typeof next === "function" ? next(current) : next;
      return current.target === value.target && current.status === value.status && current.error === value.error ? current : value;
    });
  }, []);
  const store = useConnectivityStore();
  const registry = autosaveRegistry(store);
  const releaseJob = (job: Job) => {
    const entry = registry.get(job.registryKey);
    entry?.active.delete(job.token);
    if (entry && !entry.active.size) registry.delete(job.registryKey);
  };
  const mounted = useRef(true);
  const savingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = useCallback(() => {
    if (savingTimer.current) clearTimeout(savingTimer.current);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savingTimer.current = null;
    savedTimer.current = null;
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimers(); detachedWork.current(); }; }, [clearTimers]);
  const previousOwner = useRef(owner);
  useEffect(() => {
    const previous = previousOwner.current;
    previousOwner.current = owner;
    if (previous === owner) return;
    if (previous === undefined && owner !== undefined) {
      for (const job of jobs.current.values()) {
        if (job.owner !== undefined) continue;
        const nextKey = JSON.stringify([owner, job.target]);
        const superseded = registry.get(job.registryKey)?.latest !== job.token || registry.has(nextKey);
        releaseJob(job);
        if (superseded) {
          jobs.current.delete(job.target);
          if (generations.current.get(job.target) === job.id) generations.current.delete(job.target);
          continue;
        }
        job.owner = owner;
        job.registryKey = nextKey;
        registry.set(nextKey, { latest: job.token, active: new Set([job.token]) });
      }
      refresh(value => value + 1);
      return;
    }
    for (const job of jobs.current.values()) releaseJob(job);
    jobs.current.clear(); generations.current.clear(); clearTimers();
    setView({ target: targetRef.current, status: "idle", error: null });
    refresh(value => value + 1);
  }, [owner, clearTimers]);
  const storageKey = options.storageKey ?? null;
  const persistDraft = useCallback((draft: T) => {
    if (storageKey) saveStructuredDraft(storageKey, { version: 1, draft });
  }, [storageKey]);
  const clearStoredDraft = useCallback(() => {
    if (!storageKey) return;
    try { localStorage.removeItem(storageKey); } catch {}
  }, [storageKey]);
  const readStoredDraft = useCallback((): T | null => {
    if (!storageKey) return null;
    const stored = loadStructuredDraft<{ version?: unknown; draft?: T } | null>(storageKey, null);
    return stored?.version === 1 && stored.draft !== undefined ? stored.draft : null;
  }, [storageKey]);
  const execute = useCallback(async (job: Job, retry = false): Promise<DurableAutosaveResult> => {
    const owned = () => readOwner() === job.owner && generations.current.get(job.target) === job.id && registry.get(job.registryKey)?.latest === job.token;
    const visible = () => mounted.current && owned() && targetRef.current === job.target;
    const publish = (status: DurableAutosaveStatus, error: ErrorDescription | null = null) => {
      if (visible()) setView({ target: job.target, status, error });
    };
    if (!owned()) {
      if (jobs.current.get(job.target) === job) jobs.current.delete(job.target);
      releaseJob(job);
      if (mounted.current) refresh(value => value + 1);
      return { kind: "waiting" };
    }
    if (job.saving) return { kind: "waiting" };
    if (visible()) clearTimers();
    if (store.getSnapshot().status !== "online") { publish("waiting"); return { kind: "waiting" }; }
    if (retry) job.resends += 1;
    job.saving = true;
    if (visible()) savingTimer.current = setTimeout(() => publish("saving"), SAVING_DELAY_MS);
    refresh(value => value + 1);
    const remove = () => {
      releaseJob(job);
      if (jobs.current.get(job.target) === job) jobs.current.delete(job.target);
      if (mounted.current) refresh(value => value + 1);
    };
    const done = (): DurableAutosaveResult => {
      if (job.storageKey) {
        const stored = loadStructuredDraft<{ draft?: T } | null>(job.storageKey, null);
        if (stored && JSON.stringify(stored.draft) === JSON.stringify(job.draft)) {
          try { localStorage.removeItem(job.storageKey); } catch {}
        }
      }
      if (visible()) {
        clearTimers(); publish("saved");
        savedTimer.current = setTimeout(() => {
          if (mounted.current && readOwner() === job.owner && generations.current.get(job.target) === job.id && targetRef.current === job.target)
            setView(current => current.target === job.target && current.status === "saved" ? { ...current, status: "idle" } : current);
        }, SAVED_LINGER_MS);
      }
      remove();
      return { kind: "saved" };
    };
    try { await job.save(job.draft); return done(); }
    catch (initialCause) {
      let cause = initialCause;
      if (classifyError(cause) === "conflict" && job.matchesServer) {
        try { if (await job.matchesServer(cause, job.draft)) return done(); }
        catch (verificationError) { cause = verificationError; }
      }
      if (classifySendFailure(cause) === "pending") {
        if (visible()) clearTimers();
        publish("waiting"); return { kind: "waiting" };
      }
      if (visible()) clearTimers();
      publish("error", describeError(cause, { action: job.action }));
      remove();
      return { kind: "failed", error: cause };
    } finally { job.saving = false; if (mounted.current) refresh(value => value + 1); else detachedWake.current?.(); }
  }, [clearTimers, store, readOwner]);
  const run = useCallback(async (draft: T, overrides: DurableAutosaveJob<T> = {}) => {
    const current = optionsRef.current;
    const target = current.targetKey ?? current.sourceId;
    const admittedOwner = ownerRef.current ?? readOwner();
    const job: Job = { token: Symbol(), registryKey: JSON.stringify([admittedOwner, target]), resends: 0, id: ++sequence.current, target, owner: admittedOwner, draft,
      save: overrides.save ?? current.save, matchesServer: overrides.matchesServer ?? current.matchesServer,
      onRetryFailed: overrides.onRetryFailed, storageKey: current.storageKey ?? null, action: current.action ?? "save" };
    const previous = jobs.current.get(target);
    if (previous) releaseJob(previous);
    let revision = registry.get(job.registryKey);
    if (!revision) { revision = { latest: job.token, active: new Set() }; registry.set(job.registryKey, revision); }
    revision.latest = job.token; revision.active.add(job.token);
    generations.current.set(target, job.id); jobs.current.set(target, job);
    refresh(value => value + 1);
    return execute(job);
  }, [execute, readOwner]);
  const waitingJobs = [...jobs.current.values()].filter(job => !job.saving).length;
  const auto = useAutoResend({ sourceId: options.sourceId, active: waitingJobs > 0, pendingCount: waitingJobs,
    resend: async (): Promise<SendOutcome> => {
      for (const job of [...jobs.current.values()]) {
        if (jobs.current.get(job.target) !== job) continue;
        const result = await execute(job, true);
        if (result.kind === "failed") job.onRetryFailed?.(result.error);
      }
      return jobs.current.size ? "pending" : "sent";
    },
  });
  detachedWork.current = () => {
    if (!jobs.current.size) return;
    if (auto.stalled) { for (const job of jobs.current.values()) releaseJob(job); jobs.current.clear(); return; }
    const admittedOwner = ownerRef.current;
    const source = `${optionsRef.current.sourceId}:detached:${instanceId}`;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false, running = false;
    let unsubscribe = () => {};
    const release = () => {
      disposed = true;
      if (!mounted.current) {
        for (const job of jobs.current.values()) releaseJob(job);
        jobs.current.clear();
      }
      if (timer) clearTimeout(timer);
      unsubscribe(); detachedWake.current = null;
      store.setPendingWrites(source, 0);
    };
    const wake = async () => {
      if (disposed || running) return;
      if (mounted.current || readOwner() !== admittedOwner || admittedOwner === undefined) { release(); return; }
      if (!jobs.current.size) { release(); return; }
      store.setPendingWrites(source, jobs.current.size);
      if (store.getSnapshot().status !== "online") return;
      running = true;
      for (const job of [...jobs.current.values()]) {
        if (job.saving || job.resends >= MAX_ONLINE_RESENDS) continue;
        const result = await execute(job, true);
        if (result.kind === "failed") job.onRetryFailed?.(result.error);
      }
      running = false;
      if (disposed) return;
      const waiting = [...jobs.current.values()].filter(job => !job.saving && job.resends < MAX_ONLINE_RESENDS);
      if (!waiting.length && ![...jobs.current.values()].some(job => job.saving)) { release(); return; }
      store.setPendingWrites(source, jobs.current.size);
      if (waiting.length && store.getSnapshot().status === "online") {
        timer = setTimeout(() => { timer = null; void wake(); }, resendDelayFor(Math.max(...waiting.map(job => job.resends))));
      }
    };
    detachedWake.current = () => { if (!running) void wake(); };
    unsubscribe = store.onRecover(() => {
      if (timer) clearTimeout(timer);
      for (const job of jobs.current.values()) job.resends = 0;
      void wake();
    });
    store.setPendingWrites(source, jobs.current.size);
    timer = setTimeout(() => { timer = null; void wake(); }, 0);
  };

  const markDirty = useCallback(() => {
    clearTimers();
    setView(current => ({ target: targetRef.current, status: jobs.current.has(targetRef.current) ? "waiting" : "idle", error: null }));
  }, [clearTimers]);
  const reset = useCallback(() => {
    const job = jobs.current.get(targetRef.current);
    if (job) {
      const revision = registry.get(job.registryKey);
      if (revision?.latest === job.token) revision.latest = Symbol();
      releaseJob(job);
    }
    generations.current.delete(targetRef.current); const removed = jobs.current.delete(targetRef.current); clearTimers();
    setView({ target: targetRef.current, status: "idle", error: null }); if (removed) refresh(value => value + 1);
  }, [clearTimers]);
  const baseStatus = view.target === targetKey ? view.status : jobs.current.has(targetKey) ? "waiting" : "idle";
  const status = baseStatus === "waiting" && auto.stalled ? "stalled" : baseStatus;
  const error = view.target === targetKey ? view.error : null;
  return { status, error, label: autosaveLabel(status, error), run, markDirty, reset,
    persistDraft, readStoredDraft, clearStoredDraft, resendNow: auto.resendNow };
}
