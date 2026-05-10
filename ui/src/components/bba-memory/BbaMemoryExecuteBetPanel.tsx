/**
 * BbaMemoryExecuteBetPanel — HIGH-RISK write path.
 *
 * Safety design:
 *   1. Button disabled until valid props received.
 *   2. Two-step confirmation: modal + typed "CONFIRM" string.
 *   3. Request in-flight: button disabled, spinner shown.
 *   4. Idempotency guard: blocks re-submit within 60s per companyId.
 *   5. Result shown inline until user dismisses.
 *   6. Escape key closes modal; Tab/Shift+Tab are focus-trapped inside.
 *   7. Auto-polls recent-runs every 5s when result is "partial" (max 60s).
 */
// TODO(tests): Add unit tests in ui/src/components/bba-memory/__tests__/ when
// @testing-library/react is in ui/package.json devDependencies.
// Target: 9 tests (8 unit + 1 snapshot) — see docs/codex-prompts/component-2-execute-button.md PHASE 3.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  executeBbaBet,
  type ExecuteBetRequest,
  type ExecuteBetResponse,
} from "../../api/bbaMemory";
import { cn } from "../../lib/utils";

// ── Types ───────────────────────────────────────────────────────────────────

interface BetSummary {
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  currency?: string;
  bookmaker: string;
}

export interface BbaMemoryExecuteBetPanelProps {
  companyId: string;
  /** Pre-filled from bookmaker config selector (parent responsibility). */
  payload: ExecuteBetRequest | null;
  /** Human-readable bet summary for modal display. Derived from payload by parent. */
  betSummary: BetSummary | null;
  /** Called after a successful execute with the response. */
  onSuccess?: (response: ExecuteBetResponse) => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const IDEMPOTENCY_WINDOW_MS = 60_000;
const CONFIRM_KEYWORD = "CONFIRM";
const PARTIAL_POLL_INTERVAL_MS = 5_000;
const PARTIAL_POLL_MAX_MS = 60_000;

// ── Component ────────────────────────────────────────────────────────────────

export function BbaMemoryExecuteBetPanel({
  companyId,
  payload,
  betSummary,
  onSuccess,
}: BbaMemoryExecuteBetPanelProps) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [result, setResult] = useState<ExecuteBetResponse | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  // Keyed by companyId so switching companies resets the window correctly.
  const lastSubmitAt = useRef<Map<string, number>>(new Map());
  const modalRef = useRef<HTMLDivElement>(null);

  const lastCompanySubmit = lastSubmitAt.current.get(companyId) ?? null;
  const isWithinIdempotencyWindow =
    lastCompanySubmit !== null && Date.now() - lastCompanySubmit < IDEMPOTENCY_WINDOW_MS;

  const { mutate, isPending } = useMutation({
    mutationFn: ({ req, iKey }: { req: ExecuteBetRequest; iKey: string }) =>
      executeBbaBet(companyId, req, iKey),
    onSuccess: (res) => {
      setResult(res);
      setResultError(null);
      queryClient.invalidateQueries({ queryKey: ["bba-memory", "recent-runs", companyId] });
      onSuccess?.(res);
    },
    onError: (err) => {
      setResultError(err instanceof Error ? err.message : String(err));
      setResult(null);
    },
  });

