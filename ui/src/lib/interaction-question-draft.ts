import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AskUserQuestionsAnswer,
  QuestionDraftResponse,
} from "@paperclipai/shared";
import type {
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
} from "@paperclipai/adapter-utils";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";

export const QUESTION_DRAFT_DEBOUNCE_MS = 800;

export type QuestionDraftSaveState = "idle" | "loading" | "saving" | "saved" | "failed";

type CompactAnswer = PaperclipQuestionResponse["answers"][string];

/**
 * Stable comparison key for canonical draft answers. Sorts by question id so
 * a server round-trip that preserves content never reads as a local edit.
 */
export function draftAnswersKey(answers: readonly AskUserQuestionsAnswer[]): string {
  return JSON.stringify(
    [...answers]
      .map((answer) => ({
        questionId: answer.questionId,
        optionIds: [...answer.optionIds].sort(),
        ...(answer.otherText == null ? {} : { otherText: answer.otherText }),
      }))
      .sort((a, b) => (a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0)),
  );
}

/**
 * Legacy thread form (single/multi option lists plus the built-in "Other"
 * field) to the canonical draft shape. Questions without a value are omitted:
 * drafts are partial by design.
 */
export function legacyFormToDraftAnswers(args: {
  questions: ReadonlyArray<{ id: string }>;
  draftAnswers: Record<string, string[]>;
  draftOtherAnswers: Record<string, string>;
  otherActive: Record<string, boolean>;
}): AskUserQuestionsAnswer[] {
  const answers: AskUserQuestionsAnswer[] = [];
  for (const question of args.questions) {
    const optionIds = args.draftAnswers[question.id] ?? [];
    const otherText = args.otherActive[question.id] === true
      ? (args.draftOtherAnswers[question.id] ?? "")
      : undefined;
    if (optionIds.length === 0 && otherText === undefined) continue;
    answers.push({
      questionId: question.id,
      optionIds: [...optionIds],
      ...(otherText === undefined ? {} : { otherText }),
    });
  }
  return answers;
}

/** Canonical draft answers back to the legacy thread form state. */
export function draftAnswersToLegacyForm(answers: readonly AskUserQuestionsAnswer[]): {
  draftAnswers: Record<string, string[]>;
  draftOtherAnswers: Record<string, string>;
  otherActive: Record<string, boolean>;
} {
  const draftAnswers: Record<string, string[]> = {};
  const draftOtherAnswers: Record<string, string> = {};
  const otherActive: Record<string, boolean> = {};
  for (const answer of answers) {
    draftAnswers[answer.questionId] = [...answer.optionIds];
    if (answer.otherText != null) {
      draftOtherAnswers[answer.questionId] = answer.otherText;
      otherActive[answer.questionId] = true;
    }
  }
  return { draftAnswers, draftOtherAnswers, otherActive };
}

/**
 * Paginated task-chat form response to the canonical draft shape. Text
 * answers travel as `otherText`; select answers keep their option ids plus an
 * optional custom (`Other`) text.
 */
export function questionResponseToDraftAnswers(
  questionSet: PaperclipQuestionSet,
  responseAnswers: Record<string, CompactAnswer>,
): AskUserQuestionsAnswer[] {
  const answers: AskUserQuestionsAnswer[] = [];
  for (const question of questionSet.questions) {
    const answer = responseAnswers[question.id];
    if (!answer) continue;
    if (question.answerMode === "text") {
      const text = answer.text;
      if (text === undefined) continue;
      answers.push({ questionId: question.id, optionIds: [], otherText: text });
      continue;
    }
    const selectedOptionIds = answer.selectedOptionIds ?? [];
    const customText = answer.customText;
    if (selectedOptionIds.length === 0 && customText === undefined) continue;
    answers.push({
      questionId: question.id,
      optionIds: [...selectedOptionIds],
      ...(customText === undefined ? {} : { otherText: customText }),
    });
  }
  return answers;
}

