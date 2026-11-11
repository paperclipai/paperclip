import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UiLayoutPreference, UiLayoutSurface } from "@paperclipai/shared";
import { authApi } from "../api/auth";
import { describeError } from "../api/errors";
import { uiLayoutsApi } from "../api/uiLayouts";
import { queryKeys } from "../lib/queryKeys";
import { useAccountBoundMutation } from "./useAccountBoundMutation";

export const UI_LAYOUT_SAVE_DEBOUNCE_MS = 1_500;
export const UI_LAYOUT_KEEPALIVE_MAX_BYTES = 60_000;
export const UI_LAYOUT_SAVE_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000];

export type UiLayoutSaveState = "idle" | "pending" | "saving" | "saved" | "error";

export type UiLayoutBlock = "load-error" | "unreadable" | null;

type PendingLayout<TLayout> = { companyId: string; userId: string; layout: TLayout };
type SaveAttempt<TLayout> = PendingLayout<TLayout> & { resetEpoch: number };
type SaveInput<TLayout> = SaveAttempt<TLayout> & { controller: AbortController };

type SessionIdentity = { user?: { id?: string } | null; session?: { userId?: string } | null } | null | undefined;

function sessionUserId(session: SessionIdentity): string {
  return session?.user?.id ?? session?.session?.userId ?? "local-board";
}

type UseUiLayoutParams<TLayout> = {
  companyId: string | null | undefined;
  surface: UiLayoutSurface;
  resolve: (raw: unknown) => TLayout | null;
  enabled?: boolean;
};

