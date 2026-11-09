import * as React from "react";

import { Badge, Button } from "@paperclipai/paperclip-runner/react";
import type {
  CapabilityChatSessionArtifact,
  CapabilityScenarioIndexEntry,
} from "@paperclip-runner-local/capability";

import { groupLabel } from "../labels.js";
import { DispositionBadge, Mono, ParityStatusBadge } from "./primitives.js";

/**
 * Session header (7I map §2).
 *
 * Says what session this is, what is driving it, and how it has fared so far —
 * and offers the two session-scoped controls, reset and replay. Reset is
 * destructive and confirms; replay is not, because it reproduces an identical
 * timeline.
 */

export type CapabilityChatMode = "scripted" | "codex";

export interface SessionHeaderProps {
  entry: CapabilityScenarioIndexEntry;
  artifact: CapabilityChatSessionArtifact | null;
  mode: CapabilityChatMode;
  codexAvailable: boolean;
  busy: boolean;
  onModeChange: (mode: CapabilityChatMode) => void;
  onReset: () => void;
  onReplay: () => void;
  onOpenParity: () => void;
  headerRef?: React.Ref<HTMLElement>;
}

export function SessionHeader({
  entry,
  artifact,
  mode,
  codexAvailable,
  busy,
  onModeChange,
  onReset,
  onReplay,
  onOpenParity,
  headerRef,
}: SessionHeaderProps) {
  const status = sessionStatus(artifact, mode);
  const completed = artifact?.turns.filter((turn) => turn.turn > 0) ?? [];
  const failing = completed.find((turn) => turn.parity.verdict === "fail");
  // Controls that would corrupt a running turn are disabled with the reason
  // named, never silently inert.
  const busyReason = busy ? "A turn is running — wait for it to settle." : undefined;
  const runningControlsReasonId = "running-controls-reason";
  const codexUnavailableReasonId = "codex-unavailable-reason";

  return (
    <header ref={headerRef} className="pcr7-session-header" data-testid="session-header" tabIndex={-1}>
      <div className="pcr7-run-title">
        <Mono>{entry.id}</Mono>
        <h1>{entry.title}</h1>
      </div>

      <div className="pcr7-badge-row">
        <Badge tone="neutral">
          {groupLabel(entry.group)} <Mono>{entry.group}</Mono>
        </Badge>
        <DispositionBadge disposition={entry.primaryDisposition} />
        <Badge tone={status.tone} data-testid="session-status">
          {status.label}
        </Badge>
        {completed.length === 0 ? null : (
          <button
            type="button"
            className="pcr7-linkish"
            data-testid="session-parity-chip"
            onClick={onOpenParity}
          >
            <ParityStatusBadge
              status={failing === undefined ? "pass" : "fail"}
              testId="session-parity-status"
            />{" "}
            {failing === undefined
              ? `Parity · ${completed.length} turn${completed.length === 1 ? "" : "s"} pass`
              : `Parity · turn ${failing.turn} fail`}
          </button>
        )}
      </div>

      <div className="pcr7-run-controls">
        <div
          className="pcr7-segmented"
          role="radiogroup"
          aria-label="Session driver"
          data-testid="chat-mode-toggle"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === "scripted"}
            aria-describedby={busy ? runningControlsReasonId : undefined}
            disabled={busy}
            data-testid="chat-mode-scripted"
            onClick={() => onModeChange("scripted")}
          >
            Scripted (deterministic)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "codex"}
            aria-describedby={
              busy ? runningControlsReasonId : !codexAvailable ? codexUnavailableReasonId : undefined
            }
            disabled={busy || !codexAvailable}
            data-testid="chat-mode-codex"
            title={
              codexAvailable
                ? "Drive the session through the local provider relay"
                : "provider relay not running — see tutorial §4"
            }
            onClick={() => onModeChange("codex")}
          >
            Codex (bounded)
          </button>
        </div>
        {codexAvailable ? null : (
          <p
            id={codexUnavailableReasonId}
            className="pcr7-muted"
            data-testid="chat-codex-unavailable"
          >
            Codex mode needs the local provider relay — provider relay not running, see tutorial §4.
            Scripted mode drives the same mock control plane offline, and no provider credential
            ever reaches this page.
          </p>
        )}

        <Button
          type="button"
          variant="ghost"
          onClick={onReset}
          disabled={busy}
          aria-describedby={busy ? runningControlsReasonId : undefined}
          title={busyReason}
          data-testid="reset-session"
        >
          Reset session
        </Button>
        <Button
          type="button"
          onClick={onReplay}
          disabled={busy || (artifact?.remainingScriptedTurns ?? 0) === 0}
          aria-describedby={busy ? runningControlsReasonId : undefined}
          title={
            busyReason ??
            ((artifact?.remainingScriptedTurns ?? 0) === 0
              ? "The scripted session has already played to the end."
              : undefined)
          }
          data-testid="replay-session"
        >
          Replay scripted session
        </Button>
        {busy ? (
          <p
            id={runningControlsReasonId}
            className="pcr7-muted"
            data-testid="running-controls-reason"
          >
            Controls return when the turn settles.
          </p>
        ) : null}
      </div>
    </header>
  );
}

function sessionStatus(
  artifact: CapabilityChatSessionArtifact | null,
  mode: CapabilityChatMode,
): { label: string; tone: "accent" | "neutral" | "danger" } {
  if (artifact === null) return { label: "Seeding…", tone: "neutral" };
  if (artifact.status === "failed") return { label: "Harness error", tone: "danger" };
  if (artifact.turns.length <= 1) return { label: "Idle · seeded", tone: "neutral" };
  return mode === "codex"
    ? { label: "Live · Codex (bounded)", tone: "accent" }
    : { label: "Scripted · deterministic", tone: "neutral" };
}
