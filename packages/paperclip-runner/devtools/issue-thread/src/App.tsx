import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  CAPABILITY_DEFAULT_FIXTURE_PROFILE,
  capabilityIssueThreadFixture,
} from "../../../src/issue-thread/fixtures";
import type {
  CapabilityEvidenceSectionId,
  CapabilityIssueThreadSnapshot,
} from "../../../src/issue-thread/types";
import type { CapabilityDevtoolsSnapshot } from "../../../src/devtools";
import { capabilityDenialCount } from "../../../src/issue-thread/types";
import { Composer } from "./Composer";
import { EvidencePanel } from "./EvidencePanel";
import { Icon } from "./Icons";
import { IssueHeader } from "./IssueHeader";
import { applyFakeInteractionResponse } from "./fake-store";
import type { CapabilityInteractionResponse } from "./InteractionCard";
import {
  capabilityLiveClient,
  recallSession,
  rememberSession,
  type CapabilityCleanRoomIdentity,
  type CapabilityHarnessConfiguration,
} from "./live-client";
import { parseCapabilityRoute, capabilityRouteHref, type CapabilityRoute } from "./route";
import { SurfaceNav, type CapabilityChatHistoryItem } from "./SurfaceNav";
import { EvalAssertions, TurnGroup, type EvalAssertion } from "./ThreadItems";

const PANEL_OPEN_KEY = "paperclip-runner.capability.panel.open";
/**
 * The clean room keeps its own panel preference. Evidence is collapsed by
 * default there on purpose (revision 5: "the default view reads as plain
 * chat"), and inheriting an explorer session's opened drawer would quietly
 * break that on the very first visit.
 */
const CHAT_PANEL_OPEN_KEY = "paperclip-runner.capability.chat.panel.open";
const PANEL_WIDTH_KEY = "paperclip-runner.capability.panel.width";
const PANEL_MIN = 320;
const PANEL_MAX = 960;
/** Play-all cadence for the replay strip (§6); slow enough to read a turn. */
const REPLAY_STEP_MS = 800;
/**
 * The pending-request guidance is a constant because the settle path has to
 * recognise its own stale announcement: a screen reader must not still be told
 * a request is waiting after it was answered (TASK-16978).
 */
const PENDING_ANNOUNCEMENT = "A request is waiting for your answer.";
const ANSWERED_ANNOUNCEMENT = "Your answer was recorded.";
const SETTLED_ANNOUNCEMENT = "The pending request is resolved.";
const SCENARIOS = ["hb-baseline", "dp-documents", "ix-interactions", "ar-artifacts", "wc-workspace-changes", "fr-file-reference", "pe-structured-plan", "te-command-execution", "mp-mcp-progress", "rs-web-research", "da-subagent-delegation", "mr-model-routing", "cc-context-compaction", "ag-generated-artifact", "rv-review-mode", "hk-hook-lifecycle", "mc-memory-citations", "sr-safety-review", "ti-terminal-input", "wt-intentional-wait", "pn-provider-notices", "ax-acpx-lifecycle", "ax-acpx-permissions", "ax-acpx-tools", "ax-acpx-events", "ax-acpx-failures"];
const CHAT_HISTORY_KEY = "paperclip-runner.capability.chat.history.v1";
const CHAT_HARNESS_KEY = "paperclip-runner.capability.chat.harness.v1";
const MODEL_PRESETS = {
  codex: ["gpt-5.4-mini", "gpt-5.4"],
  opencode: ["openrouter/deepseek/deepseek-v4-flash-0731"],
  acpx: ["openrouter/deepseek/deepseek-v4-flash-0731", "claude-sonnet-5", "gpt-5.6-sol"],
} as const;
const ACPX_AGENT_MODELS = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
} as const;

function acpxLabel(configuration: CapabilityHarnessConfiguration | null | undefined): string {
  if (configuration?.provider !== "acpx") return configuration?.provider ?? "starting";
  const agent = configuration.acpxAgent ?? "codex";
  return `Real ${agent === "claude" ? "Claude" : "Codex"} via ACPX`;
}

interface EmbeddedEvalCheck {
  id: string;
  title: string;
  description: string;
  passed: boolean;
  detail: string;
  definition: Record<string, unknown>;
  anchor: { kind: "item" | "turn" | "run"; id: string };
}

interface EmbeddedEvalReport {
  attemptId: string;
  caseId: string;
  disposition: string;
  passed: boolean;
  checks: EmbeddedEvalCheck[];
  run: {
    model: string;
    provider: string;
    driver: string;
    providerVersion: string | null;
    runnerProvider: string;
    configuration: string;
    sessionId: string;
    providerSessionId: string | null;
    agentVersion: string | null;
    retainedSession: boolean | null;
    retainedSessionStatus: string | null;
    fixtureDigest: string;
    runnerPackageDigest: string;
    runnerdDigest: string;
    runnerBuild: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    initialRevision: number;
    finalRevision: number;
    usage: {
      agentTurns: number;
      providerRequests: number | null;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      reasoningTokens: number;
      providerReportedCostNanodollars?: number;
      estimatedCostNanodollars: number;
      pricingVersion: string;
    } | null;
  };
  view: CapabilityIssueThreadSnapshot;
  devtools: CapabilityDevtoolsSnapshot;
  navigation: { suiteHref: string; previous: { label: string; href: string } | null; next: { label: string; href: string } | null };
}

declare global {
  interface Window { __PAPERCLIP_EVAL_REPORT__?: EmbeddedEvalReport }
}

interface StoredChatSession {
  sessionId: string;
  snapshot: CapabilityIssueThreadSnapshot;
  identity: CapabilityCleanRoomIdentity | null;
  updatedAt: string;
  configuration?: CapabilityHarnessConfiguration;
  runtime?: Awaited<ReturnType<typeof capabilityLiveClient.newCleanRoom>>["runtime"];
}

function defaultHarness(provider: CapabilityHarnessConfiguration["provider"] = "codex"): CapabilityHarnessConfiguration {
  return {
    provider,
    model: MODEL_PRESETS[provider][0],
    ...(provider === "acpx" ? { acpxAgent: "codex" as const } : {}),
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
  };
}

function readHarnessConfiguration(): CapabilityHarnessConfiguration {
  try {
    const value = JSON.parse(window.localStorage.getItem(CHAT_HARNESS_KEY) ?? "null") as Partial<CapabilityHarnessConfiguration> | null;
    if (value && (value.provider === "codex" || value.provider === "opencode" || value.provider === "acpx") && typeof value.model === "string") {
      const lifecyclePolicy = value.lifecyclePolicy?.mode === "per_turn"
        ? { mode: "per_turn" as const, idleTimeoutMs: null }
        : value.lifecyclePolicy?.mode === "warm" && Number.isSafeInteger(value.lifecyclePolicy.idleTimeoutMs) && Number(value.lifecyclePolicy.idleTimeoutMs) > 0
          ? { mode: "warm" as const, idleTimeoutMs: Number(value.lifecyclePolicy.idleTimeoutMs) }
          : { mode: "warm" as const, idleTimeoutMs: 300_000 };
      return {
        provider: value.provider,
        model: value.model,
        ...(value.provider === "acpx" ? {
          acpxAgent: value.acpxAgent === "claude" ? value.acpxAgent : "codex",
        } : {}),
        lifecyclePolicy,
      };
    }
  } catch {
    // Invalid preferences fall back to the qualified defaults.
  }
  return defaultHarness();
}

