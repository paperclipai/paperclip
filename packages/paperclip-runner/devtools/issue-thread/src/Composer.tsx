import { useEffect, useRef, useState, type FormEvent } from "react";

import type { CapabilityComposerModel } from "../../../src/issue-thread/types";

/**
 * Composer (contract §4). `data-composer-state` is the single test and
 * screenshot hook. Draft text survives refresh through localStorage keyed by
 * session id; Stop never discards the transcript.
 */

export interface ComposerProps {
  model: CapabilityComposerModel;
  sessionId: string;
  onSend: (message: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onReset: () => void;
  onFocusPending: (interactionId: string) => void;
  /** The clean room resets into a new tenant, so it names the action itself. */
  resetLabel?: string;
}

function draftKey(sessionId: string): string {
  return `paperclip-runner.capability.draft.${sessionId}`;
}

function readDraft(sessionId: string): string {
  try {
    return window.localStorage.getItem(draftKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function Composer(props: ComposerProps) {
  const {
    model,
    sessionId,
    onSend,
    onStop,
    onRetry,
    onReset,
    onFocusPending,
    resetLabel = "Reset scenario",
  } = props;
  const [value, setValue] = useState(() => readDraft(sessionId));
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setValue(readDraft(sessionId));
  }, [sessionId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(draftKey(sessionId), value);
    } catch {
      // A blocked storage quota must not break the session.
    }
  }, [sessionId, value]);

  const editable = model.state === "ready" || model.state === "streaming";
  const canSend = editable && value.trim().length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  }

  return (
    <form
      className="pit-composer"
      data-composer-state={model.state}
      onSubmit={submit}
      aria-label="Send a message to the agent"
    >
      <div className="pit-composer-inner">
        {model.helper !== null ? (
          <p className="pit-composer-helper">
            {model.helper}
            {model.state === "waiting" && model.pendingInteractionId !== null ? (
              <>
                {" "}
                <button
                  type="button"
                  className="pit-link-button"
                  data-testid="pending-anchor"
                  onClick={() => onFocusPending(model.pendingInteractionId as string)}
                >
                  Go to the pending request
                </button>
              </>
            ) : null}
          </p>
        ) : null}

        {model.reason !== null ? (
          <p className="pit-composer-reason" data-testid="composer-reason">
            {model.reason}
          </p>
        ) : null}

        <div className="pit-composer-row">
          <label className="pit-visually-hidden" htmlFor="composer-input">
            Message
          </label>
          <textarea
            className="pit-composer-input"
            id="composer-input"
            ref={inputRef}
            rows={2}
            value={value}
            disabled={!editable}
            placeholder={editable ? "Message the agent…" : ""}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                if (canSend) {
                  onSend(value.trim());
                  setValue("");
                }
              }
            }}
          />

          {model.state === "streaming" ? (
            <button
              type="button"
              className="pit-button"
              data-variant="destructive"
              onClick={onStop}
              data-testid="composer-stop"
            >
              Stop
            </button>
          ) : model.state === "reconnecting" ? (
            <button type="button" className="pit-button" onClick={onRetry}>
              Retry now
            </button>
          ) : model.state === "disabled" ? (
            <button type="button" className="pit-button" onClick={onReset}>
              {resetLabel}
            </button>
          ) : null}

          <button
            type="submit"
            className="pit-button"
            data-variant="primary"
            disabled={!canSend || model.state === "sending"}
            data-testid="composer-send"
          >
            {model.state === "sending" ? "Sending…" : model.state === "streaming" ? "Steer" : "Send"}
          </button>
        </div>
      </div>
    </form>
  );
}
