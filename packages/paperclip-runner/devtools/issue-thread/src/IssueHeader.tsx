import { useEffect, useRef, useState } from "react";

import type { CapabilityIssueThreadSnapshot } from "../../../src/issue-thread/types";
import { Icon } from "./Icons";
import { Chip, PriorityIcon, StatusBadge } from "./primitives";

/**
 * Sticky issue header (contract §1 and §2). The three identity chips are never
 * hidden by scroll, mode is data rather than styling, and on mobile Stop stays
 * outside the overflow menu whenever a turn is active.
 */

export interface IssueHeaderProps {
  snapshot: CapabilityIssueThreadSnapshot;
  scenarios: string[];
  /** `chat` is the clean room: no preset scenario, no recording to replay. */
  surface?: "issue" | "chat";
  /** Immutable eval recordings use the same inspector without live controls. */
  readOnly?: boolean;
  /** Clean-room tenant token, rendered so identity rotation is visible. */
  cleanRoomToken?: string | null;
  evidenceOpen: boolean;
  denialCount: number;
  segment: "thread" | "evidence";
  onToggleEvidence: () => void;
  onSelectScenario: (scenario: string) => void;
  onReplay: () => void;
  onReset: () => void;
  onStop: () => void;
  onSelectSegment: (segment: "thread" | "evidence") => void;
}

export function IssueHeader(props: IssueHeaderProps) {
  const {
    snapshot,
    scenarios,
    surface = "issue",
    readOnly = false,
    cleanRoomToken = null,
    evidenceOpen,
    denialCount,
    segment,
    onToggleEvidence,
    onSelectScenario,
    onReplay,
    onReset,
    onStop,
    onSelectSegment,
  } = props;
  const chat = surface === "chat";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const turnActive = snapshot.composer.state === "streaming" || snapshot.composer.state === "sending";

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <header className="pit-header" data-session-mode={snapshot.mode}>
      <div className="pit-header-primary">
        <div className="pit-header-title-row">
          <span className="pit-identifier">{snapshot.issue.identifier}</span>
          <h1 className="pit-title">{snapshot.issue.title}</h1>
          <StatusBadge status={snapshot.issue.status} />
        </div>
        <div className="pit-header-controls">
          {!chat && !readOnly ? (
            <>
              <label className="pit-visually-hidden" htmlFor="scenario-picker">Scenario</label>
              <select className="pit-select pit-desktop-only" id="scenario-picker" value={snapshot.issue.fixtureProfile} onChange={(event) => onSelectScenario(event.target.value)} data-testid="scenario-picker">
                {scenarios.map((scenario) => <option key={scenario} value={scenario}>{scenario}</option>)}
              </select>
              <button type="button" className="pit-button pit-desktop-only" onClick={onReplay} data-testid="replay-button"><Icon name="play" /> Replay</button>
            </>
          ) : null}
          {!readOnly ? <button type="button" className="pit-icon-button pit-desktop-only" data-variant="destructive" onClick={onReset} data-testid="reset-button" title={chat ? "Reset chat" : "Reset scenario"} aria-label={chat ? "Reset chat" : "Reset scenario"}><Icon name="reset" /></button> : null}
          {!readOnly ? <button type="button" className="pit-icon-button" data-variant="destructive" onClick={onStop} disabled={!turnActive} data-testid="stop-button" title="Stop turn" aria-label="Stop turn"><Icon name="stop" /></button> : null}
          <button type="button" className="pit-button pit-desktop-only" aria-expanded={evidenceOpen} onClick={onToggleEvidence} data-testid="evidence-toggle"><Icon name="evidence" /> DevTools{denialCount > 0 ? ` (${denialCount})` : ""}</button>
        </div>
      </div>

      <div className="pit-header-context">
        <div className="pit-chip-row" data-testid="identity-chips">
        <Chip tone={snapshot.mode === "live" ? "live" : undefined} testId="agent-chip">
          {snapshot.identity.agentLabel}
          {snapshot.identity.replaySource !== null
            ? ` · ${snapshot.identity.replaySource} source`
            : ""}
        </Chip>
        <Chip testId="runner-chip">
          <span
            className="pit-process-dot"
            data-attached={snapshot.identity.runnerAttached}
            aria-hidden="true"
          />
          {snapshot.identity.runnerLabel}
          <span className="pit-visually-hidden">
            {snapshot.identity.runnerAttached ? "attached" : "detached"}
          </span>
        </Chip>
        <Chip tone="mock" title={snapshot.identity.controlPlaneTooltip} testId="control-plane-chip">
          {snapshot.identity.controlPlaneLabel}
        </Chip>
        {chat && cleanRoomToken !== null ? (
          <Chip tone="accent" testId="clean-room-identity">
            Clean room {cleanRoomToken}
          </Chip>
        ) : null}
        </div>
        <PriorityIcon priority={snapshot.issue.priority} />
        {snapshot.issue.assignee !== null ? <span className="pit-assignee">{snapshot.issue.assignee}</span> : null}
        <span className="pit-run-state" title={snapshot.issue.runState}>{snapshot.issue.runState}</span>

        <div className="pit-menu pit-mobile-only" ref={menuRef}>
          <button
            type="button"
            className="pit-button"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((current) => !current)}
            data-testid="overflow-menu-button"
          >
            <span aria-hidden="true">⋯</span>
            <span className="pit-visually-hidden">More actions</span>
          </button>
          {menuOpen ? (
            <div className="pit-menu-list" role="menu" data-testid="overflow-menu">
              {chat ? null : (
                <>
                  <label className="pit-menu-item" htmlFor="scenario-picker-mobile">
                    Scenario
                    <select
                      className="pit-select"
                      id="scenario-picker-mobile"
                      value={snapshot.issue.fixtureProfile}
                      onChange={(event) => {
                        setMenuOpen(false);
                        onSelectScenario(event.target.value);
                      }}
                    >
                      {scenarios.map((scenario) => (
                        <option key={scenario} value={scenario}>
                          {scenario}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    role="menuitem"
                    className="pit-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onReplay();
                    }}
                  >
                    Replay
                  </button>
                </>
              )}
              <button
                type="button"
                role="menuitem"
                className="pit-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onReset();
                }}
              >
                {chat ? "Reset chat" : "Reset scenario"}
              </button>
            </div>
          ) : null}
        </div>

      </div>

      <div className="pit-segmented" role="tablist" aria-label="Thread or evidence">
        <button
          type="button"
          role="tab"
          className="pit-segment"
          aria-selected={segment === "thread"}
          onClick={() => onSelectSegment("thread")}
          data-testid="segment-thread"
        >
          Thread
        </button>
        <button
          type="button"
          role="tab"
          className="pit-segment"
          aria-selected={segment === "evidence"}
          onClick={() => onSelectSegment("evidence")}
          data-testid="segment-evidence"
        >
          Evidence
          {denialCount > 0 ? (
            <span className="pit-segment-badge" data-testid="segment-denial-badge">
              {denialCount}
            </span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
