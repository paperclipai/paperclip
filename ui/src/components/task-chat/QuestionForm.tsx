import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
} from "lucide-react";
import type {
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
} from "@paperclipai/adapter-utils";
import type { MentionOption } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearDraft,
  loadStructuredDraft,
  saveStructuredDraft,
} from "@/lib/composer-draft";
import { cn } from "@/lib/utils";
import {
  TaskChatComposerTakeoverControls,
  useTaskChatComposerTakeoverActions,
} from "./TaskChatComposerTakeoverContext";
import { TaskChatRichInput } from "./TaskChatRichInput";
import { matchSafeQuestionValidationPattern } from "./question-validation-pattern";

type Question = PaperclipQuestionSet["questions"][number];
type Answer = PaperclipQuestionResponse["answers"][string];

export interface QuestionFormProps {
  id: string;
  questionSet: PaperclipQuestionSet;
  initialResponse?: PaperclipQuestionResponse | null;
  implicitCustomAnswer?: boolean;
  draftKey?: string;
  disabled?: boolean;
  imageUploadHandler?: (file: File) => Promise<string>;
  mentions?: MentionOption[];
  onSubmit: (response: PaperclipQuestionResponse) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

function answerHasValue(answer: Answer | undefined): boolean {
  return Boolean(
    answer?.text?.trim() ||
    answer?.customText?.trim() ||
    answer?.selectedOptionIds?.length,
  );
}

function answerError(
  question: Question,
  answer: Answer | undefined,
): string | null {
  if (question.required && !answerHasValue(answer))
    return "This question is required.";
  if (
    question.answerMode !== "text" &&
    answer?.customText !== undefined &&
    !answer.customText.trim()
  ) {
    return "Enter a custom answer.";
  }
  const value =
    question.answerMode === "text" ? answer?.text : answer?.customText;
  if (value == null || value.length === 0) return null;
  const validation = question.textValidation;
  if (validation?.minLength != null && value.length < validation.minLength)
    return `Enter at least ${validation.minLength} characters.`;
  if (validation?.maxLength != null && value.length > validation.maxLength)
    return `Enter no more than ${validation.maxLength} characters.`;
  if (validation?.pattern) {
    const result = matchSafeQuestionValidationPattern(validation.pattern, value);
    if (result === "unsupported")
      return "This question has an unsupported validation pattern.";
    if (result === "no_match") return "Use the requested format.";
  }
  if (
    validation?.inputType === "number" ||
    validation?.inputType === "integer"
  ) {
    const numeric = Number(value);
    if (
      !Number.isFinite(numeric) ||
      (validation.inputType === "integer" && !Number.isInteger(numeric))
    ) {
      return `Enter a valid ${validation.inputType}.`;
    }
    if (validation.minimum != null && numeric < validation.minimum)
      return `Enter a value of at least ${validation.minimum}.`;
    if (validation.maximum != null && numeric > validation.maximum)
      return `Enter a value no greater than ${validation.maximum}.`;
  }
  return null;
}

function SelectOption({
  id,
  label,
  description,
  recommended,
  selected,
  multiple,
  disabled,
  onClick,
}: {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  selected: boolean;
  multiple: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      id={id}
      role={multiple ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "bg-muted/80"
          : recommended
            ? "bg-muted/50"
            : "hover:bg-muted/40",
      )}
      data-selected={selected ? "true" : "false"}
      data-recommended={recommended ? "true" : "false"}
      onClick={onClick}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
          multiple ? "rounded-sm" : "rounded-full",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/50",
        )}
      >
        {selected ? (
          multiple ? (
            <Check className="h-3 w-3" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
          )
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium leading-5 text-foreground">
          <span>{label}</span>
          {recommended ? (
            <span className="rounded-sm bg-background/70 px-1.5 py-0.5 text-(length:--text-micro) font-medium text-muted-foreground">
              Recommended
            </span>
          ) : null}
        </span>
        {description ? (
          <span className="block text-xs leading-4 text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function QuestionResponseSummary({
  questionSet,
  response,
}: {
  questionSet: PaperclipQuestionSet;
  response: PaperclipQuestionResponse;
}) {
  return (
    <dl className="grid gap-2 text-sm">
      {questionSet.questions.map((question) => {
        const answer = response.answers[question.id];
        const selectedLabels = (answer?.selectedOptionIds ?? []).map(
          (optionId) =>
            question.options?.find((option) => option.id === optionId)?.label ??
            optionId,
        );
        const values = [
          ...selectedLabels,
          answer?.text,
          answer?.customText,
        ].filter((value): value is string => Boolean(value));
        return (
          <div key={question.id}>
            <dt>
              {question.header ? (
                <span className="block text-xs font-medium text-muted-foreground">
                  {question.header}
                </span>
              ) : null}
              <span className="block text-sm text-foreground">
                {question.prompt}
              </span>
            </dt>
            <dd className="mt-0.5 text-foreground">
              {values.length > 0 ? values.join(", ") : "No answer"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function QuestionForm({
  id,
  questionSet,
  initialResponse,
  implicitCustomAnswer = false,
  draftKey,
  disabled = false,
  imageUploadHandler,
  mentions,
  onSubmit,
  onCancel,
}: QuestionFormProps) {
  const takeoverActions = useTaskChatComposerTakeoverActions();
  const initialDraft = draftKey
    ? loadStructuredDraft<{
        page: number;
        answers: Record<string, Answer>;
        customActive: Record<string, boolean>;
      }>(draftKey, {
        page: 0,
        answers: structuredClone(initialResponse?.answers ?? {}),
        customActive: Object.fromEntries(
          Object.entries(initialResponse?.answers ?? {})
            .filter(([, answer]) => Boolean(answer.customText))
            .map(([questionId]) => [questionId, true]),
        ),
      })
    : null;
  const [page, setPage] = useState(initialDraft?.page ?? 0);
  const [answers, setAnswers] = useState<Record<string, Answer>>(
    () =>
      initialDraft?.answers ?? structuredClone(initialResponse?.answers ?? {}),
  );
  const [customActive, setCustomActive] = useState<Record<string, boolean>>(
    () =>
      initialDraft?.customActive ??
      Object.fromEntries(
        Object.entries(initialResponse?.answers ?? {})
          .filter(([, answer]) => Boolean(answer.customText))
          .map(([questionId]) => [questionId, true]),
      ),
  );
  const [working, setWorking] = useState<"submit" | "cancel" | null>(null);
  const [inputUploading, setInputUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});

  useEffect(() => {
    setPage((current) =>
      Math.min(current, Math.max(questionSet.questions.length - 1, 0)),
    );
  }, [questionSet.questions.length]);
  useEffect(() => {
    if (draftKey)
      saveStructuredDraft(draftKey, { page, answers, customActive });
  }, [answers, customActive, draftKey, page]);

  const question = questionSet.questions[page];
  const validationErrors = useMemo(
    () =>
      Object.fromEntries(
        questionSet.questions.map((candidate) => [
          candidate.id,
          answerError(candidate, answers[candidate.id]),
        ]),
      ),
    [answers, questionSet.questions],
  );
  const allValid = Object.values(validationErrors).every(
    (value) => value == null,
  );
  if (!question)
    return (
      <p className="text-sm text-muted-foreground">
        No answerable questions were provided.
      </p>
    );
  const answer = answers[question.id] ?? {};
  const selected = answer.selectedOptionIds ?? [];
  const multiple = question.answerMode === "multi_select";
  const allowsCustom =
    question.answerMode !== "text" &&
    (question.customAnswer?.enabled === true || implicitCustomAnswer);
  const isCustomActive = customActive[question.id] === true;
  const optionFilter = filters[question.id]?.trim().toLowerCase() ?? "";
  const visibleOptions = (question.options ?? []).filter(
    (option) =>
      !optionFilter ||
      option.label.toLowerCase().includes(optionFilter) ||
      option.description?.toLowerCase().includes(optionFilter),
  );

  function updateAnswer(next: Answer) {
    setAnswers((current) => ({ ...current, [question.id]: next }));
  }

  function toggleOption(optionId: string) {
    const optionIds = multiple
      ? selected.includes(optionId)
        ? selected.filter((candidate) => candidate !== optionId)
        : [...selected, optionId]
      : [optionId];
    const nextAnswer = {
      ...answer,
      selectedOptionIds: optionIds,
      ...(!multiple ? { customText: undefined } : {}),
    };
    const nextAnswers = { ...answers, [question.id]: nextAnswer };
    setAnswers(nextAnswers);
    if (!multiple) {
      setCustomActive((current) => ({ ...current, [question.id]: false }));
      if (page < questionSet.questions.length - 1) setPage(page + 1);
      else void submit(nextAnswers);
    }
  }

  function toggleCustom() {
    const active = !isCustomActive;
    setCustomActive((current) => ({ ...current, [question.id]: active }));
    updateAnswer({
      ...answer,
      ...(!multiple && active ? { selectedOptionIds: [] } : {}),
      ...(active
        ? { customText: answer.customText ?? "" }
        : { customText: undefined }),
    });
  }

  async function submit(responseAnswers: Record<string, Answer> = answers) {
    const responseIsValid = questionSet.questions.every(
      (candidate) =>
        answerError(candidate, responseAnswers[candidate.id]) == null,
    );
    if (!responseIsValid || disabled || working || inputUploading) return;
    setWorking("submit");
    setError(null);
    try {
      await onSubmit({
        schema: "paperclip.question_response.v1",
        answers: structuredClone(responseAnswers),
      });
      if (draftKey) clearDraft(draftKey);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The answers could not be submitted.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function cancel() {
    if (!onCancel || disabled || working || inputUploading) return;
    setWorking("cancel");
    setError(null);
    try {
      await onCancel();
      if (draftKey) clearDraft(draftKey);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The questions could not be cancelled.",
      );
    } finally {
      setWorking(null);
    }
  }

  const currentError = validationErrors[question.id];
  const isLastPage = page === questionSet.questions.length - 1;
  const showQuestionActionButton =
    multiple ||
    (isLastPage && (question.answerMode !== "single_select" || isCustomActive));
  const showActionRow = Boolean(
    takeoverActions?.skipButton || onCancel || showQuestionActionButton,
  );
  const pagination =
    questionSet.questions.length > 1 ? (
      <nav
        className="flex shrink-0 items-center gap-1"
        aria-label="Question pagination"
      >
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Previous question"
          disabled={disabled || working != null || page === 0}
          onClick={() => setPage((current) => current - 1)}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <span className="min-w-10 text-center tabular-nums">
          {page + 1} of {questionSet.questions.length}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Next question"
          disabled={disabled || working != null || isLastPage}
          onClick={() => setPage((current) => current + 1)}
        >
          <ChevronRight aria-hidden />
        </Button>
      </nav>
    ) : null;

  function progressOrSubmit() {
    if (!isLastPage) {
      setPage((current) =>
        Math.min(current + 1, questionSet.questions.length - 1),
      );
      return;
    }
    void submit();
  }
  return (
    <div
      onKeyDown={(event) => {
        if (
          disabled ||
          working ||
          question.answerMode === "text" ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return;
        const target = event.target as HTMLElement;
        if (target.matches("input, textarea, [contenteditable='true']")) return;
        const optionIndex = Number.parseInt(event.key, 10) - 1;
        const option = visibleOptions[optionIndex];
        if (!option || optionIndex < 0 || optionIndex > 8) return;
        event.preventDefault();
        toggleOption(option.id);
      }}
    >
      {questionSet.description ? (
        <p className="mb-3 text-sm text-muted-foreground">
          {questionSet.description}
        </p>
      ) : null}
      {question.answerMode === "text" ? (
        <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
          {question.answerMode === "text" ? <span>Write an answer</span> : null}
        </div>
      ) : null}
      {pagination ? (
        takeoverActions ? (
          <TaskChatComposerTakeoverControls>
            {pagination}
          </TaskChatComposerTakeoverControls>
        ) : (
          <div className="mb-2 flex justify-end text-xs text-muted-foreground">
            {pagination}
          </div>
        )
      ) : null}
      <div>
        {question.header ? (
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {question.header}
          </p>
        ) : null}
        <p
          id={`${id}-${question.id}-prompt`}
          className="text-sm font-medium leading-5 text-foreground"
        >
          {question.prompt}
        </p>
        {question.helpText ? (
          <p className="mt-1 text-xs leading-4 text-muted-foreground">
            {question.helpText}
          </p>
        ) : null}
      </div>
      {question.answerMode === "text" ? (
        <div className="mt-3">
          <TaskChatRichInput
            ariaLabelledBy={`${id}-${question.id}-prompt`}
            testId="question-text-answer-composer"
            value={answer.text ?? ""}
            disabled={disabled || working != null}
            onChange={(value) => updateAnswer({ text: value })}
            placeholder="Write your answer"
            imageUploadHandler={imageUploadHandler}
            mentions={mentions}
            autoFocus
            onUploadingChange={setInputUploading}
            onSubmit={() => {
              if (!inputUploading && currentError == null) progressOrSubmit();
            }}
            attachAriaLabel={`Attach image to answer for ${question.prompt}`}
          />
        </div>
      ) : (
        <div
          className="mt-3 grid gap-1.5"
          role={multiple ? "group" : "radiogroup"}
          aria-labelledby={`${id}-${question.id}-prompt`}
        >
          {(question.options?.length ?? 0) > 8 ? (
            <label className="relative mb-1 block">
              <Search
                className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={filters[question.id] ?? ""}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                placeholder="Filter choices"
                aria-label={`Filter choices for ${question.prompt}`}
                className="pl-8"
              />
            </label>
          ) : null}
          {visibleOptions.map((option) => (
            <SelectOption
              key={option.id}
              id={`${id}-${question.id}-${option.id}`}
              label={option.label}
              description={option.description}
              recommended={option.recommended}
              selected={selected.includes(option.id)}
              multiple={multiple}
              disabled={disabled || working != null}
              onClick={() => toggleOption(option.id)}
            />
          ))}
          {allowsCustom ? (
            <div className="space-y-1.5">
              <SelectOption
                id={`${id}-${question.id}-custom`}
                label={question.customAnswer?.label ?? "Other"}
                selected={isCustomActive}
                multiple={multiple}
                disabled={disabled || working != null}
                onClick={toggleCustom}
              />
              {isCustomActive ? (
                <TaskChatRichInput
                  ariaLabelledBy={`${id}-${question.id}-prompt`}
                  testId="question-other-answer-composer"
                  value={answer.customText ?? ""}
                  placeholder={
                    question.customAnswer?.placeholder ?? "Type your answer"
                  }
                  disabled={disabled || working != null}
                  onChange={(value) =>
                    updateAnswer({ ...answer, customText: value })
                  }
                  autoFocus
                  imageUploadHandler={imageUploadHandler}
                  mentions={mentions}
                  onUploadingChange={setInputUploading}
                  onSubmit={() => {
                    if (!inputUploading && currentError == null)
                      progressOrSubmit();
                  }}
                  attachAriaLabel={`Attach image to other answer for ${question.prompt}`}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {currentError && answerHasValue(answer) ? (
        <p className="mt-2 text-xs text-destructive">{currentError}</p>
      ) : null}
      <div aria-live="assertive">
        {error ? (
          <div className="mt-2 rounded-sm border border-destructive/60 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>
      {showActionRow ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {takeoverActions?.skipButton}
          {onCancel ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || working != null || inputUploading}
              onClick={() => void cancel()}
            >
              {working === "cancel" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}{" "}
              Cancel
            </Button>
          ) : null}
          {showQuestionActionButton ? (
            <Button
              type="button"
              size="sm"
              disabled={
                disabled ||
                working != null ||
                inputUploading ||
                (isLastPage ? !allValid : currentError != null)
              }
              onClick={progressOrSubmit}
            >
              {working === "submit" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {questionSet.submitLabel ?? "Submit answers"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
