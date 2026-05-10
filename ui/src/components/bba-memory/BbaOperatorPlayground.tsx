/**
 * BbaOperatorPlayground — operator-facing surface that combines:
 *   • Component 1: BbaMemoryRecentRunsPanel (read-only run history)
 *   • Component 2: BbaMemoryExecuteBetPanel (write — triggers real bet)
 *
 * Built-in bookmaker + bet presets remove the need for a config-selector UI
 * for fast demo / manual operator flow. Self-contained — user integrates
 * into BettingOpsDashboard.tsx (or any other host) at their discretion.
 *
 * SAFETY:
 *   Presets contain placeholder selectors and secret references. Operator
 *   must verify the bookmakerConfig matches the live bookmaker DOM before
 *   placing real bets. Component 2's two-step "CONFIRM" modal still
 *   gates every execute() call.
 */

// TODO(tests): Add unit tests in __tests__/ when @testing-library/react
// is in ui/package.json devDependencies.
// Target: 6 tests (preset switching, payload assembly, child wiring,
// summary card rendering, default-selection edge cases, snapshot).

import { useMemo, useState } from "react";
import BbaMemoryRecentRunsPanel from "./BbaMemoryRecentRunsPanel";
import { BbaMemoryExecuteBetPanel } from "./BbaMemoryExecuteBetPanel";
import type { ExecuteBetRequest } from "../../api/bbaMemory";

// ── Preset shapes ───────────────────────────────────────────────────────────

interface BookmakerPreset {
  id: string;
  label: string;
  bookmaker: string;
  baseUrl: string;
  loginUrl: string;
  postLoginUrl?: string;
  historyUrl?: string;
  selectors: {
    username: { selectors: string[] };
    password: { selectors: string[] };
    loginSubmit: { selectors: string[] };
    selectionButton: { selectors: string[] };
    stakeInput: { selectors: string[] };
    reviewButton: { selectors: string[] };
    submitButton?: { selectors: string[] };
    receiptSuccess?: { selectors: string[] };
  };
}

interface BetPreset {
  id: string;
  label: string;
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  eventUrl?: string;
}

// ── Presets (placeholders — operator verifies before live use) ──────────────

const BOOKMAKER_PRESETS: BookmakerPreset[] = [
  {
    id: "casa-pariurilor",
    label: "Casa Pariurilor (RO)",
    bookmaker: "Casa Pariurilor",
    baseUrl: "https://www.casapariurilor.ro",
    loginUrl: "https://www.casapariurilor.ro/login",
    historyUrl: "https://www.casapariurilor.ro/account/history",
    selectors: {
      username: { selectors: ["input[name='username']", "#username"] },
      password: { selectors: ["input[name='password']", "#password"] },
      loginSubmit: { selectors: ["button[type='submit']", "#login-submit"] },
      selectionButton: { selectors: ["button[data-selection='{{selection}}']"] },
      stakeInput: { selectors: ["input[name='stake']"] },
      reviewButton: { selectors: ["button.review"] },
      submitButton: { selectors: ["button.submit-bet"] },
      receiptSuccess: { selectors: [".receipt-success"] },
    },
  },
  {
    id: "betano",
    label: "Betano (RO)",
    bookmaker: "Betano",
    baseUrl: "https://www.betano.ro",
    loginUrl: "https://www.betano.ro/login",
    selectors: {
      username: { selectors: ["#email", "input[name='email']"] },
      password: { selectors: ["#password"] },
      loginSubmit: { selectors: ["button[type='submit']"] },
      selectionButton: { selectors: ["button.selection-{{selection}}"] },
      stakeInput: { selectors: ["input.stake"] },
      reviewButton: { selectors: ["button.bet-review"] },
    },
  },
  {
    id: "test-mock",
    label: "Test mock (won't actually place)",
    bookmaker: "TestMock",
    baseUrl: "https://example.test",
    loginUrl: "https://example.test/login",
    selectors: {
      username: { selectors: ["#user"] },
      password: { selectors: ["#pass"] },
      loginSubmit: { selectors: ["#submit"] },
      selectionButton: { selectors: [".selection"] },
      stakeInput: { selectors: ["#stake"] },
      reviewButton: { selectors: ["#review"] },
    },
  },
];

const BET_PRESETS: BetPreset[] = [
  {
    id: "small-1x2",
    label: "Small 1X2 — RON 10",
    matchLabel: "Team A vs Team B",
    market: "1X2",
    selection: "1",
    odds: 1.85,
    stake: 10,
  },
  {
    id: "medium-totals",
    label: "Medium Over/Under — RON 25",
    matchLabel: "Team C vs Team D",
    market: "Total Goals",
    selection: "Over 2.5",
    odds: 2.1,
    stake: 25,
  },
  {
    id: "smoke-tiny",
    label: "Smoke test — RON 1",
    matchLabel: "Smoke vs Test",
    market: "1X2",
    selection: "X",
    odds: 3.5,
    stake: 1,
  },
];