/** Canonical draft answers back to the paginated task-chat form state. */
export function draftAnswersToQuestionResponse(
  questionSet: PaperclipQuestionSet,
  answers: readonly AskUserQuestionsAnswer[],
): { responseAnswers: Record<string, CompactAnswer>; customActive: Record<string, boolean> } {
  const byQuestionId = new Map(answers.map((answer) => [answer.questionId, answer] as const));
  const responseAnswers: Record<string, CompactAnswer> = {};
  const customActive: Record<string, boolean> = {};
  for (const question of questionSet.questions) {
    const answer = byQuestionId.get(question.id);
    if (!answer) continue;
    if (question.answerMode === "text") {
      responseAnswers[question.id] = { text: answer.otherText ?? "" };
      continue;
    }
    responseAnswers[question.id] = {
      selectedOptionIds: [...answer.optionIds],
      ...(answer.otherText == null ? {} : { customText: answer.otherText }),
    };
    if (answer.otherText != null) customActive[question.id] = true;
  }
  return { responseAnswers, customActive };
}

/** Accessible status copy for the draft save indicator. Null means "render nothing". */
export function questionDraftStatusCopy(
  status: QuestionDraftSaveState,
  options?: { hasDraft?: boolean },
): string | null {
  if (status === "saving") return "Saving draft…";
  if (status === "saved" && options?.hasDraft === true) return "Draft saved";
  return null;
}

function draftErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "Draft changed elsewhere or the question closed. Copy your unsaved edits before reloading; retry will not overwrite another draft.";
    if (error.status === 422) return "Draft no longer matches the questions — reload the form.";
    return error.message || "Draft couldn't be saved.";
  }
  return error instanceof Error ? error.message : "Draft couldn't be saved.";
}

export interface UseQuestionDraftPersistenceArgs {
  issueId?: string | null;
  interactionId?: string;
  /** False while the interaction is not pending or no submit handler exists. */
  enabled?: boolean;
  debounceMs?: number;
}

export interface QuestionDraftPersistence {
  /** True once the initial restore succeeded (or persistence is off). */
  loaded: boolean;
  status: QuestionDraftSaveState;
  revision: number;
  /** Last server snapshot; null when the server holds no draft. */
  draft: AskUserQuestionsAnswer[] | null;
  error: string | null;
  /** Debounced, serialized save of the caller's latest canonical answers. */
  scheduleSave: (answers: AskUserQuestionsAnswer[]) => void;
  /** Cancel the debounce and persist the latest scheduled answers now. */
  flush: () => Promise<boolean>;
  /** Retry restoration or the failed save without bypassing revision checks. */
  retry: () => void;
  /** Best-effort delete of the server draft (used after submit/cancel). */
  clear: () => Promise<void>;
  /** Stop all pending work once the form has been submitted or cancelled. */
  markSubmitted: () => void;
}

/**
 * The single durable-draft persistence implementation shared by both question
 * surfaces (the classic thread card and the compact task-chat card).
 *
 * - Restores once per issue+interaction identity; late or repeated responses
 *   never overwrite newer state (sequence guard).
 * - Serializes writes so a slow save cannot be overtaken by a newer one, and
 *   every save carries the last-known revision so a delayed save or another
 *   tab surfaces as a 409 instead of silently overwriting.
 * - Never throws into the form: failures land on `status`/`error` with an
 *   explicit `retry`.
 */