function persistHarnessConfiguration(configuration: CapabilityHarnessConfiguration): void {
  try {
    window.localStorage.setItem(CHAT_HARNESS_KEY, JSON.stringify(configuration));
  } catch {
    // Provider/model preference is convenient but not authority-bearing.
  }
}

function readChatHistory(): StoredChatSession[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_HISTORY_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredChatSession =>
      typeof item === "object" && item !== null &&
      typeof (item as StoredChatSession).sessionId === "string" &&
      typeof (item as StoredChatSession).updatedAt === "string" &&
      typeof (item as StoredChatSession).snapshot === "object",
    ).slice(0, 12);
  } catch {
    return [];
  }
}

function persistChatHistory(history: StoredChatSession[]): void {
  try {
    window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(history.slice(0, 12)));
  } catch {
    // History is a convenience; a blocked or full storage quota must not stop chat.
  }
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, parsed)) : fallback;
  } catch {
    return fallback;
  }
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

/**
 * Scroll an Evidence target into the panel viewport. `start` alignment has to
 * account for the sticky panel head, which would otherwise sit on top of the
 * section header the deep link was supposed to reveal.
 */
function scrollEvidenceIntoView(target: Element, block: "start" | "center"): void {
  target.scrollIntoView({ block });
  if (block !== "start") return;
  const panel = target.closest<HTMLElement>(".pit-panel");
  const head = panel?.querySelector<HTMLElement>(".pit-panel-chrome");
  if (panel == null || head == null) return;
  panel.scrollTop = Math.max(0, panel.scrollTop - head.offsetHeight);
}

function describe(cause: unknown): string {
  return String(cause instanceof Error ? cause.message : cause);
}

/** Resolution copy for a request that settled without this client answering it. */
function settledAnnouncement(snapshot: CapabilityIssueThreadSnapshot, interactionId: string): string {
  for (const turn of snapshot.turns) {
    for (const item of turn.items) {
      if (item.kind === "interaction" && item.interactionId === interactionId) {
        return `${SETTLED_ANNOUNCEMENT} ${item.stateLabel}.`;
      }
    }
  }
  return SETTLED_ANNOUNCEMENT;
}

function currentTurnActivity(snapshot: CapabilityIssueThreadSnapshot): string {
  const harness = snapshot.identity.agentLabel.replace(/^Real /, "");
  const turn = snapshot.turns.at(-1);
  if (turn === undefined) return `Dispatching turn to ${harness}`;
  const activity = [...turn.items].reverse().find((item) =>
    item.kind === "tool_activity" || item.kind === "progress_activity" || item.kind === "provider_activity" ||
    (item.kind === "agent_message" && item.streaming),
  );
  if (activity?.kind === "tool_activity") {
    return activity.status === "running"
      ? `Paperclip tool · ${activity.operationId}`
      : `Paperclip tool completed · ${activity.operationId}`;
  }
  if (activity?.kind === "progress_activity") return activity.summary;
  if (activity?.kind === "agent_message") return `Receiving ${harness} response`;
  return `Waiting for ${harness} activity`;
}

