import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, type ErrorDescription } from "@/api/errors";
import { useConnectivity, useConnectivityStore, usePendingWritesReporter } from "@/lib/connectivity";
import {
  MAX_ONLINE_RESENDS,
  classifySendFailure,
  clearPendingSend,
  readPendingSend,
  resendDelayFor,
  writePendingSend,
  type PendingSend,
  type PendingSendStorage,
  type SendOutcome,
} from "@/lib/pending-send";

export interface AutoResendOptions {
  /** Distinct per surface instance; the connection banner counts one pending write per source. */
  sourceId: string;
  /** A send is waiting to be resent. */
  active: boolean;
  /** Resend the waiting payload with its original idempotency key. */
  resend: () => Promise<SendOutcome>;
  /**
   * False for writes the server does not dedupe: the payload is kept and
   * counted, but only `resendNow` (a Retry button) sends it again.
   */
  auto?: boolean;
}

export interface AutoResendState {
  /** A resend is in flight. */
  resending: boolean;
  /** Automatic resends stopped while online; the user can still resend now. */
  stalled: boolean;
  resendNow: () => void;
}

/**
 * Resend a waiting write when the connection allows it: right after the app
 * recovers from an outage, and with backoff while the app looks online (a
 * single failed request does not always move the connectivity store). Nothing
 * is sent while the store reports an outage.
 */
export function useAutoResend({ sourceId, active, resend, auto = true }: AutoResendOptions): AutoResendState {
  const store = useConnectivityStore();
  const online = useConnectivity().status === "online";
  usePendingWritesReporter(sourceId, active ? 1 : 0);

  const resendRef = useRef(resend);
  resendRef.current = resend;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const inFlight = useRef(false);
  const attempts = useRef(0);
  const wasOnline = useRef(online);
  const [resending, setResending] = useState(false);
  const [stalled, setStalled] = useState(false);
  // Bumped after each failed resend so the schedule effect plans the next one.
  const [round, setRound] = useState(0);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setResending(true);
    let outcome: SendOutcome;
    try {
      outcome = await resendRef.current();
    } catch (error) {
      outcome = classifySendFailure(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setResending(false);
    }
    if (!mounted.current) return;
    if (outcome === "pending") {
      attempts.current += 1;
      setRound((value) => value + 1);
    } else {
      attempts.current = 0;
      setStalled(false);
    }
  }, []);

  useEffect(() => {
    if (active) return;
    attempts.current = 0;
    setStalled(false);
  }, [active]);

  useEffect(() => {
    const recovered = online && !wasOnline.current;
    wasOnline.current = online;
    if (!active || !auto || !online) return;
    if (recovered) {
      // An outage ended: start a fresh round and resend right away.
      attempts.current = 0;
      setStalled(false);
    } else if (attempts.current >= MAX_ONLINE_RESENDS) {
      setStalled(true);
      return;
    }
    const timer = setTimeout(() => void run(), recovered ? 0 : resendDelayFor(attempts.current));
    return () => clearTimeout(timer);
  }, [active, auto, online, round, run]);

  const resendNow = useCallback(() => {
    if (!online) store.probeNow();
    attempts.current = 0;
    setStalled(false);
    void run();
  }, [online, run, store]);

  return { resending, stalled, resendNow };
}

export type DurableSubmitResult<R> =
  | { kind: "sent"; result: R }
  | { kind: "pending"; error: unknown }
  | { kind: "rejected"; error: unknown; description: ErrorDescription };

export type DurableSubmitStatus =
  | "idle"
  /** The first attempt is in flight. */
  | "sending"
  /** Kept; it resends with the same key when the connection allows. */
  | "waiting"
  /** Kept, but automatic resends stopped; offer Resend now. */
  | "stalled";

export interface DurableSubmitOptions<T, R> {
  sourceId: string;
  /** Where the pending record lives; null keeps it in memory only. */
  storageKey: string | null;
  storage?: PendingSendStorage;
  /** Validates a stored payload before it is resent. */
  isPayload: (value: unknown) => value is T;
  send: (payload: T, idempotencyKey: string) => Promise<R>;
  onSent?: (result: R, pending: PendingSend<T>) => void;
  onRejected?: (error: unknown, description: ErrorDescription, pending: PendingSend<T>) => void;
  /** What the user was doing, for rejection copy: "create the task". */
  action?: string;
  /** False for writes the server does not dedupe (see `useAutoResend`). */
  autoResend?: boolean;
}

