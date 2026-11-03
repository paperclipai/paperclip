import * as React from "react";

import { Tabs, type TabDefinition } from "@paperclipai/paperclip-runner/react";
import {
  capabilityRunScenario,
  type CapabilityChatSessionArtifact,
  type CapabilityEvalSuiteLookup,
  type CapabilityParityStatus,
  type CapabilityRunArtifact,
  type CapabilityScenarioIndex,
  type CapabilityScenarioIndexEntry,
} from "@paperclip-runner-local/capability";

import {
  AuthorizationPanel,
  ContextPanel,
  denialCount,
  ParityPanel,
  StateDiffPanel,
} from "./components/inspector-panels.js";
import { buildFacets, ScenarioPicker, type CapabilityPickerFacets } from "./components/scenario-picker.js";
import { RunHeader } from "./components/run-header.js";
import { ScenarioTranscript } from "./components/scenario-transcript.js";
import { EmptyState, Mono } from "./components/primitives.js";
import {
  ChatSurface,
  type OpenCapabilityChatSession,
  type CapabilityChatState,
} from "./components/chat-surface.js";
import {
  ActivityEmptyState,
  ActivityStream,
  activityDenialCount,
} from "./components/chat-activity-stream.js";
import { DISPOSITION_LABEL } from "./labels.js";
import {
  EMPTY_FILTERS,
  parseCapabilityRoute,
  serializeCapabilityRoute,
  type CapabilityActivityFilter,
  type CapabilityFilters,
  type ScenarioChatnspectorView,
  type CapabilityRoute,
} from "./route.js";

/**
 * Capability scenario explorer shell.
 *
 * One React tree, three regions: picker (nav), run view (main), inspector
 * (complementary). The shell owns route and view state only — never protocol
 * state, never a policy decision, never a credential.
 */

export interface ExplorerAppProps {
  index: CapabilityScenarioIndex;
  evalSuite?: CapabilityEvalSuiteLookup;
  /** Injected so tests can drive a settled state without a live relay probe. */
  codexAvailable?: boolean;
  initialRoute?: CapabilityRoute;
  /** Test seam: run scenarios synchronously through an injected runner. */
  runScenario?: typeof capabilityRunScenario;
  /** Test seam: open chat sessions through an injected session factory. */
  openSession?: OpenCapabilityChatSession;
}

type RunState = "idle" | "pending" | "settled" | "failed";
/**
 * Mobile segments. The explorer and the chat are two surfaces in one shell, so
 * they share the segmented-control mechanism but never its labels: "Run" and
 * "Chat" are different jobs and must not look like the same tab renamed.
 */
type Segment = "scenarios" | "run" | "inspect" | "chat" | "activity";

const EXPLORER_SEGMENTS = ["scenarios", "run", "inspect"] as const;
const CHAT_SEGMENTS = ["scenarios", "chat", "activity"] as const;

const SEGMENT_LABEL: Record<Segment, string> = {
  scenarios: "Scenarios",
  run: "Run",
  inspect: "Inspect",
  chat: "Chat",
  activity: "Activity",
};

const INSPECTOR_TABS: readonly TabDefinition[] = [
  { id: "context", label: "Context" },
  { id: "authorization", label: "Authorization" },
  { id: "diff", label: "State diff" },
  { id: "parity", label: "Parity" },
];

