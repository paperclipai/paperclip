import * as React from "react";

import type { CapabilityChatTurn } from "@paperclip-runner-local/capability";

import { ParityStatusBadge } from "./primitives.js";

/**
 * Per-turn activity strip (7I map §3).
 *
 * The guaranteed bridge from a turn to its evidence: whatever the board is
 * reading in the conversation, the strip below it says what that turn actually
 * did and opens the matching activity group. Counts are icon plus text — never
 * colour alone — so the strip is readable before anything is opened.
 */
export function TurnStrip({
  turn,
  onOpen,
  active,
}: {
  turn: CapabilityChatTurn;
  onOpen: (turn: number) => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className="pcr7-turn-strip"
      data-testid={`turn-activity-strip-${turn.turn}`}
      data-active={active === true}
      aria-label={`Turn ${turn.turn} activity — ${summaryText(turn)}. Open the activity stream.`}
      onClick={() => onOpen(turn.turn)}
    >
      <span className="pcr7-turn-strip-label">
        {turn.turn === 0 ? "Session seed activity" : `Turn ${turn.turn} activity`}
      </span>
      <span className="pcr7-turn-strip-counts">
        <Count icon="⚙" label={plural(turn.counts.calls, "tool")} value={turn.counts.calls} />
        {turn.counts.denied === 0 ? null : (
          <Count icon="✕" label="denied" value={turn.counts.denied} tone="danger" />
        )}
        <Count icon="⌘" label="control plane" value={turn.counts.controlPlane} />
        <Count
          icon="Δ"
          label={plural(turn.counts.changedDomains, "domain")}
          value={turn.counts.changedDomains}
        />
        <ParityStatusBadge status={turn.parity.verdict} testId={`turn-parity-${turn.turn}`} />
      </span>
    </button>
  );
}

function Count({
  icon,
  label,
  value,
  tone,
}: {
  icon: string;
  label: string;
  value: number;
  tone?: "danger";
}) {
  return (
    <span className="pcr7-turn-count" data-tone={tone ?? "neutral"}>
      <span aria-hidden="true">{icon}</span> {value} {label}
    </span>
  );
}

export function summaryText(turn: CapabilityChatTurn): string {
  const parts = [
    `${turn.counts.calls} ${plural(turn.counts.calls, "tool")}`,
    `${turn.counts.denied} denied`,
    `${turn.counts.controlPlane} control plane`,
    `diff ${turn.counts.changedDomains} ${plural(turn.counts.changedDomains, "domain")}`,
  ];
  return `${parts.join(", ")}, parity ${turn.parity.verdict.replace("_", " ")}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
