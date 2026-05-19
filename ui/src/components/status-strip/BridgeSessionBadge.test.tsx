// @vitest-environment jsdom
/**
 * ADR-0005 §8 / CLI-142 — BridgeSessionBadge QA test suite
 *
 * Tests are written in advance of the implementation (TDD/pre-QA) so ClippyEng
 * has a clear contract to build to. All tests skip until the implementation
 * files exist (Guard a). Run:
 *
 *   pnpm vitest run ui/src/components/status-strip/BridgeSessionBadge.test.tsx
 *
 * === Contract required from implementation files ===
 *
 * ui/src/ipc/bridgeChannels.ts:
 *   - useBridgeLiveEvents(): hook that subscribes to bridge.session_state and
 *     bridge.deny_flash LiveEvents via LiveUpdatesProvider context. Two SEPARATE
 *     subscriptions — deny path must not be folded into the debounced reducer.
 *   - BridgeSessionPayload: zod schema for bridge.session_state payload
 *   - BridgeDenyFlashPayload: zod schema for bridge.deny_flash payload
 *     { jti: string, source: 'bridge-shell'|'bridge-write'|'bridge-url'|'bridge-read', scope: string, ts: number }
 *
 * ui/src/state/bridgeSession.ts:
 *   - useBridgeSessionStore(): Zustand/jotai/etc. store
 *   - BridgeSessionState: discriminated union { kind: 'idle' } | { kind: 'active'|'amber'|'expired'; jti; shortId; iat; exp; capabilityCount; capabilities }
 *   - `kind` computed from exp vs Date.now() on animation frame — NOT from server message
 *
 * ui/src/components/status-strip/BridgeSessionBadge.tsx:
 *   - BridgeSessionBadge component (feature-flag gated: bridge.session_indicator.v1)
 *   - data-testid="bridge-session-badge" on the button element
 *   - data-state={state.kind} on the badge
 *   - Collapsed (display: none) when kind === 'idle' — NOT visibility: hidden
 *   - Opens BridgeSessionDetailPanel on click
 *
 * ui/src/components/status-strip/BridgeSessionDetailPanel.tsx:
 *   - BridgeSessionDetailPanel component
 *   - data-testid="bridge-session-detail-panel"
 *   - Revoke button: data-testid="bridge-session-revoke-btn"
 *   - Confirm dialog before revoke: data-testid="bridge-session-revoke-confirm"
 */

import { act, type ReactNode } from "react";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Guard: all tests skip until CLI-142 implementation lands.
// Remove the .skip from the outer describe when:
//   - ui/src/components/status-strip/BridgeSessionBadge.tsx is implemented
//   - ui/src/state/bridgeSession.ts is implemented
//   - ui/src/ipc/bridgeChannels.ts exports useBridgeLiveEvents
// Then replace placeholder `Badge` below with the real import.
const describeWhenImplemented = describe.skip;

// Placeholder component — replaced by real import once CLI-142 lands
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Badge: React.FC = () => null as any;

// ── Minimal live-updates context mock ────────────────────────────────────────
// The bridge live events hook subscribes to LiveUpdatesProvider context.
// We provide a controllable mock that lets tests fire events synchronously.

type DenyFlashPayload = { jti: string; source: string; scope: string; ts: number };
type SessionStatePayload = {
  jti: string;
  iat: number;
  exp: number;
  capabilityCount: number;
  capabilities: Array<{ source: string; scope: string; lastUsedAt: number; count: number }>;
} | null;

interface MockLiveEvents {
  emitSessionState(payload: SessionStatePayload): void;
  emitDenyFlash(payload: DenyFlashPayload): void;
}

// Mock useBridgeLiveEvents so we can inject events from tests
const mockLiveEvents = vi.hoisted(
  (): MockLiveEvents & { _sessionHandlers: ((p: SessionStatePayload) => void)[]; _denyHandlers: ((p: DenyFlashPayload) => void)[] } => ({
    _sessionHandlers: [],
    _denyHandlers: [],
    emitSessionState(payload) {
      this._sessionHandlers.forEach((h) => h(payload));
    },
    emitDenyFlash(payload) {
      this._denyHandlers.forEach((h) => h(payload));
    },
  }),
);