export function ExplorerApp({
  index,
  evalSuite,
  codexAvailable = false,
  initialRoute,
  runScenario = capabilityRunScenario,
  openSession,
}: ExplorerAppProps) {
  const [route, setRoute] = React.useState<CapabilityRoute>(
    () => initialRoute ?? parseCapabilityRoute(typeof window === "undefined" ? "#/" : window.location.hash),
  );
  const [artifacts, setArtifacts] = React.useState<Record<string, CapabilityRunArtifact>>({});
  const [runState, setRunState] = React.useState<RunState>("idle");
  const [mode, setMode] = React.useState<"fake" | "codex">(route.run ?? "fake");
  const [segment, setSegment] = React.useState<Segment>(() => defaultSegment(route));
  const [replayPosition, setReplayPosition] = React.useState(0);
  const [highlight, setHighlight] = React.useState<number | null>(null);
  const [runFocusRequest, setRunFocusRequest] = React.useState(0);
  const [chatArtifact, setChatArtifact] = React.useState<CapabilityChatSessionArtifact | null>(null);
  const [chatRevealedSequence, setChatRevealedSequence] = React.useState(0);
  const [chatState, setChatState] = React.useState<CapabilityChatState>("seeding");
  const [stripFocusRequest, setStripFocusRequest] = React.useState({ turn: 0, nonce: 0 });
  const shellRef = React.useRef<HTMLDivElement>(null);
  const runHeaderRef = React.useRef<HTMLElement>(null);

  const selected = route.caseId === null ? null : findEntry(index, route.caseId);
  const artifact = selected === null ? null : (artifacts[selected.id] ?? null);

  const navigate = React.useCallback((next: CapabilityRoute) => {
    setRoute(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", serializeCapabilityRoute(next));
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onHashChange = (): void => setRoute(parseCapabilityRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // A deep link that arrives while the app is already open (hash change, back
  // button) has to move the mobile segment too, or the route says "parity"
  // while the screen still shows the picker.
  React.useEffect(() => {
    setSegment(defaultSegment(route));
  }, [route.caseId, route.chatView, route.surface, route.view]);

  React.useEffect(() => {
    if (runFocusRequest === 0 || selected === null) return;
    runHeaderRef.current?.focus();
  }, [runFocusRequest, selected]);

  React.useEffect(() => {
    if (stripFocusRequest.nonce === 0) return;
    document
      .querySelector<HTMLButtonElement>(
        `[data-testid="turn-activity-strip-${stripFocusRequest.turn}"]`,
      )
      ?.focus();
  }, [stripFocusRequest]);

  React.useEffect(() => {
    const cycleRegions = (event: KeyboardEvent): void => {
      const documentedAlternative = event.ctrlKey && event.code === "Period";
      if (event.code !== "F6" && !documentedAlternative) return;
      const regions = shellRef.current?.querySelectorAll<HTMLElement>(
        ".pcr7-rail, .pcr7-center, .pcr7-inspector",
      );
      if (regions === undefined || regions.length === 0) return;
      event.preventDefault();
      const current = [...regions].findIndex((region) => region.contains(document.activeElement));
      const delta = event.shiftKey ? -1 : 1;
      const next = current < 0
        ? event.shiftKey
          ? regions.length - 1
          : 0
        : (current + delta + regions.length) % regions.length;
      regions[next]?.focus();
    };
    document.addEventListener("keydown", cycleRegions, true);
    return () => document.removeEventListener("keydown", cycleRegions, true);
  }, []);

  const run = React.useCallback(
    async (entry: CapabilityScenarioIndexEntry) => {
      setRunState("pending");
      try {
        const next = await runScenario(entry, { mode: "fake", evalSuite });
        setArtifacts((current) => ({ ...current, [entry.id]: next }));
        setReplayPosition(next.timeline.length);
        setRunState(next.failure === null ? "settled" : "failed");
      } catch (error) {
        setRunState("failed");
        throw error;
      }
    },
    [evalSuite, runScenario],
  );

  // `run=fake` auto-executes so a screenshot route settles without interaction.
  React.useEffect(() => {
    if (selected === null || route.run !== "fake") return;
    if (artifacts[selected.id] !== undefined || runState === "pending") return;
    void run(selected);
  }, [artifacts, route.run, run, runState, selected]);

  const parityStatus = React.useCallback(
    (id: string): CapabilityParityStatus => artifacts[id]?.parity.verdict ?? "not_run",
    [artifacts],
  );

  const visible = React.useMemo(
    () => index.entries.filter((entry) => matches(entry, route.filters, parityStatus)),
    [index.entries, parityStatus, route.filters],
  );

  const facets = React.useMemo<CapabilityPickerFacets>(
    () =>
      buildFacets(index.entries, (key, value) => {
        const probe: CapabilityFilters = {
          ...route.filters,
          [key === "parity" ? "parity" : key]: value,
        };
        return index.entries.filter((entry) => matches(entry, probe, parityStatus)).length;
      }),
    [index.entries, parityStatus, route.filters],
  );

  const timeline = artifact === null ? [] : artifact.timeline.slice(0, replayPosition);
  const settled =
    selected === null
      ? "settled"
      : route.run === null
        ? "settled"
        : runState === "settled" || runState === "failed"
          ? "settled"
          : "pending";

  const view: ScenarioChatnspectorView = route.view;
  const inspectorTab = view === "transcript" ? "context" : view;

  function selectCase(id: string): void {
    navigate({ ...route, caseId: id, filters: route.filters });
    setSegment("run");
    setReplayPosition(artifacts[id]?.timeline.length ?? 0);
  }

  function commitCase(id: string): void {
    selectCase(id);
    setRunFocusRequest((request) => request + 1);
  }

  function setView(next: ScenarioChatnspectorView): void {
    navigate({ ...route, view: next });
    if (next !== "transcript") setSegment("inspect");
  }

  function setFilters(patch: Partial<CapabilityFilters>): void {
    // Narrowing the picker must not end a live chat session, so the chat
    // surface keeps its case while the explorer still returns to the corpus.
    const caseId = route.surface === "chat" ? route.caseId : null;
    navigate({ ...route, caseId, filters: { ...route.filters, ...patch } });
    setSegment("scenarios");
  }

  function setChatView(next: "chat" | "activity"): void {
    navigate({ ...route, chatView: next });
  }

  function openTurn(turn: number): void {
    navigate({ ...route, chatView: "activity", turn });
    setSegment("activity");
  }

  function backToChat(turn: number): void {
    navigate({ ...route, chatView: "chat", turn });
    setSegment("chat");
    // Focus after the commit: on mobile the strip is still hidden at this point.
    setStripFocusRequest((request) => ({ turn, nonce: request.nonce + 1 }));
  }

  const chat = route.surface === "chat";
  const denials = chatArtifact === null ? 0 : activityDenialCount(chatArtifact);

  return (
    <div
      ref={shellRef}
      className="pcr-root pcr7-shell"
      data-run-state={settled}
      data-surface={route.surface}
      data-chat-state={chat && selected !== null ? chatState : undefined}
      data-segment={segment}
      data-testid="explorer-shell"
      aria-keyshortcuts="F6 Control+."
    >
      <a className="pcr7-skip-link" href="#run-view">
        Skip to {chat ? "the chat" : "run view"}
      </a>

      <nav className="pcr7-surface-nav" aria-label="Surfaces" data-testid="surface-nav">
        <button
          type="button"
          className="pcr7-chip"
          aria-pressed={!chat}
          data-testid="surface-explorer"
          onClick={() => navigate({ ...route, surface: "explorer" })}
        >
          Scenario explorer
        </button>
        <button
          type="button"
          className="pcr7-chip"
          aria-pressed={chat}
          data-testid="surface-chat"
          onClick={() => navigate({ ...route, surface: "chat" })}
        >
          Scenario chat
        </button>
      </nav>
      <p className="pcr7-visually-hidden">
        Region shortcut: press F6, or Control+Period when the browser reserves F6, to cycle the
        scenario picker, run view, and inspector.
      </p>

      {/*
        A radiogroup, not a tablist: the three regions stay landmarks
        (nav / main / complementary) rather than becoming tabpanels, and the
        page keeps exactly one tablist — the inspector's.
      */}
      <div
        className="pcr7-segmented pcr7-segmented--mobile"
        role="radiogroup"
        aria-label={chat ? "Chat sections" : "Explorer sections"}
      >
        {(chat ? CHAT_SEGMENTS : EXPLORER_SEGMENTS).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={segment === value}
            data-testid={`segment-${value}`}
            onClick={() => {
              setSegment(value);
              if (chat && (value === "chat" || value === "activity")) setChatView(value);
            }}
          >
            {SEGMENT_LABEL[value]}
            {chat && value === "activity" && denials > 0 ? (
              <span className="pcr7-segment-chip" data-testid="segment-activity-denials">
                {" "}
                · {denials} deny
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="pcr7-columns">
        <ScenarioPicker
          entries={index.entries}
          visible={visible}
          facets={facets}
          filters={route.filters}
          selectedId={selected?.id ?? null}
          parityStatus={parityStatus}
          onFilterChange={setFilters}
          onClearFilters={() => setFilters(EMPTY_FILTERS)}
          onSelect={selectCase}
          onCommitSelection={commitCase}
        />

        <main
          className="pcr7-center"
          id="run-view"
          aria-label={chat ? "Scenario chat" : "Scenario run"}
          tabIndex={-1}
        >
          {route.caseId !== null && selected === null ? (
            <UnknownScenarioCard
              caseId={route.caseId}
              onBack={() => {
                navigate({ ...route, caseId: null, run: null, view: "transcript" });
                setSegment("scenarios");
              }}
            />
          ) : selected === null ? (
            <IntroCard index={index} chat={chat} onSelect={selectCase} />
          ) : chat ? (
            <ChatSurface
              entry={selected}
              autoReplay={route.replay === "fake"}
              stageStreaming={route.stage === "streaming"}
              codexAvailable={codexAvailable}
              activeTurn={route.turn}
              onOpenTurn={openTurn}
              onOpenParity={() => openTurn(chatArtifact?.turns.at(-1)?.turn ?? 0)}
              onArtifactChange={setChatArtifact}
              onRevealSequenceChange={setChatRevealedSequence}
              onStateChange={setChatState}
              onCancelScenarioSwitch={(entryId) => navigate({ ...route, caseId: entryId })}
              openSession={openSession}
              headerRef={runHeaderRef}
            />
          ) : (
            <>
              <RunHeader
                entry={selected}
                artifact={artifact}
                runState={runState}
                codexAvailable={codexAvailable}
                mode={mode}
                replay={{
                  active: artifact !== null,
                  position: replayPosition,
                  length: artifact?.timeline.length ?? 0,
                  playing: false,
                  enter: () => setReplayPosition(0),
                  exit: () => setReplayPosition(artifact?.timeline.length ?? 0),
                  setPosition: setReplayPosition,
                  togglePlay: () => setReplayPosition(artifact?.timeline.length ?? 0),
                  step: (delta) =>
                    setReplayPosition((current) =>
                      Math.min(Math.max(current + delta, 0), artifact?.timeline.length ?? 0),
                    ),
                }}
                onRun={() => void run(selected)}
                onModeChange={setMode}
                onOpenParity={() => setView("parity")}
                headerRef={runHeaderRef}
              />
              <p className="pcr7-visually-hidden" role="status" aria-live="polite">
                {runState === "settled"
                  ? `Scenario run settled — verdict ${artifact?.parity.verdict ?? "not run"}`
                  : runState === "pending"
                    ? "Scenario run in progress"
                    : ""}
              </p>
              {artifact === null ? (
                <EmptyState title="Run to produce the deterministic timeline.">
                  <p className="pcr7-muted">
                    Fake mode runs entirely in this page against checked-in fixtures. No Paperclip
                    service is contacted and no credential is held.
                  </p>
                </EmptyState>
              ) : (
                <ScenarioTranscript
                  timeline={timeline}
                  highlightSequence={highlight}
                  onSelectSequence={setHighlight}
                />
              )}
            </>
          )}
        </main>

        <aside
          className="pcr7-inspector"
          aria-label={chat ? "Turn activity" : "Scenario inspector"}
          tabIndex={-1}
        >
          {chat ? (
            selected === null || chatArtifact === null ? (
              <ActivityEmptyState />
            ) : (
              <ActivityStream
                artifact={chatArtifact}
                revealedSequence={chatRevealedSequence}
                filter={route.activityFilter}
                onFilterChange={(filter: CapabilityActivityFilter) =>
                  navigate({ ...route, activityFilter: filter })
                }
                openTurn={route.turn}
                onOpenTurn={openTurn}
                onBackToChat={backToChat}
                showBackToChat={segment === "activity"}
              />
            )
          ) : selected === null ? (
            <CorpusSummary index={index} />
          ) : (
            <InspectorTabs
              items={INSPECTOR_TABS.map((tab) =>
                tab.id === "authorization" && artifact !== null
                  ? {
                      ...tab,
                      label: `Authorization${
                        denialCount(artifact.authorizationRecords) === 0
                          ? ""
                          : ` · ${denialCount(artifact.authorizationRecords)} deny`
                      }`,
                    }
                  : tab,
              )}
              selected={inspectorTab}
              onSelect={(value) => setView(value as ScenarioChatnspectorView)}
              label="Scenario inspector"
            >
              {inspectorTab === "context" ? (
                <ContextPanel entry={selected} artifact={artifact} />
              ) : inspectorTab === "authorization" ? (
                <AuthorizationPanel
                  records={artifact?.authorizationRecords ?? []}
                  onSelectRecord={setHighlight}
                />
              ) : inspectorTab === "diff" ? (
                <StateDiffPanel diff={artifact?.diff ?? null} />
              ) : (
                <ParityPanel parity={artifact?.parity ?? null} />
              )}
            </InspectorTabs>
          )}
        </aside>
      </div>
    </div>
  );
}

function InspectorTabs(props: React.ComponentProps<typeof Tabs>) {
  const assignTestIds = React.useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    for (const tab of node.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]')) {
      tab.setAttribute("data-testid", `inspector-tab-${tab.dataset.tabId}`);
    }
  }, []);
  return (
    <div ref={assignTestIds} data-testid="inspector-tabs">
      <Tabs {...props} />
    </div>
  );
}

function UnknownScenarioCard({ caseId, onBack }: { caseId: string; onBack: () => void }) {
  return (
    <section className="pcr7-intro" role="alert" data-testid="unknown-scenario">
      <p className="pcr-eyebrow">Scenario not found</p>
      <h1>No scenario named <Mono>{caseId}</Mono></h1>
      <p>The route does not match a case in this generated scenario index.</p>
      <a
        className="pcr7-linkish"
        href="#/"
        onClick={(event) => {
          event.preventDefault();
          onBack();
        }}
      >
        Back to the scenario picker
      </a>
    </section>
  );
}

function IntroCard({
  index,
  chat,
  onSelect,
}: {
  index: CapabilityScenarioIndex;
  chat: boolean;
  onSelect: (id: string) => void;
}) {
  const examples = ["hb-scoped-wake-01", "ap-mcp-gate-01", "rs-question-only-01"].filter((id) =>
    index.entries.some((entry) => entry.id === id),
  );
  return (
    <section className="pcr7-intro" data-testid="explorer-intro">
      <p className="pcr-eyebrow">
        Capability scenario {chat ? "chat" : "explorer"} — mock control plane
      </p>
      <h1>{index.entries.length} scenarios across {index.groups.length} eval groups</h1>
      <p>
        Every scenario runs against the deterministic, package-local mock control plane. The
        {chat ? " chat" : " explorer"} renders records the runtime produced: it holds no credential,
        decides no policy, and owns no control-plane state.
      </p>
      <p className="pcr7-label">
        {chat
          ? "Pick a scenario to start chatting, or start here"
          : "Pick a scenario from the rail, or start here"}
      </p>
      <ul className="pcr7-exposure" data-testid="intro-examples">
        {examples.map((id) => (
          <li key={id}>
            <button type="button" className="pcr7-linkish" onClick={() => onSelect(id)}>
              <Mono>{id}</Mono>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The inspector before a scenario is picked. Corpus stats keep the panel
 * useful instead of leaving a dead column (UX map §6, "no dead panels").
 */
function CorpusSummary({ index }: { index: CapabilityScenarioIndex }) {
  const byDisposition = (["control_plane_owned", "always_agent_tool", "optional_agent_tool"] as const).map(
    (disposition) => ({
      disposition,
      label: DISPOSITION_LABEL[disposition],
      count: index.entries.filter((entry) => entry.primaryDisposition === disposition).length,
    }),
  );
  return (
    <div className="pcr7-panel" data-testid="corpus-summary">
      <section className="pcr7-panel-section">
        <h3>Corpus</h3>
        <dl className="pcr7-detail-list">
          <dt>Scenarios</dt>
          <dd>{index.entries.length}</dd>
          <dt>Eval groups</dt>
          <dd>{index.groups.length}</dd>
          {byDisposition.map((row) => (
            <React.Fragment key={row.disposition}>
              <dt>{row.label}</dt>
              <dd>{row.count}</dd>
            </React.Fragment>
          ))}
        </dl>
      </section>
      <section className="pcr7-panel-section">
        <h3>Boundary</h3>
        <p className="pcr7-muted">
          The explorer receives snapshots and records only. It owns no credential, no policy
          decision, and no mutable control-plane state; every allow, deny, and redaction on screen
          was emitted by the mock core.
        </p>
      </section>
      <EmptyState title="Pick a scenario to inspect." />
    </div>
  );
}

/**
 * Which region a route should land on when the viewport only shows one. A deep
 * link that says "activity" has to move the segment too, or the route claims
 * one thing while the screen shows another.
 */
function defaultSegment(route: CapabilityRoute): Segment {
  if (route.caseId === null) return "scenarios";
  if (route.surface === "chat") return route.chatView === "activity" ? "activity" : "chat";
  return route.view === "transcript" ? "run" : "inspect";
}

function findEntry(index: CapabilityScenarioIndex, id: string): CapabilityScenarioIndexEntry | null {
  return index.entries.find((entry) => entry.id === id) ?? null;
}

export function matches(
  entry: CapabilityScenarioIndexEntry,
  filters: CapabilityFilters,
  parityStatus: (id: string) => string,
): boolean {
  if (filters.group !== null && filters.group.length > 0 && entry.group !== filters.group) return false;
  if (
    filters.disposition !== null &&
    filters.disposition.length > 0 &&
    entry.primaryDisposition !== filters.disposition
  ) {
    return false;
  }
  if (filters.role !== null && filters.role.length > 0 && entry.actorRole !== filters.role) return false;
  if (
    filters.claim !== null &&
    filters.claim.length > 0 &&
    !entry.requiredGrants.includes(filters.claim)
  ) {
    return false;
  }
  if (
    filters.parity !== null &&
    filters.parity.length > 0 &&
    parityStatus(entry.id) !== filters.parity
  ) {
    return false;
  }
  if (filters.query.length > 0) {
    const needle = filters.query.toLowerCase();
    if (!`${entry.id} ${entry.title}`.toLowerCase().includes(needle)) return false;
  }
  return true;
}