export interface DurableSubmit<T, R> {
  status: DurableSubmitStatus;
  pending: PendingSend<T> | null;
  /** Copy for the last definitive rejection; cleared by the next submit. */
  error: ErrorDescription | null;
  resending: boolean;
  submit: (payload: T, options?: { idempotencyKey?: string }) => Promise<DurableSubmitResult<R>>;
  resendNow: () => void;
  /** Stop resending and forget the record. Returns the payload so its text can go back to the editor. */
  cancel: () => T | null;
}

/**
 * Send a keyed write so that it survives outages and reloads. The payload and
 * key are stored before the request and cleared only on a confirmed receipt or
 * a definitive rejection; anything in between resends with the same key.
 */
export function useDurableSubmit<T, R>(options: DurableSubmitOptions<T, R>): DurableSubmit<T, R> {
  const { sourceId, storageKey, storage = "local", autoResend = true } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const load = () => (storageKey ? readPendingSend(storageKey, options.isPayload, storage) : null);
  const [pending, setPendingState] = useState<PendingSend<T> | null>(load);
  const pendingRef = useRef(pending);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const inFlight = useRef<string | null>(null);

  const setPending = useCallback((next: PendingSend<T> | null) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  const loadedKey = useRef(storageKey);
  useEffect(() => {
    if (loadedKey.current === storageKey) return;
    loadedKey.current = storageKey;
    setPending(storageKey ? readPendingSend(storageKey, optionsRef.current.isPayload, storage) : null);
    setError(null);
  }, [setPending, storage, storageKey]);

  const attempt = useCallback(
    async (record: PendingSend<T>): Promise<DurableSubmitResult<R>> => {
      if (inFlight.current === record.idempotencyKey) return { kind: "pending", error: null };
      inFlight.current = record.idempotencyKey;
      const key = loadedKey.current;
      const current = () => pendingRef.current?.idempotencyKey === record.idempotencyKey;
      try {
        const result = await optionsRef.current.send(record.payload, record.idempotencyKey);
        if (key) clearPendingSend(key, record.idempotencyKey, storage);
        if (current()) setPending(null);
        optionsRef.current.onSent?.(result, record);
        return { kind: "sent", result };
      } catch (cause) {
        if (classifySendFailure(cause) === "pending") return { kind: "pending", error: cause };
        if (key) clearPendingSend(key, record.idempotencyKey, storage);
        const description = describeError(cause, { action: optionsRef.current.action });
        if (current()) {
          setPending(null);
          setError(description);
        }
        optionsRef.current.onRejected?.(cause, description, record);
        return { kind: "rejected", error: cause, description };
      } finally {
        if (inFlight.current === record.idempotencyKey) inFlight.current = null;
      }
    },
    [setPending, storage],
  );

  const submit = useCallback(
    async (payload: T, submitOptions: { idempotencyKey?: string } = {}): Promise<DurableSubmitResult<R>> => {
      if (pendingRef.current) return { kind: "pending", error: null };
      const record: PendingSend<T> = {
        idempotencyKey: submitOptions.idempotencyKey ?? crypto.randomUUID(),
        payload,
        createdAt: Date.now(),
      };
      // Persist before the request: a reload or lost response must find it.
      if (loadedKey.current) writePendingSend(loadedKey.current, record, storage);
      setPending(record);
      setError(null);
      setSending(true);
      try {
        return await attempt(record);
      } finally {
        setSending(false);
      }
    },
    [attempt, setPending, storage],
  );

  const auto = useAutoResend({
    sourceId,
    active: pending !== null && !sending,
    auto: autoResend,
    resend: async () => {
      const record = pendingRef.current;
      if (!record) return "sent";
      const result = await attempt(record);
      return result.kind;
    },
  });

  const cancel = useCallback((): T | null => {
    const record = pendingRef.current;
    if (!record) return null;
    if (loadedKey.current) clearPendingSend(loadedKey.current, record.idempotencyKey, storage);
    setPending(null);
    return record.payload;
  }, [setPending, storage]);

  const status: DurableSubmitStatus = sending
    ? "sending"
    : pending
      ? auto.stalled ? "stalled" : "waiting"
      : "idle";

  return { status, pending, error, resending: auto.resending, submit, resendNow: auto.resendNow, cancel };
}