  // F-1: poll recent-runs every 5s while result is "partial", stop after 60s.
  useEffect(() => {
    if (result?.status !== "partial") return;
    const start = Date.now();
    const interval = setInterval(() => {
      if (Date.now() - start >= PARTIAL_POLL_MAX_MS) {
        clearInterval(interval);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["bba-memory", "recent-runs", companyId] });
    }, PARTIAL_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [result?.status, companyId, queryClient]);

  // F-2: Escape key closes the modal.
  useEffect(() => {
    if (!modalOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [modalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // F-3: Focus trap — Tab/Shift+Tab cycle only within the three modal focusables.
  useEffect(() => {
    if (!modalOpen) return;
    const modal = modalRef.current;
    if (!modal) return;
    const SELECTORS = [
      '[data-testid="confirm-input"]',
      '[data-testid="cancel-button"]',
      '[data-testid="confirm-submit-button"]',
    ];
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const focusables = SELECTORS.map((s) => modal.querySelector<HTMLElement>(s)).filter(
        Boolean,
      ) as HTMLElement[];
      const idx = focusables.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? focusables[(idx - 1 + focusables.length) % focusables.length]
        : focusables[(idx + 1) % focusables.length];
      next?.focus();
    };
    modal.addEventListener("keydown", handler);
    return () => modal.removeEventListener("keydown", handler);
  }, [modalOpen]);

  const openModal = useCallback(() => {
    if (isWithinIdempotencyWindow) return;
    setConfirmText("");
    setResult(null);
    setResultError(null);
    setModalOpen(true);
  }, [isWithinIdempotencyWindow]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setConfirmText("");
  }, []);

  const handleConfirm = useCallback(() => {
    if (!payload || confirmText !== CONFIRM_KEYWORD || isPending) return;
    // F-4: generate UUID per submit, scoped to companyId.
    const iKey = crypto.randomUUID();
    lastSubmitAt.current.set(companyId, Date.now());
    setModalOpen(false);
    mutate({ req: payload, iKey });
  }, [payload, confirmText, isPending, companyId, mutate]);

  const isPlaceDisabled = !payload || !betSummary || isPending || isWithinIdempotencyWindow;

  return (
    <div data-testid="bba-execute-panel">
      {/* ── Idempotency warning ─────────────────────────── */}
      {isWithinIdempotencyWindow && (
        <div data-testid="idempotency-warning" className="text-amber-700 mb-2 text-xs">
          ⚠ A bet was submitted less than 60s ago. Wait before placing another to avoid duplicates.
        </div>
      )}

      {/* ── Place Bet button ─────────────────────────────── */}
      <button
        data-testid="place-bet-button"
        disabled={isPlaceDisabled}
        onClick={openModal}
        className={cn(
          "px-5 py-2 border-0 rounded font-semibold text-white",
          isPlaceDisabled ? "bg-gray-400 cursor-not-allowed" : "bg-red-600 cursor-pointer",
        )}
      >
        {isPending ? "Placing bet…" : "Place Bet"}
      </button>

      {/* ── In-flight spinner ───────────────────────────── */}
      {isPending && (
        <span data-testid="placing-spinner" className="ml-2 text-gray-500">
          ⏳ Placing bet…
        </span>
      )}

      {/* ── Result panel ────────────────────────────────── */}
      {result && (
        <div
          data-testid="result-panel"
          data-outcome={result.status}
          className={cn(
            "mt-3 px-3 py-2 rounded-md",
            result.status === "success" && "bg-green-100 text-green-800",
            result.status === "partial" && "bg-yellow-100 text-yellow-800",
            result.status !== "success" && result.status !== "partial" && "bg-red-100 text-red-800",
          )}
        >
          {result.status === "success" && (
            <>
              <span>✅ Bet placed successfully.</span>
              {result.placedBetId && (
                <span className="ml-2 text-xs">ID: {result.placedBetId}</span>
              )}
            </>
          )}
          {result.status === "partial" && (
            <span>⚠ Bet partially completed. Verify in bookmaker history.</span>
          )}
          {result.status !== "success" && result.status !== "partial" && (
            <>
              <span>❌ Bet failed.</span>
              {result.failureReason && (
                <span className="ml-2 text-xs">Reason: {result.failureReason}</span>
              )}
            </>
          )}
        </div>
      )}

      {resultError && (
        <div data-testid="error-panel" className="mt-3 text-red-800 text-xs">
          ❌ Error: {resultError}
        </div>
      )}

      {/* ── Confirmation modal ──────────────────────────── */}
      {modalOpen && betSummary && (
        <div
          data-testid="confirm-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-modal-title"
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]"
        >
          <div
            ref={modalRef}
            className="bg-white rounded-lg p-6 max-w-[480px] w-full shadow-2xl"
          >
            <h2 id="confirm-modal-title" className="mt-0 text-gray-900">
              ⚠ Confirm Real Bet Placement
            </h2>

            <p className="leading-relaxed text-gray-700">
              Confirm: place{" "}
              <strong>
                {betSummary.currency ?? "RON"} {betSummary.stake}
              </strong>{" "}
              on <strong>{betSummary.matchLabel}</strong> at{" "}
              <strong>{betSummary.bookmaker}</strong> (odds{" "}
              <strong>{betSummary.odds}</strong>). This will trigger a{" "}
              <strong>REAL bet placement</strong> against the live bookmaker.
            </p>

            <p className="text-gray-500 text-xs">
              Market: {betSummary.market} · Selection: {betSummary.selection}
            </p>

            <p className="font-semibold text-gray-700">
              Type <code>CONFIRM</code> below to proceed:
            </p>

            <input
              data-testid="confirm-input"
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type CONFIRM"
              autoFocus
              className="w-full px-2.5 py-2 text-base border border-gray-300 rounded mb-4 box-border"
            />

            <div className="flex gap-2 justify-end">
              <button
                data-testid="cancel-button"
                onClick={closeModal}
                className="px-4 py-2 border border-gray-300 rounded cursor-pointer bg-white"
              >
                Cancel
              </button>
              <button
                data-testid="confirm-submit-button"
                disabled={confirmText !== CONFIRM_KEYWORD}
                onClick={handleConfirm}
                className={cn(
                  "px-4 py-2 border-0 rounded font-semibold text-white",
                  confirmText === CONFIRM_KEYWORD
                    ? "bg-red-600 cursor-pointer"
                    : "bg-gray-400 cursor-not-allowed",
                )}
              >
                Place Real Bet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
