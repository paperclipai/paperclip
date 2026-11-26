import { useEffect, useId, useRef, useState } from "react";

import type {
  CapabilityThreadInteractionCard,
  CapabilityThreadInteractionState,
} from "../../../src/issue-thread/types";
import { Chip } from "./primitives";

/**
 * Native interaction cards (contract §5). All five `request_human_input`
 * kinds render typed controls; the card never asks the user to type an answer
 * into the composer.
 *
 * The submit handler posts to the package server, which stores the response in
 * the mock control plane before the runner is resumed. The card only leaves
 * `submitting` when the server acknowledges — there is no optimistic
 * resolution here.
 */

export interface CapabilityInteractionResponse {
  interactionId: string;
  outcome: "answered" | "accepted" | "rejected";
  result: Record<string, unknown>;
}

const STATE_GLYPH: Record<CapabilityThreadInteractionState, string> = {
  pending: "⏳",
  submitting: "⏳",
  accepted: "✓",
  answered: "✓",
  rejected: "✕",
  stale_target: "⌛",
  superseded_by_comment: "⌛",
  expired: "⌛",
  withdrawn: "⌛",
  issue_closed: "⌛",
};

const RESOLVED_STATES = new Set<CapabilityThreadInteractionState>([
  "accepted",
  "answered",
  "rejected",
  "stale_target",
  "superseded_by_comment",
  "expired",
  "withdrawn",
  "issue_closed",
]);

function stateTone(state: CapabilityThreadInteractionState) {
  if (state === "accepted" || state === "answered") return "success" as const;
  if (state === "rejected") return "danger" as const;
  if (state === "pending" || state === "submitting") return "accent" as const;
  return undefined;
}