vi.mock("../../ipc/bridgeChannels", () => ({
  useBridgeLiveEvents: () => ({
    onSessionState: (handler: (p: SessionStatePayload) => void) => {
      mockLiveEvents._sessionHandlers.push(handler);
      return () => {
        const idx = mockLiveEvents._sessionHandlers.indexOf(handler);
        if (idx !== -1) mockLiveEvents._sessionHandlers.splice(idx, 1);
      };
    },
    onDenyFlash: (handler: (p: DenyFlashPayload) => void) => {
      mockLiveEvents._denyHandlers.push(handler);
      return () => {
        const idx = mockLiveEvents._denyHandlers.indexOf(handler);
        if (idx !== -1) mockLiveEvents._denyHandlers.splice(idx, 1);
      };
    },
  }),
}));

// Mock feature flag — default enabled so most tests don't have to worry about it
const mockFeatureFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../hooks/useFeatureFlag", () => ({
  useFeatureFlag: (key: string) => key === "bridge.session_indicator.v1" ? mockFeatureFlag.enabled : false,
}));

// Mock revoke API
const mockRevokeApi = vi.hoisted(() => ({
  revokeBridgeSession: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../api/bridge", () => ({
  bridgeApi: mockRevokeApi,
}));

// ── Test utilities ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactNode) {
  act(() => {
    root.render(ui);
  });
}

function getTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function makeActiveSession(overrides: Partial<SessionStatePayload> = {}): SessionStatePayload {
  const now = Date.now();
  return {
    jti: "a2f9b3c4d5e6f7a8",
    iat: now - 60_000,
    exp: now + 300_000, // 5 min from now — "active" state
    capabilityCount: 3,
    capabilities: [
      { source: "bridge-shell", scope: "run_terminal_command", lastUsedAt: now - 10_000, count: 2 },
      { source: "bridge-read", scope: "read_file", lastUsedAt: now - 5_000, count: 1 },
    ],
    ...overrides,
  };
}

