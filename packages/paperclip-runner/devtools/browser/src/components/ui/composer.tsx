import * as React from "react";

import type { ComposerState } from "../../live/transcript-model";
import { Button } from "./button";

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
  terminal: "This session is closed. Replay it or reset the demo state.",
};

/**
 * Source-adapted AI Elements `PromptInput`. The textarea plus action-row
 * anatomy and submit-on-Enter are kept; the Send/Steer/Stop tri-state comes
 * from the runner protocol, and there are no attachments or model pickers.
 */
export function Composer({
  state,
  value,
  onValueChange,
  onSubmit,
  onStop,
  disabledReason = null,
  label = "Message",
}: {
  state: ComposerState;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  disabledReason?: string | null;
  label?: string;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const stopRef = React.useRef<HTMLButtonElement>(null);
  const inputId = React.useId();
  const hintId = React.useId();
  const reasonId = React.useId();

  const locked =
    disabledReason !== null ||
    state === "submitting" ||
    state === "interrupting" ||
    state === "disconnected" ||
    state === "terminal";
  const canStop = state === "active-turn" || state === "submitting";

  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.rows = 1;
    const rows = Math.min(value.split("\n").length, MAX_ROWS);
    textarea.rows = Math.max(rows, 2);
  }, [value]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!locked && value.trim().length > 0) onSubmit();
      return;
    }
    // Escape never interrupts directly; it only moves focus to Stop.
    if (event.key === "Escape" && canStop) {
      event.preventDefault();
      stopRef.current?.focus();
    }
  }

  return (
    <div data-slot="composer" data-state={state} className="ui-composer">
      <label className="ui-visually-hidden" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        ref={textareaRef}
        id={inputId}
        className="ui-composer-input"
        data-testid="composer-input"
        rows={2}
        value={value}
        disabled={locked}
        aria-describedby={disabledReason === null ? hintId : `${hintId} ${reasonId}`}
        placeholder={state === "active-turn" ? "Steer the running turn…" : "Send a message…"}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="ui-composer-actions">
        <p id={hintId} className="ui-composer-hint">
          {HINT[state]}
        </p>
        {disabledReason === null ? null : (
          <p id={reasonId} className="ui-composer-reason" data-testid="composer-reason">
            {disabledReason}
          </p>
        )}
        <div className="ui-composer-buttons">
          <Button
            ref={stopRef}
            type="button"
            className="ui-button--danger"
            data-testid="composer-stop"
            disabled={!canStop}
            onClick={onStop}
          >
            Stop
          </Button>
          <Button
            type="button"
            data-testid="composer-send"
            disabled={locked || value.trim().length === 0}
            onClick={onSubmit}
          >
            {PRIMARY_LABEL[state]}
          </Button>
        </div>
      </div>
    </div>
  );
}