// ── Component ───────────────────────────────────────────────────────────────

export interface BbaOperatorPlaygroundProps {
  companyId: string;
  className?: string;
}

export function BbaOperatorPlayground({
  companyId,
  className,
}: BbaOperatorPlaygroundProps) {
  const [bookmakerId, setBookmakerId] = useState<string>(BOOKMAKER_PRESETS[0].id);
  const [betId, setBetId] = useState<string>(BET_PRESETS[0].id);

  const preset = useMemo(
    () =>
      BOOKMAKER_PRESETS.find((p) => p.id === bookmakerId) ?? BOOKMAKER_PRESETS[0],
    [bookmakerId],
  );
  const betPreset = useMemo(
    () => BET_PRESETS.find((b) => b.id === betId) ?? BET_PRESETS[0],
    [betId],
  );

  const payload: ExecuteBetRequest = useMemo(
    () => ({
      loginUsername: { secretName: "BBA_USERNAME" },
      loginPassword: { secretName: "BBA_PASSWORD" },
      bookmakerConfig: {
        bookmaker: preset.bookmaker,
        baseUrl: preset.baseUrl,
        loginUrl: preset.loginUrl,
        ...(preset.postLoginUrl ? { postLoginUrl: preset.postLoginUrl } : {}),
        ...(preset.historyUrl ? { historyUrl: preset.historyUrl } : {}),
        username: preset.selectors.username,
        password: preset.selectors.password,
        loginSubmit: preset.selectors.loginSubmit,
        selectionButton: preset.selectors.selectionButton,
        stakeInput: preset.selectors.stakeInput,
        reviewButton: preset.selectors.reviewButton,
        ...(preset.selectors.submitButton
          ? { submitButton: preset.selectors.submitButton }
          : {}),
        ...(preset.selectors.receiptSuccess
          ? { receiptSuccess: preset.selectors.receiptSuccess }
          : {}),
      },
      bet: {
        matchLabel: betPreset.matchLabel,
        market: betPreset.market,
        selection: betPreset.selection,
        odds: betPreset.odds,
        stake: betPreset.stake,
        ...(betPreset.eventUrl ? { eventUrl: betPreset.eventUrl } : {}),
      },
      riskControls: {
        maxStakePerBet: 100,
        maxTotalStakePerSession: 200,
        requireFinalConfirmation: true,
      },
    }),
    [preset, betPreset],
  );

  const betSummary = useMemo(
    () => ({
      matchLabel: betPreset.matchLabel,
      market: betPreset.market,
      selection: betPreset.selection,
      odds: betPreset.odds,
      stake: betPreset.stake,
      bookmaker: preset.bookmaker,
    }),
    [betPreset, preset],
  );

  return (
    <div className={className} data-testid="bba-operator-playground">
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>
        BBA Operator Playground
      </h1>
      <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>
        Demo and operator surface combining recent-runs visibility with
        execute-bet capability. Pick a bookmaker preset and a bet preset,
        then click Place Bet.
      </p>

      <div style={{ display: "flex", gap: 24, marginBottom: 20 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>Bookmaker preset</span>
          <select
            data-testid="bookmaker-preset-select"
            value={bookmakerId}
            onChange={(e) => setBookmakerId(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid #d1d5db" }}
          >
            {BOOKMAKER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>Bet preset</span>
          <select
            data-testid="bet-preset-select"
            value={betId}
            onChange={(e) => setBetId(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid #d1d5db" }}
          >
            {BET_PRESETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        data-testid="bet-summary-card"
        style={{
          padding: 14,
          borderRadius: 6,
          border: "1px solid #e5e7eb",
          backgroundColor: "#f9fafb",
          marginBottom: 16,
          fontSize: 14,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Selected bet</div>
        <div>
          <strong>{betSummary.matchLabel}</strong> · {betSummary.market} ·{" "}
          <strong>{betSummary.selection}</strong> @ {betSummary.odds} for{" "}
          <strong>RON {betSummary.stake}</strong> on{" "}
          <strong>{betSummary.bookmaker}</strong>
        </div>
      </div>

      <BbaMemoryExecuteBetPanel
        companyId={companyId}
        payload={payload}
        betSummary={betSummary}
      />

      <hr
        style={{ margin: "32px 0", border: "none", borderTop: "1px solid #e5e7eb" }}
      />

      <BbaMemoryRecentRunsPanel companyId={companyId} />
    </div>
  );
}

export default BbaOperatorPlayground;