export function useQuestionDraftPersistence({
  issueId,
  interactionId,
  enabled = true,
  debounceMs = QUESTION_DRAFT_DEBOUNCE_MS,
}: UseQuestionDraftPersistenceArgs): QuestionDraftPersistence {
  const identity = issueId && interactionId && enabled ? `${issueId}:${interactionId}` : null;
  const [draft, setDraft] = useState<AskUserQuestionsAnswer[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(!identity);
  const [status, setStatus] = useState<QuestionDraftSaveState>(identity ? "loading" : "idle");
  const [error, setError] = useState<string | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const revisionRef = useRef(0);
  const pendingRef = useRef<AskUserQuestionsAnswer[] | null>(null);
  const submittedRef = useRef(false);
  const restoredRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const chainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const seqRef = useRef(0);

  const clearTimer = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const restore = useCallback(async (activeIdentity: string, seq: number): Promise<boolean> => {
    const current = () => identityRef.current === activeIdentity && seqRef.current === seq && !submittedRef.current;
    const [activeIssueId, activeInteractionId] = activeIdentity.split(":");
    try {
      const response: QuestionDraftResponse = await issuesApi.getQuestionDraft(activeIssueId, activeInteractionId);
      if (!current()) return false;
      revisionRef.current = response.revision;
      setRevision(response.revision);
      setDraft(response.answers);
      setStatus("saved");
    } catch (fetchError) {
      if (!current()) return false;
      if (!(fetchError instanceof ApiError && fetchError.status === 404)) {
        setStatus("failed");
        setError(draftErrorMessage(fetchError));
        return false;
      }
      revisionRef.current = 0;
      setRevision(0);
      setDraft(null);
      setStatus("idle");
    }
    restoredRef.current = true;
    setLoaded(true);
    setError(null);
    return true;
  }, []);

  useEffect(() => {
    const seq = ++seqRef.current;
    pendingRef.current = null;
    submittedRef.current = false;
    restoredRef.current = false;
    revisionRef.current = 0;
    chainRef.current = Promise.resolve(true);
    clearTimer();
    setDraft(null);
    setRevision(0);
    setLoaded(!identity);
    setStatus(identity ? "loading" : "idle");
    setError(null);
    if (identity) void restore(identity, seq);
    return () => {
      ++seqRef.current;
      clearTimer();
    };
  }, [identity, clearTimer, restore]);

  const runSave = useCallback(async (
    activeIdentity: string,
    seq: number,
    answers: AskUserQuestionsAnswer[],
  ): Promise<boolean> => {
    const current = () => identityRef.current === activeIdentity && seqRef.current === seq && !submittedRef.current;
    if (!current() || !restoredRef.current) return false;
    const [activeIssueId, activeInteractionId] = activeIdentity.split(":");
    try {
      const response = await issuesApi.putQuestionDraft(activeIssueId, activeInteractionId, {
        answers,
        expectedRevision: revisionRef.current,
      });
      if (!current()) return false;
      revisionRef.current = response.revision;
      setRevision(response.revision);
      setDraft(response.answers);
      if (pendingRef.current === answers) pendingRef.current = null;
      setStatus(pendingRef.current ? "saving" : "saved");
      setError(null);
      return true;
    } catch (saveError) {
      if (!current()) return false;
      // Keep the latest local answers available to retry, including when the
      // failed request was the last debounced edit.
      setStatus("failed");
      setError(draftErrorMessage(saveError));
      return false;
    }
  }, []);

  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    const activeIdentity = identityRef.current;
    const seq = seqRef.current;
    if (!activeIdentity || submittedRef.current) return Promise.resolve(true);
    const chained = chainRef.current.then(() => {
      if (identityRef.current !== activeIdentity || seqRef.current !== seq || submittedRef.current) return false;
      const latest = pendingRef.current;
      return latest ? runSave(activeIdentity, seq, latest) : restoredRef.current;
    });
    chainRef.current = chained;
    return chained;
  }, [clearTimer, runSave]);

  const scheduleSave = useCallback((answers: AskUserQuestionsAnswer[]) => {
    if (!identityRef.current || submittedRef.current) return;
    pendingRef.current = answers;
    setStatus("saving");
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void flush();
    }, debounceMs);
  }, [clearTimer, debounceMs, flush]);

  const retry = useCallback(() => {
    const activeIdentity = identityRef.current;
    if (!activeIdentity || submittedRef.current) return;
    setStatus("saving");
    setError(null);
    if (!restoredRef.current) {
      void restore(activeIdentity, seqRef.current);
      return;
    }
    // Never adopt a newer revision behind the user's back: that would turn
    // Retry into an unannounced last-write-wins overwrite.
    void flush();
  }, [flush, restore]);

  const clear = useCallback(async () => {
    clearTimer();
    pendingRef.current = null;
    const activeIdentity = identityRef.current;
    await chainRef.current;
    if (!activeIdentity || identityRef.current !== activeIdentity) return;
    const [activeIssueId, activeInteractionId] = activeIdentity.split(":");
    try {
      await issuesApi.deleteQuestionDraft(activeIssueId, activeInteractionId);
    } catch {
      // Terminal interactions never restore or accept draft writes.
    }
  }, [clearTimer]);

  const markSubmitted = useCallback(() => {
    submittedRef.current = true;
    clearTimer();
    pendingRef.current = null;
  }, [clearTimer]);

  return { loaded, status, revision, draft, error, scheduleSave, flush, retry, clear, markSubmitted };
}
