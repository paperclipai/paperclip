import { useCallback, useEffect, useRef, useState } from "react";
import { classifyError, describeError, type ErrorDescription } from "@/api/errors";
import { loadStructuredDraft, saveStructuredDraft } from "@/lib/composer-draft";
import { useConnectivityStore } from "@/lib/connectivity";
import { classifySendFailure, type SendOutcome } from "@/lib/pending-send";
import { useAutoResend } from "./useDurableSubmit";

export type DurableAutosaveStatus =
  | "idle"
  | "saving"
  | "saved"
  /** Kept locally; it saves when the connection allows. */
  | "waiting"
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
    case "error":
      return error ? `Couldn't save (${error.body.replace(/\.$/, "")})` : "Couldn't save";
    default:
      return null;
  }
}

export interface DurableAutosaveOptions<T> {
  sourceId: string;
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
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const store = useConnectivityStore();
  const [status, setStatus] = useState<DurableAutosaveStatus>("idle");
  const [error, setError] = useState<ErrorDescription | null>(null);
  const runId = useRef(0);
  const savingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The newest draft that still needs saving, with the functions that save it. */
  const pendingJob = useRef<{ draft: T; overrides: DurableAutosaveJob<T> } | null>(null);
  const mounted = useRef(true);

  const clearTimers = useCallback(() => {
    if (savingTimer.current) clearTimeout(savingTimer.current);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savingTimer.current = null;
    savedTimer.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  const storageKey = options.storageKey ?? null;
  const persistDraft = useCallback((draft: T) => {
    if (storageKey) saveStructuredDraft(storageKey, { version: 1, draft });
  }, [storageKey]);
  const clearStoredDraft = useCallback(() => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Unavailable storage holds nothing to clear.
    }
  }, [storageKey]);
  const readStoredDraft = useCallback((): T | null => {
    if (!storageKey) return null;
    const stored = loadStructuredDraft<{ version?: unknown; draft?: T } | null>(storageKey, null);
    return stored && stored.version === 1 && stored.draft !== undefined ? stored.draft : null;
  }, [storageKey]);

  const run = useCallback(
    async (draft: T, overrides: DurableAutosaveJob<T> = {}): Promise<DurableAutosaveResult> => {
      const job = { draft, overrides };
      const save = overrides.save ?? optionsRef.current.save;
      const matchesServer = overrides.matchesServer ?? optionsRef.current.matchesServer;
      const id = ++runId.current;
      const latest = () => mounted.current && runId.current === id;
      pendingJob.current = job;
      clearTimers();
      setError(null);

      // During an outage, hold the draft instead of sending into it.
      if (store.getSnapshot().status !== "online") {
        setStatus("waiting");
        return { kind: "waiting" };
      }

      savingTimer.current = setTimeout(() => {
        if (latest()) setStatus("saving");
      }, SAVING_DELAY_MS);
      const done = (): DurableAutosaveResult => {
        if (pendingJob.current === job) pendingJob.current = null;
        // The stored copy is only a safety net; drop it once this exact draft is saved.
        const stored = readStoredDraft();
        if (stored !== null && JSON.stringify(stored) === JSON.stringify(draft)) clearStoredDraft();
        if (latest()) {
          clearTimers();
          setStatus("saved");
          savedTimer.current = setTimeout(() => {
            if (latest()) setStatus("idle");
          }, SAVED_LINGER_MS);
        }
        return { kind: "saved" };
      };

      try {
        await save(draft);
        return done();
      } catch (cause) {
        if (classifyError(cause) === "conflict" && matchesServer) {
          let matches = false;
          try {
            matches = await matchesServer(cause, draft);
          } catch {
            matches = false;
          }
          if (matches) return done();
        }
        if (classifySendFailure(cause) === "pending") {
          if (latest()) {
            clearTimers();
            setStatus("waiting");
          }
          return { kind: "waiting" };
        }
        if (pendingJob.current === job) pendingJob.current = null;
        if (latest()) {
          clearTimers();
          setStatus("error");
          setError(describeError(cause, { action: optionsRef.current.action ?? "save" }));
        }
        return { kind: "failed", error: cause };
      }
    },
    [clearStoredDraft, clearTimers, readStoredDraft, store],
  );

  useAutoResend({
    sourceId: options.sourceId,
    active: status === "waiting",
    resend: async (): Promise<SendOutcome> => {
      const job = pendingJob.current;
      if (!job) {
        setStatus("idle");
        return "sent";
      }
      const result = await run(job.draft, job.overrides);
      return result.kind === "saved" ? "sent" : result.kind === "waiting" ? "pending" : "rejected";
    },
  });

  const markDirty = useCallback(() => {
    clearTimers();
    setStatus((current) => (current === "waiting" ? current : "idle"));
    setError(null);
  }, [clearTimers]);

  const reset = useCallback(() => {
    runId.current += 1;
    pendingJob.current = null;
    clearTimers();
    setStatus("idle");
    setError(null);
  }, [clearTimers]);

  return {
    status,
    error,
    label: autosaveLabel(status, error),
    run,
    markDirty,
    reset,
    persistDraft,
    readStoredDraft,
    clearStoredDraft,
  };
}