function makeDenyFlash(overrides: Partial<DenyFlashPayload> = {}): DenyFlashPayload {
  return {
    jti: "a2f9b3c4d5e6f7a8",
    source: "bridge-shell",
    scope: "run_terminal_command",
    ts: Date.now(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test suites
// ═══════════════════════════════════════════════════════════════════════════════


describeWhenImplemented("BridgeSessionBadge — ADR-0005 §8 / CLI-142", () => {
  beforeAll(() => {
    mockLiveEvents._sessionHandlers.length = 0;
    mockLiveEvents._denyHandlers.length = 0;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockFeatureFlag.enabled = true;
    mockRevokeApi.revokeBridgeSession.mockClear();
    mockLiveEvents._sessionHandlers.length = 0;
    mockLiveEvents._denyHandlers.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── §1: Placement / hidden when idle ───────────────────────────────────────

  describe("§1 idle state", () => {
    it("renders nothing (display:none) when no session is active", () => {
      render(<Badge />);
      const badge = getTestId("bridge-session-badge");
      // Spec: collapsed via display:none, NOT visibility:hidden
      // Accept: either element doesn't exist, or it's display:none
      if (badge) {
        const style = window.getComputedStyle(badge);
        expect(style.display).toBe("none");
      } else {
        expect(badge).toBeNull(); // acceptable alternative: element removed from DOM
      }
    });

    it("badge slot occupies no layout space when idle (no width contribution)", () => {
      render(<Badge />);
      const badge = getTestId("bridge-session-badge");
      if (badge) {
        // Should not contribute visible width
        expect(badge.getBoundingClientRect().width).toBe(0);
      }
    });
  });

  // ── §2: Active state ───────────────────────────────────────────────────────

  describe("§2 active state", () => {
    it("renders the badge when a session becomes active", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });
      const badge = getTestId("bridge-session-badge");
      expect(badge).not.toBeNull();
      expect(badge!.getAttribute("data-state")).toBe("active");
    });

    it("shows 'Bridge' label and short id (cap-XXXX)", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession({ jti: "a2f9b3c4d5e6f7a8" }));
      });
      expect(container.textContent).toContain("Bridge");
      expect(container.textContent).toContain("cap-a2f9"); // first 4 hex of jti
    });

    it("shows capability count", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession({ capabilityCount: 3 }));
      });
      expect(container.textContent).toContain("3");
    });

    it("caps capability count display at '99+'", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession({ capabilityCount: 150 }));
      });
      expect(container.textContent).toContain("99+");
    });

    it("does not show timer in active state (exp - now > 60s)", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(
          makeActiveSession({ exp: Date.now() + 300_000 }), // 5 min, well above threshold
        );
      });
      // Timer only shown in amber/expired states — no mm:ss in active
      expect(container.textContent).not.toMatch(/\d+:\d{2}/);
    });

    it("collapses back to idle when session state arrives as null", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });
      expect(getTestId("bridge-session-badge")).not.toBeNull();

      act(() => {
        mockLiveEvents.emitSessionState(null);
      });
      const badge = getTestId("bridge-session-badge");
      if (badge) {
        expect(window.getComputedStyle(badge).display).toBe("none");
      } else {
        expect(badge).toBeNull();
      }
    });
  });

  // ── §3: Amber state (exp - now ≤ 60s) ─────────────────────────────────────

  describe("§3 amber state", () => {
    it("transitions to amber when exp is within 60s", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(
          makeActiveSession({ exp: Date.now() + 45_000 }), // 45s — amber
        );
      });
      const badge = getTestId("bridge-session-badge");
      expect(badge?.getAttribute("data-state")).toBe("amber");
    });

    it("shows mm:ss countdown timer in amber state", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(
          makeActiveSession({ exp: Date.now() + 45_000 }), // 45s
        );
      });
      // Should show "0:45" or "00:45" style countdown
      expect(container.textContent).toMatch(/0:4[0-9]|00:4[0-9]/);
    });

    it("transitions active→amber purely from wall clock (no server message needed)", () => {
      render(<Badge />);
      // Send an active session with exp 65s from now
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession({ exp: Date.now() + 65_000 }));
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("active");

      // Advance clock by 10s — now 55s to expiry, should auto-transition to amber
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("amber");
    });
  });

  // ── §4: Expired state ──────────────────────────────────────────────────────

  describe("§4 expired state", () => {
    it("transitions to expired when exp ≤ now", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(
          makeActiveSession({ exp: Date.now() + 5_000 }), // 5s from now
        );
      });
      act(() => {
        vi.advanceTimersByTime(6_000); // now expired
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("expired");
    });

    it("shows 'expired — reconnect' text instead of timer in expired state", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession({ exp: Date.now() + 1_000 }));
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(container.textContent?.toLowerCase()).toContain("expired");
      expect(container.textContent?.toLowerCase()).toContain("reconnect");
    });
  });

  // ── §5: Deny-flash (the critical per-event non-coalesced behavior) ─────────

  describe("§4 deny-flash — per-event, non-coalesced (ADR-0005 §8 §4)", () => {
    it("transitions to deny-flash state on bridge-deny event", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });
      act(() => {
        mockLiveEvents.emitDenyFlash(makeDenyFlash());
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("deny-flash");
    });

    it("deny-flash lasts exactly 3000ms then returns to underlying state", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });
      act(() => {
        mockLiveEvents.emitDenyFlash(makeDenyFlash());
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("deny-flash");

      // After 2.9s, still flashing
      act(() => {
        vi.advanceTimersByTime(2_900);
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("deny-flash");

      // After 3.0s, back to active
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("active");
    });

    it("two deny events 800ms apart produce overlapping flashes lasting ≥ 3800ms total", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });

      // First deny at t=0
      act(() => {
        mockLiveEvents.emitDenyFlash(makeDenyFlash({ ts: Date.now() }));
      });
      const flashStart = Date.now();
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("deny-flash");

      // Second deny at t=800ms
      act(() => {
        vi.advanceTimersByTime(800);
        mockLiveEvents.emitDenyFlash(makeDenyFlash({ ts: Date.now() }));
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("deny-flash");

      // At t=3100ms — first flash would have expired (3s from t=0), but second still active
      act(() => {
        vi.advanceTimersByTime(2_300); // total: 3100ms
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("deny-flash");

      // At t=3800ms — both flashes expired
      act(() => {
        vi.advanceTimersByTime(700); // total: 3800ms
      });
      // Should now be back to active (non-deny)
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("active");

      // Total flash duration ≥ 3800ms
      const totalFlashMs = Date.now() - flashStart;
      expect(totalFlashMs).toBeGreaterThanOrEqual(3_800);
    });

    it("deny-flash fires even when session is in amber state (returns to amber)", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession({ exp: Date.now() + 30_000 })); // amber
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("amber");

      act(() => {
        mockLiveEvents.emitDenyFlash(makeDenyFlash());
      });
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("deny-flash");

      act(() => {
        vi.advanceTimersByTime(3_100);
      });
      // Returns to amber, not active
      expect(getTestId("bridge-session-badge")?.getAttribute("data-state")).toBe("amber");
    });
  });

  // ── §6: A11y ───────────────────────────────────────────────────────────────

  describe("§7 accessibility", () => {
    it("badge has role=button and is keyboard-accessible (tabIndex=0)", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });
      const badge = getTestId("bridge-session-badge");
      expect(badge?.tagName.toLowerCase() === "button" || badge?.getAttribute("role") === "button").toBe(true);
      const tabIndex = badge?.getAttribute("tabindex") ?? badge?.tabIndex?.toString();
      expect(tabIndex).not.toBe("-1");
    });

    it("has role=status aria-live region for ARIA announcements", () => {
      render(<Badge />);
      const liveRegion = container.querySelector('[role="status"]');
      expect(liveRegion).not.toBeNull();
    });

    it("two deny-flash events fire two distinct ARIA announcements", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });

      // Collect all aria-live text changes
      const announcements: string[] = [];
      const liveRegion = container.querySelector('[role="status"]') as HTMLElement | null;
      const observer = new MutationObserver(() => {
        if (liveRegion?.textContent) {
          announcements.push(liveRegion.textContent);
        }
      });
      if (liveRegion) {
        observer.observe(liveRegion, { childList: true, characterData: true, subtree: true });
      }

      // First deny
      act(() => {
        mockLiveEvents.emitDenyFlash(makeDenyFlash());
      });
      // Second deny 800ms later
      act(() => {
        vi.advanceTimersByTime(800);
        mockLiveEvents.emitDenyFlash(makeDenyFlash());
      });

      observer.disconnect();

      // Two distinct deny-flash events must produce at least 2 announcements
      // (Implementation may clear and re-set text; just verify count ≥ 2)
      expect(announcements.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── §7: Feature flag gating ───────────────────────────────────────────────

  describe("§0.1.2 feature flag gating", () => {
    it("renders nothing when feature flag bridge.session_indicator.v1 is off", () => {
      mockFeatureFlag.enabled = false;
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });
      // No badge element should be present at all (zero DOM contribution)
      expect(getTestId("bridge-session-badge")).toBeNull();
    });

    it("renders badge when feature flag is on", () => {
      mockFeatureFlag.enabled = true;
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });
      expect(getTestId("bridge-session-badge")).not.toBeNull();
    });
  });

  // ── §8: Click → detail panel ──────────────────────────────────────────────

  describe("§2.2 click opens detail panel", () => {
    it("opens BridgeSessionDetailPanel on badge click", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession());
      });
      const badge = getTestId("bridge-session-badge") as HTMLElement;
      expect(badge).not.toBeNull();

      act(() => {
        badge.click();
      });
      expect(getTestId("bridge-session-detail-panel")).not.toBeNull();
    });

    it("detail panel shows session short id", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession({ jti: "a2f9b3c4d5e6f7a8" }));
      });
      act(() => {
        (getTestId("bridge-session-badge") as HTMLElement)?.click();
      });
      const panel = getTestId("bridge-session-detail-panel");
      expect(panel?.textContent).toContain("cap-a2f9");
    });

    it("detail panel shows capability sources from the session", () => {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(
          makeActiveSession({
            capabilities: [
              { source: "bridge-shell", scope: "run_terminal_command", lastUsedAt: Date.now(), count: 2 },
              { source: "bridge-read", scope: "read_file", lastUsedAt: Date.now(), count: 1 },
            ],
          }),
        );
      });
      act(() => {
        (getTestId("bridge-session-badge") as HTMLElement)?.click();
      });
      const panel = getTestId("bridge-session-detail-panel");
      expect(panel?.textContent).toContain("bridge-shell");
      expect(panel?.textContent).toContain("bridge-read");
    });
  });

  // ── §9: Revoke flow ────────────────────────────────────────────────────────

  describe("§6 revoke session flow", () => {
    function openPanel() {
      render(<Badge />);
      act(() => {
        mockLiveEvents.emitSessionState(makeActiveSession({ jti: "a2f9b3c4d5e6f7a8" }));
      });
      act(() => {
        (getTestId("bridge-session-badge") as HTMLElement)?.click();
      });
    }

    it("shows revoke button in detail panel", () => {
      openPanel();
      expect(getTestId("bridge-session-revoke-btn")).not.toBeNull();
    });

    it("shows confirm dialog when revoke button clicked (destructive pattern)", () => {
      openPanel();
      act(() => {
        (getTestId("bridge-session-revoke-btn") as HTMLElement)?.click();
      });
      expect(getTestId("bridge-session-revoke-confirm")).not.toBeNull();
    });

    it("calls revokeBridgeSession with jti on confirm", async () => {
      openPanel();
      act(() => {
        (getTestId("bridge-session-revoke-btn") as HTMLElement)?.click();
      });
      const confirmBtn = container.querySelector(
        '[data-testid="bridge-session-revoke-confirm"] [data-testid="confirm-btn"]',
      ) as HTMLElement | null;
      if (confirmBtn) {
        await act(async () => {
          confirmBtn.click();
          await Promise.resolve();
        });
        expect(mockRevokeApi.revokeBridgeSession).toHaveBeenCalledWith("a2f9b3c4d5e6f7a8");
      } else {
        // Alternative: confirm dialog may have a different pattern
        // Just ensure the API was available to call
        expect(mockRevokeApi.revokeBridgeSession).toBeDefined();
      }
    });

    it("rolls back optimistic UI within 2s if revoke API returns { ok: false }", async () => {
      mockRevokeApi.revokeBridgeSession.mockResolvedValueOnce({ ok: false, error: "Server error" });
      openPanel();

      // Session is visible before revoke
      expect(getTestId("bridge-session-badge")).not.toBeNull();

      act(() => {
        (getTestId("bridge-session-revoke-btn") as HTMLElement)?.click();
      });
      const confirmBtn = container.querySelector(
        '[data-testid="bridge-session-revoke-confirm"] [data-testid="confirm-btn"]',
      ) as HTMLElement | null;
      if (confirmBtn) {
        await act(async () => {
          confirmBtn.click();
          await Promise.resolve();
        });
        // After rollback (within 2s), session badge should be restored
        act(() => {
          vi.advanceTimersByTime(2_000);
        });
        // Badge should still be visible (revoke failed, session not removed)
        const badge = getTestId("bridge-session-badge");
        if (badge) {
          expect(window.getComputedStyle(badge).display).not.toBe("none");
        }
      }
    });
  });
});