export function InteractionCard({
  card,
  onRespond,
  onOpenEvidence,
  autoFocus,
}: {
  card: CapabilityThreadInteractionCard;
  onRespond?: (response: CapabilityInteractionResponse) => void;
  onOpenEvidence?: (section: string, recordId: string) => void;
  autoFocus?: boolean;
}) {
  const titleId = useId();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>(() =>
    card.payload.kind === "checkbox"
      ? card.payload.options.filter((option) => option.defaultSelected).map((option) => option.id)
      : card.payload.kind === "suggest_tasks"
        ? card.payload.tasks.map((task) => task.id)
        : [],
  );
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const firstControl = useRef<HTMLElement | null>(null);
  const stateChip = useRef<HTMLSpanElement | null>(null);
  const previousState = useRef<CapabilityThreadInteractionState>(card.state);
  const resolved = RESOLVED_STATES.has(card.state);
  const busy = card.state === "submitting";

  useEffect(() => {
    // Contract §9.2: resolving a card moves focus to its state chip. The
    // controls the user just used unmount on resolve, so without this the
    // keyboard caret would fall back to `body` exactly when the card changes.
    const from = previousState.current;
    previousState.current = card.state;
    if (from === card.state) return;
    if (!RESOLVED_STATES.has(from) && RESOLVED_STATES.has(card.state)) {
      stateChip.current?.focus();
    }
  }, [card.state]);

  function respond(response: CapabilityInteractionResponse) {
    setError(null);
    onRespond?.(response);
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  }

  return (
    <section
      className="pit-interaction"
      data-interaction-id={card.interactionId}
      data-interaction-kind={card.interactionKind}
      data-interaction-state={card.state}
      aria-labelledby={titleId}
      id={`interaction-${card.interactionId}`}
    >
      <div className="pit-card-head">
        <h3 className="pit-interaction-title" id={titleId}>
          {card.title}
        </h3>
        <Chip
          tone={stateTone(card.state)}
          testId="interaction-state-chip"
          tabIndex={-1}
          chipRef={stateChip}
        >
          <span aria-hidden="true">{STATE_GLYPH[card.state]}</span>
          {card.stateLabel}
        </Chip>
      </div>

      <p className="pit-card-body">{card.prompt}</p>

      {card.target !== null ? (
        <p className="pit-card-meta">
          Target:{" "}
          <a href={card.target.href} data-testid="interaction-target">
            {card.target.label}
          </a>
        </p>
      ) : null}

      {card.payload.kind === "confirmation" ? (
        <p className="pit-quote">{card.payload.targetSummary}</p>
      ) : null}

      {resolved ? (
        <div className="pit-interaction-controls">
          {card.resolvedSummary.length > 0 ? (
            <ul className="pit-summary-list">
              {card.resolvedSummary.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          ) : null}
          {card.reason !== null ? <blockquote className="pit-quote">{card.reason}</blockquote> : null}
          {card.supersededBy !== null ? (
            <p className="pit-card-meta">
              <a href={card.supersededBy.href}>{card.supersededBy.label}</a>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="pit-interaction-controls">
          {card.payload.kind === "questions"
            ? card.payload.questions.map((question, index) => (
                <div className="pit-field" key={question.id}>
                  <span className="pit-field-label" id={`${titleId}-${question.id}`}>
                    {question.prompt}
                  </span>
                  {question.control === "text" ? (
                    <input
                      className="pit-input"
                      type="text"
                      aria-labelledby={`${titleId}-${question.id}`}
                      disabled={busy}
                      value={answers[question.id] ?? ""}
                      onChange={(event) =>
                        setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                      }
                    />
                  ) : question.control === "select" ? (
                    <select
                      className="pit-select"
                      aria-labelledby={`${titleId}-${question.id}`}
                      disabled={busy}
                      value={answers[question.id] ?? ""}
                      onChange={(event) =>
                        setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                      }
                    >
                      <option value="">Choose…</option>
                      {(question.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div role="radiogroup" aria-labelledby={`${titleId}-${question.id}`}>
                      {(question.options ?? []).map((option, optionIndex) => (
                        <label className="pit-option-row" key={option}>
                          <input
                            type="radio"
                            name={`${card.interactionId}-${question.id}`}
                            value={option}
                            disabled={busy}
                            ref={
                              index === 0 && optionIndex === 0
                                ? (node) => {
                                    firstControl.current = node;
                                    if (autoFocus === true && node !== null) node.focus();
                                  }
                                : undefined
                            }
                            checked={answers[question.id] === option}
                            onChange={() =>
                              setAnswers((current) => ({ ...current, [question.id]: option }))
                            }
                          />
                          <span>{option}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))
            : null}

          {card.payload.kind === "checkbox"
            ? card.payload.options.map((option, index) => (
                <label className="pit-option-row" key={option.id}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.includes(option.id)}
                    ref={
                      index === 0
                        ? (node) => {
                            if (autoFocus === true && node !== null) node.focus();
                          }
                        : undefined
                    }
                    onChange={() => setSelected((current) => toggle(current, option.id))}
                  />
                  <span>{option.label}</span>
                </label>
              ))
            : null}

          {card.payload.kind === "suggest_tasks"
            ? card.payload.tasks.map((task) => (
                <label className="pit-option-row" key={task.id}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.includes(task.id)}
                    onChange={() => setSelected((current) => toggle(current, task.id))}
                  />
                  <span>
                    <strong>{task.title}</strong>
                    <br />
                    <span className="pit-card-meta">{task.description}</span>
                  </span>
                </label>
              ))
            : null}

          {card.payload.kind === "item_verdicts"
            ? card.payload.items.map((item) => (
                <div className="pit-field" key={item.id}>
                  <span className="pit-field-label" id={`${titleId}-${item.id}`}>
                    {item.title}
                  </span>
                  <div
                    className="pit-segmented-verdicts"
                    role="radiogroup"
                    aria-labelledby={`${titleId}-${item.id}`}
                  >
                    {(["approve", "reject", "defer"] as const).map((verdict) => (
                      <button
                        key={verdict}
                        type="button"
                        className="pit-button"
                        role="radio"
                        aria-checked={
                          (item.lockedVerdict ?? verdicts[item.id] ?? "") === verdict
                        }
                        disabled={busy || item.lockedVerdict != null}
                        onClick={() =>
                          setVerdicts((current) => ({ ...current, [item.id]: verdict }))
                        }
                      >
                        {verdict}
                      </button>
                    ))}
                  </div>
                  {item.requireReason === true ? (
                    <textarea
                      className="pit-textarea"
                      aria-label={`Reason for ${item.title}`}
                      disabled={busy || item.lockedVerdict != null}
                      value={reasons[item.id] ?? ""}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [item.id]: event.target.value }))
                      }
                    />
                  ) : null}
                </div>
              ))
            : null}

          {card.payload.kind === "confirmation" && card.payload.requireRejectReason ? (
            <div className="pit-field">
              <label className="pit-field-label" htmlFor={`${titleId}-reject-reason`}>
                Reason (required to request changes)
              </label>
              <textarea
                className="pit-textarea"
                id={`${titleId}-reject-reason`}
                disabled={busy}
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
              />
            </div>
          ) : null}

          {error !== null ? (
            <p className="pit-composer-reason" role="alert">
              {error}
            </p>
          ) : null}

          <div className="pit-button-row">
            {card.payload.kind === "confirmation" ? (
              <>
                <button
                  type="button"
                  className="pit-button"
                  data-variant="primary"
                  disabled={busy}
                  ref={(node) => {
                    if (autoFocus === true && node !== null && firstControl.current === null) {
                      firstControl.current = node;
                      node.focus();
                    }
                  }}
                  onClick={() =>
                    respond({
                      interactionId: card.interactionId,
                      outcome: "accepted",
                      result: { accepted: true },
                    })
                  }
                >
                  {card.payload.acceptLabel}
                </button>
                <button
                  type="button"
                  className="pit-button"
                  data-variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    if (
                      card.payload.kind === "confirmation" &&
                      card.payload.requireRejectReason &&
                      rejectReason.trim().length === 0
                    ) {
                      setError("A reason is required to request changes.");
                      return;
                    }
                    respond({
                      interactionId: card.interactionId,
                      outcome: "rejected",
                      result: { accepted: false, reason: rejectReason },
                    });
                  }}
                >
                  {card.payload.rejectLabel}
                </button>
              </>
            ) : null}

            {card.payload.kind === "questions" ? (
              <button
                type="button"
                className="pit-button"
                data-variant="primary"
                disabled={busy}
                onClick={() => {
                  const missing =
                    card.payload.kind === "questions"
                      ? card.payload.questions.filter(
                          (question) =>
                            question.required === true &&
                            (answers[question.id] ?? "").trim().length === 0,
                        )
                      : [];
                  if (missing.length > 0) {
                    setError(`Answer every required question (${missing.length} remaining).`);
                    return;
                  }
                  respond({
                    interactionId: card.interactionId,
                    outcome: "answered",
                    result: { answers },
                  });
                }}
              >
                {card.payload.submitLabel}
              </button>
            ) : null}

            {card.payload.kind === "checkbox" ? (
              <>
                <button
                  type="button"
                  className="pit-button"
                  data-variant="primary"
                  disabled={busy}
                  onClick={() => {
                    if (card.payload.kind !== "checkbox") return;
                    if (selected.length < card.payload.minSelected) {
                      setError(`Select at least ${card.payload.minSelected}.`);
                      return;
                    }
                    if (selected.length > card.payload.maxSelected) {
                      setError(`Select at most ${card.payload.maxSelected}.`);
                      return;
                    }
                    respond({
                      interactionId: card.interactionId,
                      outcome: "accepted",
                      result: { selected },
                    });
                  }}
                >
                  {card.payload.acceptLabel}
                </button>
                <button
                  type="button"
                  className="pit-button"
                  data-variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    respond({
                      interactionId: card.interactionId,
                      outcome: "rejected",
                      result: { selected: [] },
                    })
                  }
                >
                  {card.payload.rejectLabel}
                </button>
              </>
            ) : null}

            {card.payload.kind === "suggest_tasks" ? (
              <button
                type="button"
                className="pit-button"
                data-variant="primary"
                disabled={busy}
                onClick={() =>
                  respond({
                    interactionId: card.interactionId,
                    outcome: "accepted",
                    result: { acceptedTaskIds: selected },
                  })
                }
              >
                {card.payload.acceptLabel}
              </button>
            ) : null}

            {card.payload.kind === "item_verdicts" ? (
              <button
                type="button"
                className="pit-button"
                data-variant="primary"
                disabled={busy}
                onClick={() => {
                  if (card.payload.kind !== "item_verdicts") return;
                  const submitted = card.payload.items.filter(
                    (item) => item.lockedVerdict == null && verdicts[item.id] !== undefined,
                  );
                  const missingReason = submitted.filter(
                    (item) =>
                      item.requireReason === true && (reasons[item.id] ?? "").trim().length === 0,
                  );
                  if (missingReason.length > 0) {
                    setError(`A reason is required for ${missingReason.length} item(s).`);
                    return;
                  }
                  if (submitted.length === 0) {
                    setError("Choose a verdict for at least one item.");
                    return;
                  }
                  respond({
                    interactionId: card.interactionId,
                    outcome: "answered",
                    result: {
                      verdicts: submitted.map((item) => ({
                        id: item.id,
                        verdict: verdicts[item.id],
                        reason: reasons[item.id] ?? null,
                      })),
                    },
                  });
                }}
              >
                {card.payload.submitLabel}
              </button>
            ) : null}
          </div>
        </div>
      )}

      <button
        type="button"
        className="pit-link-button"
        onClick={() => onOpenEvidence?.(card.evidenceRef.section, card.evidenceRef.recordId)}
      >
        View request evidence
      </button>
    </section>
  );
}