export function useUiLayout<TLayout>({ companyId, surface, resolve, enabled = true }: UseUiLayoutParams<TLayout>) {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = sessionUserId(session.data);
  const isCurrentUser = useCallback(
    (owner: string) => sessionUserId(queryClient.getQueryData<SessionIdentity>(queryKeys.auth.session)) === owner,
    [queryClient],
  );
  const sessionReady = session.data !== undefined;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const ownerRef = useRef(userId);
  const queryKey = useMemo(
    () => queryKeys.uiLayouts.mine(companyId ?? "__none__", surface, userId),
    [companyId, surface, userId],
  );
  const [saveState, setSaveState] = useState<UiLayoutSaveState>("idle");
  const [saveError, setSaveError] = useState<unknown>(null);
  const pendingRef = useRef<PendingLayout<TLayout> | null>(null);
  const inFlightSaveRef = useRef<SaveInput<TLayout> | null>(null);
  const retryAttemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const lastSavedRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const resetEpochRef = useRef(0);
  const queuedResetRef = useRef<string | null>(null);
  const resetInFlightRef = useRef(false);
  const [resetting, setResetting] = useState(false);
  const resetAfterSettleRef = useRef<string | null>(null);
  const startResetRef = useRef<(companyId: string) => void>(() => {});
  const flushRef = useRef<() => void>(() => {});

  const query = useQuery({
    queryKey,
    queryFn: () => uiLayoutsApi.get(companyId!, surface),
    enabled: Boolean(companyId) && enabled && sessionReady,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  const stored = useMemo(
    () => (query.data?.layout == null ? null : resolve(query.data.layout)),
    [query.data?.layout, resolve],
  );
  const [overwriteAllowedFor, setOverwriteAllowedFor] = useState<unknown>(null);
  const hasUnreadableLayout = query.data !== undefined && query.data.layout != null && stored === null;
  const loadFailure = query.data === undefined ? query.error ?? (sessionReady ? null : session.error) : null;
  const blocked: UiLayoutBlock = loadFailure
    ? "load-error"
    : hasUnreadableLayout && overwriteAllowedFor !== query.data?.layout
      ? "unreadable"
      : null;
  const writable = Boolean(companyId) && enabled && query.data !== undefined && blocked === null;
  const writableRef = useRef(writable);
  writableRef.current = writable;
  const unreadableLayout = hasUnreadableLayout ? query.data?.layout : null;
  const replacementRef = useRef(false);
  const allowOverwrite = useCallback(
    (replacement?: TLayout) => {
      setOverwriteAllowedFor(unreadableLayout);
      if (replacement === undefined || !companyId) return;
      pendingRef.current = { companyId, userId, layout: replacement };
      replacementRef.current = true;
      setSaveState("pending");
    },
    [unreadableLayout, companyId, userId],
  );
  const { refetch } = query;
  const { refetch: refetchSession } = session;
  const retryLoad = useCallback(() => void (sessionReady ? refetch() : refetchSession()), [sessionReady, refetch, refetchSession]);

  const handleSaved = useCallback(
    (preference: UiLayoutPreference, attempt: SaveAttempt<TLayout>) => {
      if (attempt.resetEpoch !== resetEpochRef.current) return;
      queryClient.setQueryData(queryKeys.uiLayouts.mine(attempt.companyId, surface, attempt.userId), preference);
      retryAttemptRef.current = 0;
      setSaveError(null);
      setSaveState(pendingRef.current ? "pending" : "saved");
    },
    [queryClient, surface],
  );

  const handleSaveFailed = useCallback((error: unknown, attempt: SaveAttempt<TLayout>) => {
    lastSavedRef.current = null;
    if (attempt.resetEpoch !== resetEpochRef.current) return;
    if (!pendingRef.current) pendingRef.current = { companyId: attempt.companyId, userId: attempt.userId, layout: attempt.layout };
    setSaveError(error);
    setSaveState("error");
    if (timerRef.current !== null || !describeError(error).retryable) return;
    const delay = UI_LAYOUT_SAVE_RETRY_DELAYS_MS[retryAttemptRef.current];
    if (delay === undefined) return;
    retryAttemptRef.current += 1;
    timerRef.current = window.setTimeout(() => flushRef.current(), delay);
  }, []);

  const saveMutation = useAccountBoundMutation({
    mutationFn: (input: SaveInput<TLayout>) =>
      uiLayoutsApi.save(input.companyId, surface, input.layout, { signal: input.controller.signal }),
    onMutate: () => setSaveState("saving"),
    onSuccess: (preference: UiLayoutPreference, input) => {
      if (!input.controller.signal.aborted) handleSaved(preference, input);
    },
    onError: (error, input) => {
      if (!input.controller.signal.aborted) handleSaveFailed(error, input);
    },
    onFinished: (input) => {
      if (input.controller.signal.aborted) return;
      inFlightRef.current = false;
      inFlightSaveRef.current = null;
      resetAfterSettleRef.current = queuedResetRef.current;
      queuedResetRef.current = null;
      if (resetAfterSettleRef.current) setResetting(false);
    },
    onSettled: (_preference, error, input) => {
      if (input.controller.signal.aborted) return;
      const queuedReset = resetAfterSettleRef.current;
      resetAfterSettleRef.current = null;
      if (queuedReset) {
        startResetRef.current(queuedReset);
        return;
      }
      if (!error && pendingRef.current && timerRef.current === null) flushRef.current();
    },
  });
  const mutateRef = useRef(saveMutation.mutate);
  mutateRef.current = saveMutation.mutate;

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    if (inFlightRef.current) return;
    pendingRef.current = null;
    if (!writableRef.current || !isCurrentUser(pending.userId)) return;
    const serialized = JSON.stringify(pending.layout);
    if (serialized === lastSavedRef.current) {
      setSaveState("saved");
      return;
    }
    lastSavedRef.current = serialized;
    inFlightRef.current = true;
    const input = { ...pending, resetEpoch: resetEpochRef.current, controller: new AbortController() };
    inFlightSaveRef.current = input;
    mutateRef.current(input);
  }, [isCurrentUser]);
  flushRef.current = flush;

  const retrySave = useCallback(() => {
    retryAttemptRef.current = 0;
    flush();
  }, [flush]);

  const flushOnPageHide = useCallback(() => {
    if (resetInFlightRef.current || queuedResetRef.current) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const superseded = inFlightSaveRef.current;
    const pending = pendingRef.current ?? superseded;
    if (!pending) return;
    pendingRef.current = null;
    if (!writableRef.current || !isCurrentUser(pending.userId)) return;
    const serialized = JSON.stringify(pending.layout);
    if (!superseded && serialized === lastSavedRef.current) return;
    superseded?.controller.abort();
    inFlightSaveRef.current = null;
    lastSavedRef.current = serialized;
    inFlightRef.current = true;
    setSaveState("saving");
    const attempt = { companyId: pending.companyId, userId: pending.userId, layout: pending.layout, resetEpoch: resetEpochRef.current };
    const keepalive = new Blob([serialized]).size <= UI_LAYOUT_KEEPALIVE_MAX_BYTES;
    const settle = (failed: boolean) => {
      inFlightRef.current = false;
      const queuedReset = queuedResetRef.current;
      queuedResetRef.current = null;
      if (queuedReset) startResetRef.current(queuedReset);
      else if (!failed && pendingRef.current && timerRef.current === null) flushRef.current();
    };
    void uiLayoutsApi.save(attempt.companyId, surface, attempt.layout, { keepalive }).then(
      (preference) => {
        handleSaved(preference, attempt);
        settle(false);
      },
      (error: unknown) => {
        handleSaveFailed(error, attempt);
        settle(true);
      },
    );
  }, [handleSaveFailed, handleSaved, isCurrentUser, surface]);

  const save = useCallback(
    (layout: TLayout) => {
      if (!companyId || !writableRef.current) return;
      pendingRef.current = { companyId, userId, layout };
      retryAttemptRef.current = 0;
      setSaveState("pending");
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, UI_LAYOUT_SAVE_DEBOUNCE_MS);
    },
    [companyId, userId, flush],
  );

  const stage = useCallback(
    (layout: TLayout) => {
      if (!companyId || !writableRef.current) return;
      pendingRef.current = { companyId, userId, layout };
    },
    [companyId, userId],
  );

  const resetMutation = useAccountBoundMutation({
    mutationFn: (targetCompanyId: string) => uiLayoutsApi.reset(targetCompanyId, surface),
    onSuccess: (preference: UiLayoutPreference, targetCompanyId) => {
      lastSavedRef.current = null;
      queryClient.setQueryData(queryKeys.uiLayouts.mine(targetCompanyId, surface, userIdRef.current), preference);
      setSaveError(null);
      setSaveState("idle");
    },
    onError: () => {
      setSaveError(null);
      setSaveState("error");
    },
    onFinished: () => {
      inFlightRef.current = false;
      resetInFlightRef.current = false;
      setResetting(false);
    },
    onSettled: () => {
      if (pendingRef.current && timerRef.current === null) flushRef.current();
    },
  });
  const resetRef = useRef(resetMutation.mutate);
  resetRef.current = resetMutation.mutate;
  startResetRef.current = (targetCompanyId: string) => {
    inFlightRef.current = true;
    resetInFlightRef.current = true;
    setResetting(true);
    resetRef.current(targetCompanyId);
  };

  const reset = useCallback(() => {
    if (!companyId || !writableRef.current) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    retryAttemptRef.current = 0;
    resetEpochRef.current += 1;
    if (resetInFlightRef.current) return;
    if (inFlightRef.current) {
      queuedResetRef.current = companyId;
      setResetting(true);
      return;
    }
    startResetRef.current(companyId);
  }, [companyId]);

  useEffect(() => {
    if (!writable || !replacementRef.current) return;
    replacementRef.current = false;
    flush();
  }, [writable, flush]);

  useEffect(() => {
    if (ownerRef.current === userId) return;
    ownerRef.current = userId;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    inFlightSaveRef.current?.controller.abort();
    inFlightSaveRef.current = null;
    inFlightRef.current = resetInFlightRef.current;
    pendingRef.current = null;
    replacementRef.current = false;
    queuedResetRef.current = null;
    lastSavedRef.current = null;
    retryAttemptRef.current = 0;
    resetEpochRef.current += 1;
    setOverwriteAllowedFor(null);
    setSaveError(null);
    setSaveState("idle");
  }, [userId]);

  useEffect(() => {
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      flush();
    };
  }, [flush, flushOnPageHide, companyId]);

  return {
    stored,
    isLoaded: !companyId || !enabled || query.data !== undefined || blocked === "load-error",
    blocked,
    loadError: blocked === "load-error" ? loadFailure : null,
    owner: userId,
    allowOverwrite,
    retryLoad,
    save,
    stage,
    flush,
    reset,
    resetting,
    saveState,
    saveError: saveState === "error" ? saveError : null,
    retrySave,
  };
}
