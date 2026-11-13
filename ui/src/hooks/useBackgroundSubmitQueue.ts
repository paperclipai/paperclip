import { useCallback, useEffect, useRef, useState } from "react";
import type { ErrorDescription } from "@/api/errors";
import { classifySendFailure, PendingSendAccountChangedError, pendingSendKeyFor, type PendingSend } from "@/lib/pending-send";
import { useDraftOwner } from "./useDraftOwner";
import { usePendingWritesReporter } from "@/lib/connectivity";
import { useDurableSubmit, type DurableSubmitOptions } from "./useDurableSubmit";

type QueuedSubmit<T> = PendingSend<T> & { rejection?: ErrorDescription };

export function useBackgroundSubmitQueue<T, R>(options: DurableSubmitOptions<T, R> & {
  onAttention: (record: PendingSend<T>, error: ErrorDescription | null) => void;
}) {
  const owner = useDraftOwner();
  const storageKey = options.storageKey && owner !== undefined
    ? pendingSendKeyFor(`${options.storageKey}:queue`, owner) : null;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const recordKey = (key: string, id: string) => `${key}:request:${encodeURIComponent(id)}`;
  const readQueue = (): QueuedSubmit<T>[] => {
    if (!storageKey) return [];
    try {
      const storage = options.storage === "session" ? sessionStorage : localStorage;
      const isRecord = (item: unknown): item is QueuedSubmit<T> => !!item && typeof item === "object"
        && typeof (item as QueuedSubmit<T>).idempotencyKey === "string"
        && typeof (item as QueuedSubmit<T>).createdAt === "number"
        && options.isPayload((item as QueuedSubmit<T>).payload);
      const records = new Map<string, QueuedSubmit<T>>();
      try {
        const legacy: unknown = JSON.parse(storage.getItem(storageKey) ?? "[]");
        if (Array.isArray(legacy)) for (const item of legacy) {
          if (isRecord(item)) records.set(item.idempotencyKey, item);
        }
      } catch {}
      // Each request owns one atomic storage entry. A tab can update or remove
      // its request without replacing requests submitted in another tab.
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) {
        if (!key?.startsWith(`${storageKey}:request:`)) continue;
        try {
          const item: unknown = JSON.parse(storage.getItem(key) ?? "null");
          if (isRecord(item) && key === recordKey(storageKey, item.idempotencyKey)) records.set(item.idempotencyKey, item);
        } catch {}
      }
      return [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
    } catch { return []; }
  };
  const [queue, setQueue] = useState(readQueue);
  const queueRef = useRef(queue);
  const loadedKey = useRef(storageKey);
  const [round, setRound] = useState(0);
  const draining = useRef(false);
  const noticedKey = useRef<string | null>(null);
  const noticedRejections = useRef(new Set<string>());
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const replaceQueue = useCallback((next: QueuedSubmit<T>[]) => {
    const previous = queueRef.current;
    queueRef.current = next;
    setQueue(next);
    try {
      if (loadedKey.current) {
        const storage = optionsRef.current.storage === "session" ? sessionStorage : localStorage;
        const previousByKey = new Map(previous.map(item => [item.idempotencyKey, item]));
        const nextKeys = new Set(next.map(item => item.idempotencyKey));
        for (const item of next) {
          if (previousByKey.get(item.idempotencyKey) !== item) {
            storage.setItem(recordKey(loadedKey.current, item.idempotencyKey), JSON.stringify(item));
          }
        }
        for (const item of previous) {
          if (!nextKeys.has(item.idempotencyKey)) storage.removeItem(recordKey(loadedKey.current, item.idempotencyKey));
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (loadedKey.current !== storageKey) {
      const unbound = loadedKey.current === null ? queueRef.current : [];
      loadedKey.current = storageKey;
      queueRef.current = [];
      replaceQueue([...readQueue(), ...unbound]);
    }
    if (!storageKey) return;
    try {
      const storage = options.storage === "session" ? sessionStorage : localStorage;
      if (storage.getItem(storageKey) === null) return;
      // Retire the old shared array only after every legacy request has its
      // own entry. A storage failure leaves the legacy backup available.
      for (const item of readQueue()) storage.setItem(recordKey(storageKey, item.idempotencyKey), JSON.stringify(item));
      storage.removeItem(storageKey);
    } catch {}
  }, [storageKey, replaceQueue]);

  const durable = useDurableSubmit<T, R>({
    ...options,
    send: async (payload, idempotencyKey) => {
      try {
        return await optionsRef.current.send(payload, idempotencyKey);
      } catch (error) {
        if (active.current && !(error instanceof PendingSendAccountChangedError)
          && classifySendFailure(error) === "pending" && noticedKey.current !== idempotencyKey) {
          noticedKey.current = idempotencyKey;
          optionsRef.current.onAttention(queueRef.current.find(item => item.idempotencyKey === idempotencyKey)
            ?? { payload, idempotencyKey, createdAt: Date.now() }, null);
        }
        throw error;
      }
    },
    onSent: (result, record) => {
      if (!active.current) return;
      replaceQueue(queueRef.current.filter(item => item.idempotencyKey !== record.idempotencyKey));
      optionsRef.current.onSent?.(result, record);
    },
    onRejected: (error, description, record) => {
      if (!active.current) return;
      replaceQueue(queueRef.current.map(item => item.idempotencyKey === record.idempotencyKey
        ? { ...item, payload: record.payload, rejection: description } : item));
      optionsRef.current.onRejected?.(error, description, record);
      noticedRejections.current.add(record.idempotencyKey);
      optionsRef.current.onAttention(record, description);
    },
  });

  useEffect(() => {
    if (owner === undefined || durable.pending || draining.current) return;
    const next = queue.find(item => !item.rejection);
    if (!next) return;
    draining.current = true;
    void durable.submit(next.payload, { idempotencyKey: next.idempotencyKey }).finally(() => {
      draining.current = false;
      if (active.current) setRound(value => value + 1);
    });
  }, [owner, queue, durable.pending, durable.submit, round]);

  useEffect(() => {
    for (const record of queue) {
      if (!record.rejection || noticedRejections.current.has(record.idempotencyKey)) continue;
      noticedRejections.current.add(record.idempotencyKey);
      optionsRef.current.onAttention(record, record.rejection);
    }
  }, [queue]);

  usePendingWritesReporter(`${options.sourceId}:queue`, queue.filter(item =>
    !item.rejection && item.idempotencyKey !== durable.pending?.idempotencyKey).length);

  const enqueue = useCallback((payload: T, idempotencyKey: string) => {
    if (noticedKey.current === idempotencyKey) noticedKey.current = null;
    noticedRejections.current.delete(idempotencyKey);
    replaceQueue([
      ...queueRef.current.filter(item => item.idempotencyKey !== idempotencyKey),
      { payload, idempotencyKey, createdAt: Date.now() },
    ]);
  }, [replaceQueue]);

  const discard = useCallback((idempotencyKey: string) => {
    if (durable.pending?.idempotencyKey === idempotencyKey) durable.cancel();
    replaceQueue(queueRef.current.filter(item => item.idempotencyKey !== idempotencyKey));
  }, [durable.pending, durable.cancel, replaceQueue]);

  return { ...durable, enqueue, discard, rejected: queue.filter(item => item.rejection) };
}
