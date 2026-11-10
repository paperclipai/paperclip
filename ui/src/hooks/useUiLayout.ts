import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UiLayoutPreference, UiLayoutSurface } from "@paperclipai/shared";
import { uiLayoutsApi } from "../api/uiLayouts";
import { queryKeys } from "../lib/queryKeys";
import { useAccountBoundMutation } from "./useAccountBoundMutation";

export const UI_LAYOUT_SAVE_DEBOUNCE_MS = 1_500;
export const UI_LAYOUT_KEEPALIVE_MAX_BYTES = 60_000;

export type UiLayoutSaveState = "idle" | "pending" | "saving" | "saved" | "error";

export type UiLayoutBlock = "load-error" | "unreadable" | null;

type UseUiLayoutParams<TLayout> = {
  companyId: string | null | undefined;
  surface: UiLayoutSurface;
  resolve: (raw: unknown) => TLayout | null;
  enabled?: boolean;
};

export function useUiLayout<TLayout>({ companyId, surface, resolve, enabled = true }: UseUiLayoutParams<TLayout>) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => queryKeys.uiLayouts.mine(companyId ?? "__none__", surface), [companyId, surface]);
  const [saveState, setSaveState] = useState<UiLayoutSaveState>("idle");
  const pendingRef = useRef<{ companyId: string; layout: TLayout } | null>(null);
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
    enabled: Boolean(companyId) && enabled,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  const stored = useMemo(
    () => (query.data?.layout == null ? null : resolve(query.data.layout)),
    [query.data?.layout, resolve],
  );
  const [overwriteAllowedFor, setOverwriteAllowedFor] = useState<unknown>(null);
  const hasUnreadableLayout = query.data !== undefined && query.data.layout != null && stored === null;
  const blocked: UiLayoutBlock = query.data === undefined && query.error
    ? "load-error"
    : hasUnreadableLayout && overwriteAllowedFor !== query.data?.layout
      ? "unreadable"
      : null;
  const writable = Boolean(companyId) && enabled && query.data !== undefined && blocked === null;
  const writableRef = useRef(writable);
  writableRef.current = writable;
  const unreadableLayout = hasUnreadableLayout ? query.data?.layout : null;
  const allowOverwrite = useCallback(() => setOverwriteAllowedFor(unreadableLayout), [unreadableLayout]);
  const { refetch } = query;
  const retryLoad = useCallback(() => void refetch(), [refetch]);

  const saveMutation = useAccountBoundMutation({
    mutationFn: (input: { companyId: string; layout: TLayout; resetEpoch: number }) =>
      uiLayoutsApi.save(input.companyId, surface, input.layout),
    onMutate: () => setSaveState("saving"),
    onSuccess: (preference: UiLayoutPreference, input) => {
      if (input.resetEpoch !== resetEpochRef.current) return;
      queryClient.setQueryData(queryKeys.uiLayouts.mine(input.companyId, surface), preference);
      setSaveState(pendingRef.current ? "pending" : "saved");
    },
    onError: (_error, input) => {
      lastSavedRef.current = null;
      if (input.resetEpoch === resetEpochRef.current) setSaveState("error");
    },
    onFinished: () => {
      inFlightRef.current = false;
      resetAfterSettleRef.current = queuedResetRef.current;
      queuedResetRef.current = null;
      if (resetAfterSettleRef.current) setResetting(false);
    },
    onSettled: () => {
      const queuedReset = resetAfterSettleRef.current;
      resetAfterSettleRef.current = null;
      if (queuedReset) {
        startResetRef.current(queuedReset);
        return;
      }
      if (pendingRef.current && timerRef.current === null) flushRef.current();
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
    if (!writableRef.current) return;
    const serialized = JSON.stringify(pending.layout);
    if (serialized === lastSavedRef.current) {
      setSaveState("saved");
      return;
    }
    lastSavedRef.current = serialized;
    inFlightRef.current = true;
    mutateRef.current({ ...pending, resetEpoch: resetEpochRef.current });
  }, []);
  flushRef.current = flush;

  const flushOnPageHide = useCallback(() => {
    if (!inFlightRef.current) {
      flush();
      return;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending || queuedResetRef.current) return;
    pendingRef.current = null;
    if (!writableRef.current) return;
    const serialized = JSON.stringify(pending.layout);
    if (serialized === lastSavedRef.current) return;
    lastSavedRef.current = serialized;
    const keepalive = new Blob([serialized]).size <= UI_LAYOUT_KEEPALIVE_MAX_BYTES;
    void uiLayoutsApi.save(pending.companyId, surface, pending.layout, { keepalive }).catch(() => {
      lastSavedRef.current = null;
    });
  }, [flush, surface]);

  const save = useCallback(
    (layout: TLayout) => {
      if (!companyId || !writableRef.current) return;
      pendingRef.current = { companyId, layout };
      setSaveState("pending");
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, UI_LAYOUT_SAVE_DEBOUNCE_MS);
    },
    [companyId, flush],
  );

  const stage = useCallback(
    (layout: TLayout) => {
      if (!companyId || !writableRef.current) return;
      pendingRef.current = { companyId, layout };
    },
    [companyId],
  );

  const resetMutation = useAccountBoundMutation({
    mutationFn: (targetCompanyId: string) => uiLayoutsApi.reset(targetCompanyId, surface),
    onSuccess: (preference: UiLayoutPreference, targetCompanyId) => {
      lastSavedRef.current = null;
      queryClient.setQueryData(queryKeys.uiLayouts.mine(targetCompanyId, surface), preference);
      setSaveState("idle");
    },
    onError: () => setSaveState("error"),
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
    loadError: blocked === "load-error" ? query.error : null,
    allowOverwrite,
    retryLoad,
    save,
    stage,
    flush,
    reset,
    resetting,
    saveState,
  };
}
