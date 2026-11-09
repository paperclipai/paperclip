import * as React from "react";

import type { ComposerState } from "../../browser/transcript-model.js";
import { Button } from "./button.js";

const MAX_ROWS = 8;
const PRIMARY_LABEL: Record<ComposerState, string> = {
  idle: "Send",
  submitting: "Sending…",
  "active-turn": "Steer",
  interrupting: "Stopping…",
  disconnected: "Send",
  terminal: "Send",
};
const HINT: Record<ComposerState, string> = {
  idle: "Enter sends. Shift and Enter add a line.",
  submitting: "Waiting for the turn to be accepted.",
  "active-turn": "Enter steers the running turn. Escape moves focus to Stop.",
  interrupting: "Stopping the turn. Waiting for the terminal turn event.",
  disconnected: "The composer is disabled until the connection is restored.",
  terminal: "This session is closed. Replay it or reset the session state.",
};

export function Composer({
  state,
  value,
  onValueChange,
  onSubmit,
  onStop,
  disabledReason = null,
  label = "Message",
  leadingActions,
  trailingActions,
}: {
  state: ComposerState;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  disabledReason?: string | null;
  label?: string;
  leadingActions?: React.ReactNode;
  trailingActions?: React.ReactNode;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const stopRef = React.useRef<HTMLButtonElement>(null);
  const inputId = React.useId();
  const hintId = React.useId();
  const reasonId = React.useId();
  const locked = disabledReason !== null || ["submitting", "interrupting", "disconnected", "terminal"].includes(state);
  const canStop = state === "active-turn" || state === "submitting";

  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.rows = Math.max(Math.min(value.split("\n").length, MAX_ROWS), 2);
  }, [value]);

  return (
    <div data-slot="composer" data-state={state} className="pcr-composer">
      <label className="pcr-visually-hidden" htmlFor={inputId}>{label}</label>
      <textarea
        ref={textareaRef}
        id={inputId}
        className="pcr-composer-input"
        data-testid="composer-input"
        rows={2}
        value={value}
        disabled={locked}
        aria-describedby={disabledReason === null ? hintId : `${hintId} ${reasonId}`}
        placeholder={state === "active-turn" ? "Steer the running turn…" : "Send a message…"}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!locked && value.trim().length > 0) onSubmit();
          } else if (event.key === "Escape" && canStop) {
            event.preventDefault();
            stopRef.current?.focus();
          }
        }}
      />
      <div className="pcr-composer-actions">
        <div className="pcr-composer-leading">{leadingActions}</div>
        <p id={hintId} className="pcr-composer-hint">{HINT[state]}</p>
        {disabledReason === null ? null : <p id={reasonId} className="pcr-composer-reason">{disabledReason}</p>}
        <div className="pcr-composer-buttons">
          <Button ref={stopRef} type="button" variant="danger" data-testid="composer-stop" disabled={!canStop} onClick={onStop}>Stop</Button>
          <Button type="button" data-testid="composer-send" disabled={locked || value.trim().length === 0} onClick={onSubmit}>{PRIMARY_LABEL[state]}</Button>
          {trailingActions}
        </div>
      </div>
    </div>
  );
}