function useRoute(): CapabilityRoute {
  const [route, setRoute] = useState(() => parseCapabilityRoute(window.location));
  useEffect(() => {
    const onChange = () => setRoute(parseCapabilityRoute(window.location));
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return route;
}

function useLayout(): "side" | "overlay" | "segment" {
  const [layout, setLayout] = useState<"side" | "overlay" | "segment">(() =>
    window.innerWidth <= 767 ? "segment" : window.innerWidth <= 1100 ? "overlay" : "side",
  );
  useEffect(() => {
    const onResize = () =>
      setLayout(window.innerWidth <= 767 ? "segment" : window.innerWidth <= 1100 ? "overlay" : "side");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return layout;
}

export function App() {
  const embeddedEval = window.__PAPERCLIP_EVAL_REPORT__ ?? null;
  const route = useRoute();
  const chat = route.surface === "chat";
  const layout = useLayout();

  useEffect(() => {
    if (embeddedEval !== null) {
      document.title = `${embeddedEval.passed ? "✓" : "✕"} ${embeddedEval.caseId} · paperclip-runner eval`;
      return;
    }
    document.title = chat
      ? "🫧 Mock Paperclip · Issue thread"
      : "🧯 Mock Paperclip · Issue thread";
  }, [chat, embeddedEval]);

  const [snapshot, setSnapshot] = useState<CapabilityIssueThreadSnapshot | null>(null);
  const [devtools, setDevtools] = useState<CapabilityDevtoolsSnapshot | null>(null);
  const [identity, setIdentity] = useState<CapabilityCleanRoomIdentity | null>(null);
  const initialHarnessRef = useRef<CapabilityHarnessConfiguration>(readHarnessConfiguration());
  const [harness, setHarness] = useState<CapabilityHarnessConfiguration>(initialHarnessRef.current);
  const [activeHarness, setActiveHarness] = useState<CapabilityHarnessConfiguration | null>(null);
  const [providerRuntime, setProviderRuntime] = useState<Awaited<ReturnType<typeof capabilityLiveClient.newCleanRoom>>["runtime"]>(undefined);
  const [chatHistory, setChatHistory] = useState<StoredChatSession[]>(readChatHistory);
  const [historicSessionId, setHistoricSessionId] = useState<string | null>(null);
  const liveRoomRef = useRef<StoredChatSession | null>(null);
  /**
   * Which surface produced `snapshot`. A hash change commits the new route in
   * the same frame that still renders the old snapshot, so without this a
   * capture or a test can catch one frame of "settled" that belongs to the
   * surface it just navigated away from.
   */
  const [snapshotSurface, setSnapshotSurface] = useState(route.surface);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [settled, setSettled] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => embeddedEval !== null ||
    readStoredFlag(route.surface === "chat" ? CHAT_PANEL_OPEN_KEY : PANEL_OPEN_KEY, false));
  const [panelWidth, setPanelWidth] = useState(() => readStoredNumber(PANEL_WIDTH_KEY, 384));
  const [segment, setSegment] = useState<"thread" | "evidence">(route.segment);
  const [openSections, setOpenSections] = useState<CapabilityEvidenceSectionId[]>(["tools"]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | "all">("all");
  const [highlightedRecordId, setHighlightedRecordId] = useState<string | null>(route.record);
  const [focusInteractionId, setFocusInteractionId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** True while a turn stream is open, so the surface never reads as settled. */
  const [streamingTurn, setStreamingTurn] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cancelResetRef = useRef<HTMLButtonElement | null>(null);
  /** Last announced pending request, so the live region tracks transitions. */
  const announcedPendingRef = useRef<string | null>(null);
  /**
   * Turn generation. Reset, `New chat`, and leaving the surface all bump it, so
   * a frame from a turn that has since been abandoned is dropped instead of
   * appended to a thread it no longer belongs to.
   */
  const turnGenerationRef = useRef(0);
  const turnAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (embeddedEval !== null) setPanelOpen(true);
  }, [embeddedEval]);

  /** Abandons any open turn stream: the server sees the disconnect and stops. */
  const abandonTurn = useCallback(() => {
    turnGenerationRef.current += 1;
    const controller = turnAbortRef.current;
    turnAbortRef.current = null;
    setStreamingTurn(false);
    controller?.abort();
  }, []);

  /* --------------------------------------------------------------- loading */

  useEffect(() => {
    let cancelled = false;
    setSettled(false);
    setError(null);
    if (embeddedEval !== null) {
      setIdentity(null);
      setSnapshot({
        ...embeddedEval.view,
        composer: { state: "disabled", helper: null, reason: "Immutable eval recording", pendingInteractionId: null },
      });
      setDevtools(embeddedEval.devtools);
      setSnapshotSurface("issue");
    } else if (chat) {
      // The clean room has no fixture fallback: if real Codex and real runnerd
      // cannot start, the surface says so rather than rendering a canned thread.
      void (async () => {
        try {
          const response = await capabilityLiveClient.loadCleanRoom(
            recallSession("cleanroom"),
            initialHarnessRef.current,
          );
          if (cancelled) return;
          rememberSession(response.sessionId, "cleanroom");
          setIdentity(response.identity ?? null);
          const configuration = response.configuration ?? initialHarnessRef.current;
          setActiveHarness(configuration);
          // The server-returned immutable session configuration is authoritative
          // for both the active status and the options initially shown for the
          // next chat after a restore.
          setHarness(configuration);
          setProviderRuntime(response.runtime);
          setHistoricSessionId(null);
          setSnapshot(response.view);
          setSnapshotSurface("chat");
        } catch (cause) {
          if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause));
        }
      })();
    } else if (route.mode === "live") {
      void (async () => {
        try {
          const response = await capabilityLiveClient.load(recallSession());
          if (cancelled) return;
          rememberSession(response.sessionId);
          setSnapshot(response.view);
          setSnapshotSurface("issue");
        } catch (cause) {
          if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause));
        }
      })();
    } else {
      setIdentity(null);
      setSnapshot(capabilityIssueThreadFixture(route.shot ?? "thread-baseline", route.fixtureProfile));
      setSnapshotSurface("issue");
    }
    return () => {
      cancelled = true;
      // Leaving the surface (or reloading it) must not leave a turn streaming
      // into a thread that is no longer on screen.
      abandonTurn();
    };
  }, [abandonTurn, chat, embeddedEval, route.mode, route.shot, route.fixtureProfile, loadNonce]);

  /* ------------------------------------------------------- deep-link params */

  useEffect(() => {
    if (route.panel === null) return;
    setPanelOpen(true);
    setSegment("evidence");
    setOpenSections((current) =>
      current.includes(route.panel as CapabilityEvidenceSectionId)
        ? current
        : [...current, route.panel as CapabilityEvidenceSectionId],
    );
    setHighlightedRecordId(route.record);
  }, [route.panel, route.record]);

  useLayoutEffect(() => {
    // A deep link has to land on what it addressed. With `rec` that is the
    // record; without it, the opened section's header — otherwise the link
    // half-arrives with the section still below the fold. Wait for the bundled
    // faces before measuring: a host fallback can otherwise move the retained
    // scroll position by a pixel even after the final webfonts replace it.
    if (route.panel === null || snapshot === null) return;
    const panel = route.panel;
    const record = route.record;
    let cancelled = false;
    void (async () => {
      if (typeof document.fonts?.ready?.then === "function") {
        await document.fonts.ready;
      }
      if (cancelled) return;
      const target =
        record === null
          ? document.querySelector(`[data-evidence-section="${CSS.escape(panel)}"]`)
          : document.querySelector(`[data-record-id="${CSS.escape(record)}"]`);
      if (target !== null) {
        scrollEvidenceIntoView(target, record === null ? "start" : "center");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route.panel, route.record, snapshot, panelOpen, segment, openSections]);

  useEffect(() => {
    setSegment(route.segment);
  }, [route.segment]);

  /* -------------------------------------------------- settle + auto-follow */

  useEffect(() => {
    if (snapshot === null) return;
    let cancelled = false;
    const scroller = scrollRef.current;
    void (async () => {
      if (typeof document.fonts?.ready?.then === "function") {
        await document.fonts.ready;
      }
      if (cancelled) return;
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!cancelled) setSettled(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  useEffect(() => {
    if (!panelOpen || snapshot === null || route.mode !== "live") return;
    if (historicSessionId !== null) return;
    let cancelled = false;
    void capabilityLiveClient.devtools(snapshot.sessionId)
      .then((next) => { if (!cancelled) setDevtools(next); })
      .catch((cause) => { if (!cancelled) setActionError(describe(cause)); });
    return () => { cancelled = true; };
  }, [historicSessionId, panelOpen, route.mode, snapshot?.renderedAt, snapshot?.sessionId]);

  useEffect(() => {
    if (!chat || snapshot === null || historicSessionId !== null) return;
    const record: StoredChatSession = {
      sessionId: snapshot.sessionId,
      snapshot,
      identity,
      updatedAt: snapshot.renderedAt,
      ...(activeHarness === null ? {} : { configuration: activeHarness }),
      ...(providerRuntime === undefined ? {} : { runtime: providerRuntime }),
    };
    liveRoomRef.current = record;
    setChatHistory((current) => {
      const next = [record, ...current.filter((item) => item.sessionId !== record.sessionId)].slice(0, 12);
      persistChatHistory(next);
      return next;
    });
  }, [activeHarness, chat, historicSessionId, identity, providerRuntime, snapshot?.renderedAt, snapshot?.sessionId]);

  useEffect(() => {
    if (snapshot === null) return;
    const pending = snapshot.composer.pendingInteractionId;
    const announced = announcedPendingRef.current;
    announcedPendingRef.current = pending;

    if (pending !== null) {
      // Announce a request once, when it arrives. Re-announcing on every
      // snapshot would talk over the outcome the user just triggered: a live
      // submit re-renders with the same request still pending.
      if (pending !== announced) setAnnouncement(PENDING_ANNOUNCEMENT);
      return;
    }
    if (snapshot.connection.state === "reconnecting") {
      setAnnouncement(`Connection lost — retrying (attempt ${snapshot.connection.attempt}).`);
      return;
    }
    if (announced === null) return;
    // The request settled. Anything the resolution itself announced stands;
    // only the now-false "still waiting" guidance is replaced, so a screen
    // reader never carries pending-state copy into later turns (TASK-16978).
    setAnnouncement((current) =>
      current === PENDING_ANNOUNCEMENT ? settledAnnouncement(snapshot, announced) : current,
    );
  }, [snapshot]);

  /* -------------------------------------------------------------- handlers */

  const persistPanel = useCallback(
    (open: boolean, width: number) => {
      try {
        window.localStorage.setItem(chat ? CHAT_PANEL_OPEN_KEY : PANEL_OPEN_KEY, String(open));
        window.localStorage.setItem(PANEL_WIDTH_KEY, String(width));
      } catch {
        // Panel preference is a convenience, never a correctness requirement.
      }
    },
    [chat],
  );

  const openEvidence = useCallback(
    (section: CapabilityEvidenceSectionId, recordId: string) => {
      setPanelOpen(true);
      setSegment("evidence");
      setSelectedTurnId("all");
      setOpenSections((current) => (current.includes(section) ? current : [...current, section]));
      setHighlightedRecordId(recordId);
      persistPanel(true, panelWidth);
      window.setTimeout(() => {
        document
          .querySelector(`[data-record-id="${CSS.escape(recordId)}"]`)
          ?.scrollIntoView({ block: "center" });
      }, 0);
    },
    [panelWidth, persistPanel],
  );

  const closeEvidence = useCallback(() => {
    setPanelOpen(false);
    persistPanel(false, panelWidth);
    if (layout === "segment") setSegment("thread");
    // Focus came into the panel when it opened (§9.2), so hand it back to the
    // visible control that owns the panel rather than dropping it on `body`.
    window.setTimeout(() => {
      const candidates = ['[data-testid="evidence-toggle"]', '[data-testid="segment-thread"]'];
      for (const selector of candidates) {
        const control = document.querySelector<HTMLElement>(selector);
        if (control !== null && control.offsetParent !== null) {
          control.focus();
          return;
        }
      }
    }, 0);
  }, [layout, panelWidth, persistPanel]);

  const jumpToThread = useCallback((anchorId: string) => {
    setSegment("thread");
    const anchor = document.getElementById(anchorId) ?? document.querySelector(`#${CSS.escape(anchorId)}`);
    anchor?.scrollIntoView({ block: "center" });
  }, []);

  const respond = useCallback(
    (response: CapabilityInteractionResponse) => {
      if (snapshot === null) return;
      if (route.mode !== "live") {
        setSnapshot(applyFakeInteractionResponse(snapshot, response));
        setAnnouncement(ANSWERED_ANNOUNCEMENT);
        return;
      }

      // Network effects must never live inside a React state updater. Strict
      // Mode intentionally invokes updater functions more than once in
      // development, which previously submitted every interaction twice: the
      // first request resolved it and the duplicate produced "not pending".
      const sessionId = snapshot.sessionId;
      setActionError(null);
      setSnapshot((current) => current === null ? current : {
        ...current,
        turns: current.turns.map((turn) => ({
          ...turn,
          items: turn.items.map((item) =>
            item.kind === "interaction" && item.interactionId === response.interactionId
              ? { ...item, state: "submitting" as const, stateLabel: "Submitting…" }
              : item,
          ),
        })),
      });
      void capabilityLiveClient
        .respond(sessionId, response.interactionId, response.outcome, response.result)
        .then((next) => {
          setSnapshot(next.view);
          setAnnouncement(ANSWERED_ANNOUNCEMENT);
        })
        .catch((cause) => {
          setActionError(describe(cause));
          setSnapshot((current) => current === null ? current : {
            ...current,
            turns: current.turns.map((turn) => ({
              ...turn,
              items: turn.items.map((item) =>
                item.kind === "interaction" &&
                item.interactionId === response.interactionId &&
                item.state === "submitting"
                  ? { ...item, state: "pending" as const, stateLabel: "Waiting for you" }
                  : item,
              ),
            })),
          });
        });
    },
    [route.mode, snapshot],
  );

  /**
   * Sends one message and renders the turn as it arrives.
   *
   * Each frame is a whole server projection, so the surface still never patches
   * state locally — it just gets more than one projection per turn. The settled
   * payload is applied last and stays the authority.
   */
  const send = useCallback(
    (message: string) => {
      if (snapshot === null) return;
      if (route.mode !== "live") return;
      setActionError(null);
      abandonTurn();
      const generation = turnGenerationRef.current;
      const controller = new AbortController();
      turnAbortRef.current = controller;
      setStreamingTurn(true);
      setSnapshot((current) =>
        current === null ? current : { ...current, composer: { ...current.composer, state: "sending" } },
      );
      void capabilityLiveClient
        .send(snapshot.sessionId, message, {
          signal: controller.signal,
          onFrame: (view) => {
            if (turnGenerationRef.current === generation) setSnapshot(view);
          },
        })
        .then((next) => {
          if (turnGenerationRef.current === generation) {
            setSnapshot(next.view);
            setProviderRuntime(next.runtime);
          }
        })
        .catch((cause) => {
          if (turnGenerationRef.current !== generation || controller.signal.aborted) return;
          setActionError(describe(cause));
          // A refused turn must not strand the composer in `sending`.
          setSnapshot((stale) =>
            stale === null ? stale : { ...stale, composer: { ...stale.composer, state: "ready" } },
          );
        })
        .finally(() => {
          if (turnGenerationRef.current !== generation) return;
          turnAbortRef.current = null;
          setStreamingTurn(false);
        });
    },
    [abandonTurn, route.mode, snapshot],
  );

  const stop = useCallback(() => {
    setSnapshot((current) => {
      if (current === null) return current;
      if (route.mode === "live") {
        // Stop reaches the provider interrupt through its own request; the open
        // turn stream keeps rendering and its terminal frame — not this
        // response — decides what the stopped turn finally looks like.
        const streaming = turnAbortRef.current !== null;
        void capabilityLiveClient
          .stop(current.sessionId)
          .then((next) => {
            if (!streaming && turnAbortRef.current === null) setSnapshot(next.view);
          })
          .catch((cause) => setActionError(describe(cause)));
        return current;
      }
      const turns = current.turns.map((turn, index) =>
        index === current.turns.length - 1 ? { ...turn, stoppedByUser: true } : turn,
      );
      return {
        ...current,
        turns,
        composer: { state: "ready", helper: null, reason: null, pendingInteractionId: null },
      };
    });
    setAnnouncement("Turn stopped. Partial output is preserved.");
  }, [route.mode]);

  /**
   * Adopts a rotated clean room. Reset and `New chat` both land here: the
   * server always answers with a new session id and new mock identities, so the
   * client's job is only to forget the old ones.
   */
  const adoptCleanRoom = useCallback((next: Awaited<ReturnType<typeof capabilityLiveClient.newCleanRoom>>) => {
    rememberSession(next.sessionId, "cleanroom");
    setIdentity(next.identity ?? null);
    const configuration = next.configuration ?? harness;
    setActiveHarness(configuration);
    setHarness(configuration);
    setProviderRuntime(next.runtime);
    setHistoricSessionId(null);
    setSnapshot(next.view);
    setDevtools(null);
    setError(null);
    setActionError(null);
    setAnnouncement(
      `New clean-room chat started on ${next.view.issue.identifier}. The previous session was closed.`,
    );
  }, [harness]);

  const newChat = useCallback(() => {
    const model = harness.model?.trim() ?? "";
    if (!model) {
      setActionError("Choose or enter a model before starting a new chat.");
      return;
    }
    if (harness.provider === "opencode" && !model.includes("/")) {
      setActionError("OpenCode models must use provider/model form.");
      return;
    }
    if (harness.provider === "acpx") {
      const agent = harness.acpxAgent ?? "codex";
      if (model !== ACPX_AGENT_MODELS[agent]) {
        setActionError(`The qualified ACPX ${agent} profile requires exact model ${ACPX_AGENT_MODELS[agent]}.`);
        return;
      }
    }
    const configuration = { ...harness, model };
    persistHarnessConfiguration(configuration);
    setConfirmReset(false);
    // The room this turn belongs to is about to be retired, so the stream is
    // dropped before the request that retires it.
    abandonTurn();
    setAnnouncement("Starting a new clean-room chat…");
    void capabilityLiveClient
      .newCleanRoom(liveRoomRef.current?.sessionId ?? snapshot?.sessionId ?? null, configuration)
      .then(adoptCleanRoom)
      .catch((cause) => setActionError(describe(cause)));
  }, [abandonTurn, adoptCleanRoom, harness, snapshot]);

  const selectChatHistory = useCallback((sessionId: string) => {
    const live = liveRoomRef.current;
    if (live?.sessionId === sessionId) {
      setSnapshot(live.snapshot);
      setIdentity(live.identity);
      setActiveHarness(live.configuration ?? null);
      if (live.configuration !== undefined) setHarness(live.configuration);
      setProviderRuntime(live.runtime);
      setDevtools(null);
      setHistoricSessionId(null);
      setActionError(null);
      return;
    }
    const archived = chatHistory.find((item) => item.sessionId === sessionId);
    if (archived === undefined) return;
    abandonTurn();
    const configuration = archived.configuration ?? defaultHarness();
    void capabilityLiveClient.loadCleanRoom(sessionId, configuration)
      .then((restored) => {
        rememberSession(restored.sessionId, "cleanroom");
        setSnapshot(restored.view);
        setIdentity(restored.identity ?? archived.identity);
        setActiveHarness(restored.configuration ?? configuration);
        setHarness(restored.configuration ?? configuration);
        setProviderRuntime(restored.runtime);
        setDevtools(null);
        setHistoricSessionId(null);
        setActionError(null);
        setAnnouncement("Archived chat restored. The runner will resume when you send a message.");
      })
      .catch((cause) => setActionError(describe(cause)));
  }, [abandonTurn, chatHistory]);

  const reset = useCallback(() => {
    setConfirmReset(false);
    abandonTurn();
    if (chat && snapshot !== null) {
      void capabilityLiveClient
        .reset(snapshot.sessionId)
        .then(adoptCleanRoom)
        .catch((cause) => setActionError(describe(cause)));
      return;
    }
    if (route.mode === "live" && snapshot !== null) {
      void capabilityLiveClient
        .reset(snapshot.sessionId)
        .then((next) => {
          rememberSession(next.sessionId);
          setSnapshot(next.view);
        })
        .catch((cause) => setActionError(describe(cause)));
      return;
    }
    setSnapshot(capabilityIssueThreadFixture("thread-baseline", route.fixtureProfile));
    setAnnouncement("Scenario reset. The mock state is back to its clean seed.");
  }, [abandonTurn, adoptCleanRoom, chat, route.fixtureProfile, route.mode, snapshot]);

  const retry = useCallback(() => {
    if (route.mode === "live" && snapshot !== null) {
      void capabilityLiveClient
        .reconnect(snapshot.sessionId)
        .then((next) => setSnapshot(next.view))
        .catch((cause) => setActionError(describe(cause)));
      return;
    }
    setSnapshot((current) =>
      current === null
        ? current
        : {
            ...current,
            connection: { state: "connected", attempt: 0 },
            composer: { state: "ready", helper: null, reason: null, pendingInteractionId: null },
          },
    );
    setReconnected(true);
    window.setTimeout(() => setReconnected(false), 3_000);
  }, [route.mode, snapshot]);

  useEffect(() => {
    if (!confirmReset) return;
    cancelResetRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setConfirmReset(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmReset]);

  /* ----------------------------------------------------------- replay (§6) */

  // `?at=<ordinal>` is the source of truth for where the recording is parked,
  // so step / next-turn / play-all and the deep link all move the same value.
  const replay = useMemo(() => {
    if (snapshot === null || snapshot.replay === null) return null;
    const { total } = snapshot.replay;
    const ordinal =
      route.at === null ? snapshot.replay.ordinal : Math.min(total, Math.max(0, route.at));
    return { ordinal, total };
  }, [snapshot, route.at]);

  const seekReplay = useCallback(
    (ordinal: number) => {
      setPlaying(false);
      window.location.hash = capabilityRouteHref(route, { at: ordinal });
    },
    [route],
  );

  useEffect(() => {
    if (!playing || replay === null) return;
    if (replay.ordinal >= replay.total) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      window.location.hash = capabilityRouteHref(route, { at: replay.ordinal + 1 });
    }, REPLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, replay, route]);

  useEffect(() => {
    if (replay === null) setPlaying(false);
  }, [replay]);

  /* ---------------------------------------------------------------- render */

  const denialCount = useMemo(
    () => (snapshot === null ? 0 : capabilityDenialCount(snapshot.evidence, null)),
    [snapshot],
  );
  const historyItems: CapabilityChatHistoryItem[] = chatHistory.map((item) => ({
    sessionId: item.sessionId,
    identifier: item.snapshot.issue.identifier,
    title: item.snapshot.issue.title,
    updatedAt: item.updatedAt,
    current: liveRoomRef.current?.sessionId === item.sessionId,
  }));
  const surfaceNav = (
    <SurfaceNav
      surface={route.surface}
      history={historyItems}
      activeSessionId={snapshot?.sessionId ?? null}
      onNewChat={chat ? newChat : () => { window.location.hash = "#/chat"; }}
      onSelectHistory={selectChatHistory}
    />
  );

  if (error !== null) {
    return (
      <div className="pit-app" data-thread-state="failed" data-surface={route.surface}>
        {surfaceNav}
        <main className="pit-app-error">
          <p className="pit-composer-reason" role="alert" data-testid="surface-error">
            {chat
              ? `The clean-room chat could not start the selected provider: ${error}`
              : error}
          </p>
          {chat ? (
            <>
              <p className="pit-muted">
                The clean room only runs against the selected real provider through real runnerd, so it does not fall
                back to a fixture or a recording.
              </p>
              <section className="pit-harness-picker" aria-label="Chat provider recovery options">
                <label>
                  <span>Provider</span>
                  <select
                    data-testid="chat-provider"
                    value={harness.provider}
                    onChange={(event) => {
                      const provider = event.target.value as CapabilityHarnessConfiguration["provider"];
                      setHarness((current) => ({
                        ...defaultHarness(provider),
                        lifecyclePolicy: current.lifecyclePolicy,
                      }));
                    }}
                  >
                    <option value="codex">Codex</option>
                    <option value="opencode">OpenCode</option>
                    <option value="acpx">ACPX</option>
                  </select>
                </label>
                {harness.provider === "acpx" ? (
                  <label>
                    <span>ACP agent</span>
                    <select
                      data-testid="chat-acpx-agent"
                      value={harness.acpxAgent ?? "codex"}
                      onChange={(event) => {
                        const acpxAgent = event.target.value as NonNullable<CapabilityHarnessConfiguration["acpxAgent"]>;
                        setHarness((current) => ({
                          ...current,
                          acpxAgent,
                          model: ACPX_AGENT_MODELS[acpxAgent],
                        }));
                      }}
                    >
                      <option value="claude">Claude</option>
                      <option value="codex">Codex (control)</option>
                    </select>
                  </label>
                ) : null}
                <label>
                  <span>Execution</span>
                  <select
                    data-testid="chat-lifecycle-mode"
                    value={harness.lifecyclePolicy.mode}
                    onChange={(event) => setHarness((current) => ({
                      ...current,
                      lifecyclePolicy: event.target.value === "per_turn"
                        ? { mode: "per_turn", idleTimeoutMs: null }
                        : { mode: "warm", idleTimeoutMs: 300_000 },
                    }))}
                  >
                    <option value="warm">Warm session</option>
                    <option value="per_turn">Turn by turn</option>
                  </select>
                </label>
                {harness.lifecyclePolicy.mode === "warm" ? (
                  <label>
                    <span>Idle timeout (seconds)</span>
                    <input
                      data-testid="chat-idle-timeout"
                      type="number"
                      min={1}
                      value={Math.round((harness.lifecyclePolicy.idleTimeoutMs ?? 300_000) / 1_000)}
                      onChange={(event) => setHarness((current) => ({
                        ...current,
                        lifecyclePolicy: {
                          mode: "warm",
                          idleTimeoutMs: Math.max(1, Number(event.target.value)) * 1_000,
                        },
                      }))}
                    />
                  </label>
                ) : null}
                <label className="pit-harness-model">
                  <span>Model</span>
                  <input
                    data-testid="chat-model"
                    list={`chat-recovery-models-${harness.provider}`}
                    value={harness.model ?? ""}
                    placeholder={harness.provider === "opencode" ? "provider/model" : "model name"}
                    onChange={(event) => setHarness((current) => ({ ...current, model: event.target.value }))}
                  />
                  <datalist id={`chat-recovery-models-${harness.provider}`}>
                    {MODEL_PRESETS[harness.provider].map((model) => <option key={model} value={model} />)}
                  </datalist>
                </label>
                <button
                  type="button"
                  className="pit-button"
                  data-variant="primary"
                  data-testid="chat-apply-harness"
                  onClick={newChat}
                >
                  Start new chat
                </button>
              </section>
            </>
          ) : null}
          <button
            type="button"
            className="pit-button"
            data-variant="primary"
            data-testid="surface-error-retry"
            onClick={() => setLoadNonce((current) => current + 1)}
          >
            Try again
          </button>
        </main>
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <div className="pit-app" data-thread-state="loading" data-surface={route.surface}>
        {surfaceNav}
        <main className="pit-app-error">
          <p className="pit-muted" role="status" data-testid="surface-loading">
            {chat
              ? "Starting real runnerd and the selected provider for a fresh mock tenant…"
              : "Loading…"}
          </p>
        </main>
      </div>
    );
  }

  const showThread = layout !== "segment" || segment === "thread";
  const showPanel = layout === "segment" ? segment === "evidence" : panelOpen;

  return (
    <div
      className="pit-app"
      data-thread-state={
        streamingTurn
          ? "streaming"
          : settled && snapshotSurface === route.surface
            ? "settled"
            : "loading"
      }
      data-session-mode={snapshot.mode}
      data-surface={route.surface}
      data-connection-state={snapshot.connection.state}
      data-eval-view={embeddedEval !== null}
    >
      {embeddedEval === null ? surfaceNav : null}

      <IssueHeader
        snapshot={snapshot}
        readOnly={embeddedEval !== null}
        scenarios={SCENARIOS}
        surface={route.surface}
        cleanRoomToken={identity?.token ?? null}
        evidenceOpen={panelOpen}
        denialCount={denialCount}
        segment={segment}
        onToggleEvidence={() => {
          const next = !panelOpen;
          setPanelOpen(next);
          persistPanel(next, panelWidth);
          if (layout === "segment") setSegment(next ? "evidence" : "thread");
        }}
        onSelectScenario={(scenario) => {
          window.location.hash = capabilityRouteHref(route, { fixtureProfile: scenario });
        }}
        onReplay={() => {
          window.location.hash = capabilityRouteHref(route, {
            shot: "replay-mode",
            mode: "replay",
            at: 12,
          });
        }}
        onReset={() => setConfirmReset(true)}
        onStop={stop}
        onSelectSegment={setSegment}
      />

      {chat && embeddedEval === null ? (
        <section className="pit-harness-picker" aria-label="Chat provider and model">
          <label>
            <span>Provider</span>
            <select
              data-testid="chat-provider"
              value={harness.provider}
              disabled={streamingTurn}
              onChange={(event) => {
                const provider = event.target.value as CapabilityHarnessConfiguration["provider"];
                setHarness((current) => ({
                  ...defaultHarness(provider),
                  lifecyclePolicy: current.lifecyclePolicy,
                }));
              }}
            >
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
              <option value="acpx">ACPX</option>
            </select>
          </label>
          {harness.provider === "acpx" ? (
            <label>
              <span>ACP agent</span>
              <select
                data-testid="chat-acpx-agent"
                value={harness.acpxAgent ?? "codex"}
                disabled={streamingTurn}
                onChange={(event) => {
                  const acpxAgent = event.target.value as NonNullable<CapabilityHarnessConfiguration["acpxAgent"]>;
                  setHarness((current) => ({
                    ...current,
                    acpxAgent,
                    model: ACPX_AGENT_MODELS[acpxAgent],
                  }));
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex (control)</option>
              </select>
            </label>
          ) : null}
          <label>
            <span>Execution</span>
            <select
              data-testid="chat-lifecycle-mode"
              value={harness.lifecyclePolicy.mode}
              disabled={streamingTurn}
              onChange={(event) => setHarness((current) => ({
                ...current,
                lifecyclePolicy: event.target.value === "per_turn"
                  ? { mode: "per_turn", idleTimeoutMs: null }
                  : { mode: "warm", idleTimeoutMs: 300_000 },
              }))}
            >
              <option value="warm">Warm session</option>
              <option value="per_turn">Turn by turn</option>
            </select>
          </label>
          {harness.lifecyclePolicy.mode === "warm" ? (
            <label>
              <span>Idle timeout (seconds)</span>
              <input
                data-testid="chat-idle-timeout"
                type="number"
                min={1}
                step={1}
                value={Math.round(harness.lifecyclePolicy.idleTimeoutMs / 1_000)}
                disabled={streamingTurn}
                onChange={(event) => {
                  const seconds = Math.max(1, Number.parseInt(event.target.value || "1", 10));
                  setHarness((current) => ({
                    ...current,
                    lifecyclePolicy: { mode: "warm", idleTimeoutMs: seconds * 1_000 },
                  }));
                }}
              />
            </label>
          ) : null}
          <label className="pit-harness-model">
            <span>Model</span>
            <input
              data-testid="chat-model"
              list={`chat-models-${harness.provider}`}
              value={harness.model ?? ""}
              disabled={streamingTurn}
              placeholder={harness.provider === "opencode" ? "provider/model" : "model name"}
              onChange={(event) => setHarness((current) => ({ ...current, model: event.target.value }))}
            />
            <datalist id={`chat-models-${harness.provider}`}>
              {MODEL_PRESETS[harness.provider].map((model) => <option key={model} value={model} />)}
            </datalist>
          </label>
          <button
            type="button"
            className="pit-button"
            data-variant="primary"
            data-testid="chat-apply-harness"
            disabled={streamingTurn || historicSessionId !== null}
            onClick={newChat}
          >
            Start new chat
          </button>
          <span className="pit-harness-active" data-testid="chat-active-harness">
            Active: {acpxLabel(activeHarness)}
            {activeHarness?.model ? ` · ${activeHarness.model}` : ""}
            {activeHarness ? ` · ${activeHarness.lifecyclePolicy.mode === "warm" ? `warm ${Math.round(activeHarness.lifecyclePolicy.idleTimeoutMs / 1_000)}s` : "turn by turn"}` : ""}
            {providerRuntime?.runnerPid ? ` · runner PID ${providerRuntime.runnerPid}` : ""}
            {activeHarness?.provider === "acpx" && providerRuntime?.sidecarPid ? ` · sidecar PID ${providerRuntime.sidecarPid}` : ""}
            {activeHarness?.provider === "acpx" && providerRuntime?.agentPid ? ` · agent PID ${providerRuntime.agentPid}` : ""}
            {activeHarness?.provider === "acpx" && providerRuntime?.driverSessionId ? ` · ACPX record ${providerRuntime.driverSessionId}` : ""}
            {providerRuntime?.providerSessionId ? ` · session ${providerRuntime.providerSessionId}` : ""}
            {activeHarness?.provider === "acpx" && providerRuntime?.providerVersion ? ` · ACPX ${providerRuntime.providerVersion}` : ""}
            {activeHarness?.provider === "acpx" && providerRuntime?.agentServerVersion ? ` · agent ${providerRuntime.agentServerVersion}` : ""}
            {activeHarness?.provider === "acpx" && providerRuntime?.acpProtocolVersion ? ` · ACP ${providerRuntime.acpProtocolVersion}` : ""}
            {providerRuntime?.status ? ` · ${providerRuntime.status}` : ""}
          </span>
        </section>
      ) : null}

      {embeddedEval !== null ? (
        <nav className="pit-eval-nav" aria-label="Eval result navigation">
          <a href={embeddedEval.navigation.suiteHref}>← All results</a>
          {embeddedEval.navigation.previous ? <a href={embeddedEval.navigation.previous.href}>← {embeddedEval.navigation.previous.label}</a> : <span />}
          <strong>{embeddedEval.passed ? "PASS" : "FAIL"} · {embeddedEval.attemptId}</strong>
          {embeddedEval.navigation.next ? <a href={embeddedEval.navigation.next.href}>{embeddedEval.navigation.next.label} →</a> : <span />}
        </nav>
      ) : null}

      {actionError !== null ? (
        <p className="pit-banner" data-tone="danger" role="alert" data-testid="action-error">
          <span aria-hidden="true">⚠</span>
          {actionError}
          <button
            type="button"
            className="pit-link-button"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </button>
        </p>
      ) : null}

      {snapshot.connection.state === "reconnecting" ? (
        <p className="pit-banner" role="status" data-testid="reconnect-banner">
          <span aria-hidden="true">⏳</span>
          Connection lost — retrying (attempt {snapshot.connection.attempt})
        </p>
      ) : reconnected ? (
        <p className="pit-banner" data-tone="success" role="status">
          <span aria-hidden="true">✓</span>
          Reconnected
        </p>
      ) : null}

      {streamingTurn ? (
        <div className="pit-live-activity" role="status" aria-live="polite" data-testid="live-activity">
          <span className="pit-live-activity-pulse" aria-hidden="true" />
          <Icon name="terminal" />
          <span>{currentTurnActivity(snapshot)}</span>
          <span className="pit-live-activity-tail" aria-hidden="true">live</span>
        </div>
      ) : null}

      {replay !== null ? (
        <div className="pit-replay-strip" data-testid="replay-strip">
          <span>
            Replay {replay.ordinal}/{replay.total}
          </span>
          <div
            className="pit-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={replay.total}
            aria-valuenow={replay.ordinal}
            aria-label="Replay progress"
          >
            <div
              className="pit-progress-fill"
              style={{ width: `${(replay.ordinal / replay.total) * 100}%` }}
            />
          </div>
          <button
            type="button"
            className="pit-button"
            disabled={replay.ordinal <= 0}
            data-testid="replay-step-back"
            onClick={() => seekReplay(replay.ordinal - 1)}
          >
            Step back
          </button>
          <button
            type="button"
            className="pit-button"
            disabled={replay.ordinal >= replay.total}
            data-testid="replay-next-turn"
            onClick={() => seekReplay(replay.ordinal + 1)}
          >
            Next turn
          </button>
          <button
            type="button"
            className="pit-button"
            data-variant={playing ? undefined : "primary"}
            aria-pressed={playing}
            disabled={!playing && replay.ordinal >= replay.total}
            data-testid="replay-play-all"
            onClick={() => setPlaying((current) => !current)}
          >
            <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
            {playing ? "Pause" : "Play all"}
          </button>
        </div>
      ) : null}

      <div className="pit-body">
        <main className="pit-main" hidden={!showThread}>
          <div className="pit-main-inner">
            <div
              className="pit-thread-scroll"
              ref={scrollRef}
              tabIndex={0}
              aria-label="Conversation"
              onScroll={(event) => {
                const element = event.currentTarget;
                const distance =
                  element.scrollHeight - element.scrollTop - element.clientHeight;
                setShowJump(distance > 300);
              }}
            >
              <div className="pit-thread">
                {embeddedEval !== null ? (
                  <div className="pit-eval-boundary" data-phase="execution"><strong>Eval execution</strong></div>
                ) : null}
                {snapshot.turns.length === 0 ? (
                  <section className="pit-empty-thread" data-testid="clean-room-empty">
                    <h2>Start a clean-room chat</h2>
                    <p>
                      This is a blank thread on a brand-new mock tenant:{" "}
                      <strong>{snapshot.issue.identifier}</strong> in{" "}
                      <strong>Mock Paperclip (clean room)</strong>. Nothing has been said, called, or
                      recorded yet.
                    </p>
                    <p className="pit-muted">
                      Your first message starts a real {snapshot.identity.agentLabel.replace(/^Real /, "")} turn through real runnerd. The agent may
                      call the semantic tools this session exposes, and every record it creates lands
                      in the mock control plane only — never a real Paperclip API. Detailed tool,
                      policy, event, and state evidence stays in the Evidence drawer until you open
                      it.
                    </p>
                  </section>
                ) : (
                  snapshot.turns.map((turn) => (
                    <TurnGroup
                      key={turn.id}
                      turn={turn}
                      callbacks={{
                        onOpenEvidence: openEvidence,
                        onRespond: respond,
                        focusInteractionId,
                      }}
                      assertions={Object.fromEntries(embeddedEval?.checks
                        .filter((check) => check.anchor.kind === "item")
                        .map((check) => [check.anchor.id, [{ ...check } satisfies EvalAssertion]]) ?? [])}
                      terminalAssertions={embeddedEval?.checks
                        .filter((check) => check.anchor.kind === "turn" && check.anchor.id === turn.id)
                        .map((check) => ({ ...check })) ?? []}
                    />
                  ))
                )}
                {embeddedEval !== null ? (
                  <div className="pit-eval-boundary" data-phase="post-run">
                    <strong>Post-run state</strong>
                    <span>Final mock control-plane revision {embeddedEval.run.finalRevision}</span>
                    <EvalAssertions assertions={embeddedEval.checks.filter((check) => check.anchor.kind === "run")} />
                  </div>
                ) : null}
              </div>
            </div>
            {showJump ? (
              <button
                type="button"
                className="pit-button pit-jump-pill"
                onClick={() => {
                  const element = scrollRef.current;
                  if (element !== null) element.scrollTop = element.scrollHeight;
                  setShowJump(false);
                }}
              >
                Jump to latest
              </button>
            ) : null}
          </div>

          <Composer
            model={snapshot.composer}
            sessionId={snapshot.sessionId}
            onSend={send}
            onStop={stop}
            onRetry={retry}
            onReset={() => (chat ? newChat() : setConfirmReset(true))}
            resetLabel={chat ? "New chat" : "Reset scenario"}
            onFocusPending={(interactionId) => {
              setFocusInteractionId(interactionId);
              document
                .getElementById(`interaction-${interactionId}`)
                ?.scrollIntoView({ block: "center" });
            }}
          />
        </main>

        {showPanel && layout === "side" ? (
          <div
            className="pit-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the evidence panel"
            aria-valuemin={PANEL_MIN}
            aria-valuemax={PANEL_MAX}
            aria-valuenow={panelWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              const splitter = event.currentTarget;
              splitter.setPointerCapture(event.pointerId);
              const resize = (pointer: PointerEvent) => {
                const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, window.innerWidth - pointer.clientX));
                setPanelWidth(next);
              };
              const finish = () => {
                splitter.removeEventListener("pointermove", resize);
                splitter.removeEventListener("pointerup", finish);
                splitter.removeEventListener("pointercancel", finish);
                setPanelWidth((current) => {
                  persistPanel(panelOpen, current);
                  return current;
                });
              };
              splitter.addEventListener("pointermove", resize);
              splitter.addEventListener("pointerup", finish);
              splitter.addEventListener("pointercancel", finish);
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 64 : 16;
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setPanelWidth((current) => {
                  const next = Math.min(PANEL_MAX, current + step);
                  persistPanel(panelOpen, next);
                  return next;
                });
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                setPanelWidth((current) => {
                  const next = Math.max(PANEL_MIN, current - step);
                  persistPanel(panelOpen, next);
                  return next;
                });
              }
            }}
          />
        ) : null}

        {showPanel ? (
          <EvidencePanel
            snapshot={snapshot}
            evalReport={embeddedEval}
            {...(embeddedEval !== null || (route.mode === "live" && historicSessionId === null) ? { devtools } : {})}
            onForkRevision={(revision) => {
              abandonTurn();
              setActionError(null);
              void capabilityLiveClient.fork(snapshot.sessionId, revision)
                .then((next) => {
                  rememberSession(next.sessionId, chat ? "cleanroom" : "issue");
                  setSnapshot(next.view);
                  setIdentity(next.identity ?? null);
                  setDevtools(null);
                })
                .catch((cause) => setActionError(describe(cause)));
            }}
            layout={layout}
            width={panelWidth}
            selectedTurnId={selectedTurnId}
            openSections={openSections}
            highlightedRecordId={highlightedRecordId}
            onSelectTurn={setSelectedTurnId}
            onToggleSection={(section) =>
              setOpenSections((current) =>
                current.includes(section)
                  ? current.filter((entry) => entry !== section)
                  : [...current, section],
              )
            }
            onClose={closeEvidence}
            onJumpToThread={jumpToThread}
            onInvokeTool={route.mode === "live" && historicSessionId === null ? async (operationId, input) => {
              setActionError(null);
              const next = await capabilityLiveClient.invokeTool(snapshot.sessionId, operationId, input);
              setSnapshot(next.view);
              setSelectedTurnId(next.toolTurnId);
              return next.toolResult;
            } : undefined}
          />
        ) : null}
      </div>

      {confirmReset ? (
        <div className="pit-dialog-backdrop">
          <div
            className="pit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-dialog-title"
            data-testid="reset-dialog"
          >
            <h2 className="pit-dialog-title" id="reset-dialog-title">
              {chat ? "Reset this chat?" : "Reset scenario?"}
            </h2>
            <p>
              {chat
                ? "This stops any active turn, closes this session's authority, and opens a new mock tenant with new identities. The transcript and its mock records will be lost."
                : "This clears the mock state and starts a clean session. The transcript will be lost."}
            </p>
            <div className="pit-button-row">
              <button
                type="button"
                className="pit-button"
                ref={cancelResetRef}
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pit-button"
                data-variant="destructive"
                onClick={reset}
                data-testid="reset-confirm"
              >
                {chat ? "Reset chat" : "Reset scenario"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p
        className="pit-visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="thread-live-region"
      >
        {announcement}
      </p>
    </div>
  );
}
