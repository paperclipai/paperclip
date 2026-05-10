/**
 * BbaMemoryExecuteBetPanel — HIGH-RISK write path.
 *
 * Safety design:
 *   1. Button disabled until valid props received.
 *   2. Two-step confirmation: modal + typed "CONFIRM" string.
 *   3. Request in-flight: button disabled, spinner shown.
 *   4. Idempotency guard: blocks re-submit within 60s of last attempt.
 *   5. Result shown inline until user dismisses.
 */
// TODO(tests): Add unit tests in ui/src/components/bba-memory/__tests__/ when
// @testing-library/react is in ui/package.json devDependencies.
// Target: 9 tests (8 unit + 1 snapshot) — see docs/codex-prompts/component-2-execute-button.md PHASE 3.
import React, { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  executeBbaBet,
  type ExecuteBetRequest,
  type ExecuteBetResponse,
} from "../../api/bbaMemory";

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
  const lastSubmitAt = useRef<number | null>(null);

  const isWithinIdempotencyWindow =
    lastSubmitAt.current !== null &&
    Date.now() - lastSubmitAt.current < IDEMPOTENCY_WINDOW_MS;

  const { mutate, isPending } = useMutation({
    mutationFn: (req: ExecuteBetRequest) => executeBbaBet(companyId, req),
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
    lastSubmitAt.current = Date.now();
    setModalOpen(false);
    mutate(payload);
  }, [payload, confirmText, isPending, mutate]);

  const isPlaceDisabled = !payload || !betSummary || isPending || isWithinIdempotencyWindow;

  return (
    <div data-testid="bba-execute-panel">
      {/* ── Idempotency warning ─────────────────────────── */}
      {isWithinIdempotencyWindow && (
        <div
          data-testid="idempotency-warning"
          style={{ color: "#b45309", marginBottom: 8, fontSize: 13 }}
        >
          ⚠ A bet was submitted less than 60s ago. Wait before placing another to avoid duplicates.
        </div>
      )}

      {/* ── Place Bet button ─────────────────────────────── */}
      <button
        data-testid="place-bet-button"
        disabled={isPlaceDisabled}
        onClick={openModal}
        style={{
          backgroundColor: isPlaceDisabled ? "#9ca3af" : "#dc2626",
          color: "white",
          padding: "8px 20px",
          border: "none",
          borderRadius: 4,
          cursor: isPlaceDisabled ? "not-allowed" : "pointer",
          fontWeight: 600,
        }}
      >
        {isPending ? "Placing bet…" : "Place Bet"}
      </button>

      {/* ── In-flight spinner ───────────────────────────── */}
      {isPending && (
        <span data-testid="placing-spinner" style={{ marginLeft: 10, color: "#6b7280" }}>
          ⏳ Placing bet…
        </span>
      )}

      {/* ── Result panel ────────────────────────────────── */}
      {result && (
        <div
          data-testid="result-panel"
          data-outcome={result.status}
          style={{
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: 6,
            backgroundColor:
              result.status === "success"
                ? "#dcfce7"
                : result.status === "partial"
                  ? "#fef9c3"
                  : "#fee2e2",
            color:
              result.status === "success"
                ? "#166534"
                : result.status === "partial"
                  ? "#854d0e"
                  : "#991b1b",
          }}
        >
          {result.status === "success" && (
            <>
              <span>✅ Bet placed successfully.</span>
              {result.placedBetId && (
                <span style={{ marginLeft: 8, fontSize: 12 }}>
                  ID: {result.placedBetId}
                </span>
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
                <span style={{ marginLeft: 8, fontSize: 12 }}>
                  Reason: {result.failureReason}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {resultError && (
        <div
          data-testid="error-panel"
          style={{ marginTop: 12, color: "#991b1b", fontSize: 13 }}
        >
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
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              backgroundColor: "white",
              borderRadius: 8,
              padding: 24,
              maxWidth: 480,
              width: "100%",
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
          >
            <h2 id="confirm-modal-title" style={{ marginTop: 0, color: "#111827" }}>
              ⚠ Confirm Real Bet Placement
            </h2>

            <p style={{ lineHeight: 1.6, color: "#374151" }}>
              Confirm: place{" "}
              <strong>
                {betSummary.currency ?? "RON"} {betSummary.stake}
              </strong>{" "}
              on <strong>{betSummary.matchLabel}</strong> at{" "}
              <strong>{betSummary.bookmaker}</strong> (odds{" "}
              <strong>{betSummary.odds}</strong>). This will trigger a{" "}
              <strong>REAL bet placement</strong> against the live bookmaker.
            </p>

            <p style={{ color: "#6b7280", fontSize: 13 }}>
              Market: {betSummary.market} · Selection: {betSummary.selection}
            </p>

            <p style={{ fontWeight: 600, color: "#374151" }}>
              Type <code>CONFIRM</code> below to proceed:
            </p>

            <input
              data-testid="confirm-input"
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type CONFIRM"
              autoFocus
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 15,
                border: "1px solid #d1d5db",
                borderRadius: 4,
                boxSizing: "border-box",
                marginBottom: 16,
              }}
            />

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                data-testid="cancel-button"
                onClick={closeModal}
                style={{
                  padding: "8px 18px",
                  border: "1px solid #d1d5db",
                  borderRadius: 4,
                  cursor: "pointer",
                  backgroundColor: "white",
                }}
              >
                Cancel
              </button>
              <button
                data-testid="confirm-submit-button"
                disabled={confirmText !== CONFIRM_KEYWORD}
                onClick={handleConfirm}
                style={{
                  padding: "8px 18px",
                  backgroundColor:
                    confirmText === CONFIRM_KEYWORD ? "#dc2626" : "#9ca3af",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor: confirmText === CONFIRM_KEYWORD ? "pointer" : "not-allowed",
                  fontWeight: 600,
                }}
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
