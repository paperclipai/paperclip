import type { Row } from "./first-task-scoring.js";

const html = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : [];
const text = (value: unknown, cls = "interaction-copy") =>
  value == null || value === ""
    ? ""
    : `<div class="${cls}">${html(value)}</div>`;
const badge = (value: unknown) =>
  `<span class="interaction-badge">${html(value)}</span>`;
const action = (label: unknown, selected = false, primary = false) =>
  `<button type="button" disabled class="interaction-action${selected ? " is-selected" : ""}${primary ? " is-primary" : ""}">${selected ? "✓ " : ""}${html(label)}</button>`;
const field = (label: string, value: unknown) =>
  value == null || value === ""
    ? ""
    : `<div class="interaction-field"><span>${html(label)}</span><strong>${html(value)}</strong></div>`;
const raw = (value: unknown) =>
  `<details class="transcript-raw"><summary>Card payload and resolution</summary><pre>${html(JSON.stringify(value, null, 2))}</pre></details>`;
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];

export function interactionReportTitle(row: Row): string {
  const p = row.payload ?? {};
  if (row.kind === "request_confirmation") {
    if (p.toolAction) return "Tool action approval";
    if (p.secretProposal) return "Credential binding approval";
    if (p.connectionAuthorization) return "Connection authorization";
  }
  return (
    (
      {
        ask_user_questions: "Questions",
        request_confirmation: "Confirmation",
        request_checkbox_confirmation: "Checkbox selection",
        request_item_verdicts: "Item review",
        suggest_tasks: "Suggested tasks",
        connection_intent: "Connect an app",
      } as Record<string, string>
    )[row.kind] ?? `Unsupported card: ${row.kind ?? "unknown"}`
  );
}

/** Both durable legacy answers and provider-neutral question responses are retained. */
export function questionReportAnswers(row: Row): Row[] {
  const answers = row.result?.answers;
  if (Array.isArray(answers)) return rows(answers);
  if (answers && typeof answers === "object")
    return Object.entries(answers).map(([id, answer]) => ({
      ...(answer as object),
      id,
      questionId: id,
    }));
  return [];
}
function option(
  label: unknown,
  description: unknown,
  checked: boolean,
  multi: boolean,
  recommended = false,
) {
  return `<label class="interaction-option${checked ? " is-selected" : ""}"><input type="${multi ? "checkbox" : "radio"}" disabled${checked ? " checked" : ""} aria-label="${html(label)}"><span><strong>${html(label)}</strong>${recommended ? badge("Recommended") : ""}${text(description, "interaction-help")}</span></label>`;
}
function questions(row: Row) {
  const p = row.payload ?? {},
    set = p.questionSet,
    answers = questionReportAnswers(row);
  const questions = rows(set?.questions ?? p.questions);
  return (
    text(set?.title ?? p.title, "interaction-title") +
    text(set?.description, "interaction-help") +
    questions
      .map((q, i) => {
        const answer = answers.find((a) => a.questionId === q.id);
        const selected = list(answer?.optionIds ?? answer?.selectedOptionIds);
        const written = answer?.otherText ?? answer?.customText ?? answer?.text;
        const mode =
          q.answerMode ??
          (q.selectionMode === "multi" ? "multi_select" : "single_select");
        const opts = rows(q.options);
        const freeOption = opts.find((o) => o.freeText === true);
        const custom = set
          ? q.customAnswer?.enabled === true
          : q.allowOther !== false && !freeOption;
        const hint =
          mode === "text"
            ? "Written answer"
            : mode === "multi_select"
              ? "Choose any that apply"
              : "Choose one";
        return `<section class="interaction-question"><div class="interaction-question-heading"><span>Question ${i + 1} of ${questions.length}${q.header ? ` · ${html(q.header)}` : ""}</span>${badge(q.required ? "Required" : "Optional")}</div>${text(q.prompt, "interaction-title")}${text(q.helpText, "interaction-help")}<p class="interaction-help">${hint}</p>${mode === "text" ? text(written ?? "Write your answer", `interaction-textbox${written == null ? " is-placeholder" : ""}`) : opts.map((o) => option(o.label, o.description, selected.includes(o.id) || (o.freeText === true && Boolean(written)), mode === "multi_select", o.recommended === true)).join("")}${mode !== "text" && custom ? option(q.customAnswer?.label ?? "Other", null, Boolean(written), mode === "multi_select") : ""}${mode !== "text" && (custom || freeOption || written != null) ? text(written ?? q.customAnswer?.placeholder ?? "Type your answer", `interaction-textbox${written == null ? " is-placeholder" : ""}`) : ""}${answer ? '<p class="interaction-help">Recorded answer</p>' : ""}</section>`;
      })
      .join("") +
    `<div class="interaction-actions">${action(set?.submitLabel ?? p.submitLabel ?? "Submit answers", false, true)}</div>`
  );
}
function target(p: Row) {
  const t = p.target;
  return t
    ? `<div class="interaction-target">${badge(t.type === "issue_document" ? "Document" : "Target")}<strong>${html(t.label ?? t.key)}</strong>${t.revisionNumber != null ? badge(`Revision ${t.revisionNumber}`) : ""}${t.href ? text(t.href, "interaction-help") : ""}</div>`
    : "";
}
function decisions(row: Row, accept?: string, reject?: string) {
  const p = row.payload ?? {},
    outcome = row.result?.outcome;
  return `<div class="interaction-actions">${action(accept ?? p.acceptLabel ?? "Approve", outcome === "accepted", true)}${action(reject ?? p.rejectLabel ?? "Reject", outcome === "rejected")}</div>${p.rejectRequiresReason ? text(p.rejectReasonLabel ?? "A reason is required to reject", "interaction-help") : ""}`;
}
function confirmation(row: Row) {
  const p = row.payload ?? {},
    tool = p.toolAction,
    secret = p.secretProposal,
    connection = p.connectionAuthorization;
  let extra = "";
  if (tool)
    extra =
      field("App", tool.appDisplayName) +
      field("Action", tool.toolDisplayName ?? tool.toolName) +
      field("Risk", tool.risk) +
      text(tool.previewMarkdown) +
      (tool.argumentsSummaryJson
        ? `<details class="interaction-arguments"><summary>Action arguments (recorded preview)</summary><pre>${html(tool.argumentsSummaryJson)}</pre></details>`
        : "") +
      field("Permission scope", tool.rememberActionScope) +
      field("Expires", tool.expiresAt);
  if (secret)
    extra =
      field("Credential", secret.sourceSecretLabel) +
      field("Agent", secret.targetAgentName) +
      field("Bind to", secret.configPath) +
      text(secret.justification) +
      field("Expires", secret.expiresAt);
  if (connection)
    extra =
      field("Provider", connection.providerName) +
      field("Connection", connection.connectionName) +
      field("Requested by", connection.requestingAgentName);
  return (
    text(p.prompt ?? row.title, "interaction-title") +
    text(p.detailsMarkdown) +
    extra +
    target(p) +
    decisions(
      row,
      tool
        ? "Approve & run"
        : secret
          ? (p.acceptLabel ?? "Approve & bind")
          : undefined,
      tool ? "Decline" : undefined,
    ) +
    (tool?.rememberActionScope
      ? `<details class="interaction-arguments"><summary>Approval options</summary>${action("Always allow")}</details>`
      : "")
  );
}
function checkboxes(row: Row) {
  const p = row.payload ?? {},
    result = row.result;
  const defaults =
    row.status === "pending" && result?.selectedOptionIds == null;
  const selected = list(
    defaults ? p.defaultSelectedOptionIds : result?.selectedOptionIds,
  );
  return (
    text(p.prompt ?? row.title, "interaction-title") +
    text(p.detailsMarkdown) +
    target(p) +
    text(
      `Select at least ${p.minSelected ?? 0}${p.maxSelected == null ? "" : ` and at most ${p.maxSelected}`}`,
      "interaction-help",
    ) +
    rows(p.options)
      .map((o) => option(o.label, o.description, selected.includes(o.id), true))
      .join("") +
    (defaults && selected.length
      ? text("Preselected defaults · not submitted", "interaction-help")
      : "") +
    decisions(row)
  );
}
function verdicts(row: Row) {
  const p = row.payload ?? {},
    items = rows(p.items),
    results = rows(row.result?.items),
    choices = list(p.verdicts ?? ["approve", "reject"]);
  const label: Record<string, string> = {
    approve: "Approve",
    reject: "Reject",
    defer: "Defer",
  };
  return (
    text(p.prompt ?? row.title, "interaction-title") +
    text(p.detailsMarkdown) +
    target(p) +
    items
      .map((item) => {
        const result = results.find((r) => r.id === item.id);
        return `<section class="interaction-question">${text(item.label, "interaction-title")}${text(item.description, "interaction-help")}${text(item.previewMarkdown)}${item.href ? field("Reference", item.href) : ""}<div class="interaction-actions">${choices.map((v) => action(label[v] ?? v, result?.verdict === v)).join("")}</div>${result?.reason ? field(p.reasonLabel ?? "Reason", result.reason) : ""}${!result ? text(`Reason required for: ${list(p.requireReasonOn ?? ["reject"]).join(", ") || "none"}`, "interaction-help") : ""}</section>`;
      })
      .join("")
  );
}
function tasks(row: Row, names: ReadonlyMap<string, string>) {
  const p = row.payload ?? {},
    all = rows(p.tasks),
    created = rows(row.result?.createdTasks),
    skipped = list(row.result?.skippedClientKeys);
  const visible = all.filter((t) => !t.hiddenInPreview);
  return (
    text(row.title ?? "Suggested tasks", "interaction-title") +
    text(`${visible.length} tasks shown`, "interaction-help") +
    visible
      .map((t) => {
        const parent = all.find(
          (other) => other.clientKey === t.parentClientKey,
        );
        const done = created.find((c) => c.clientKey === t.clientKey);
        return `<section class="interaction-question">${text(t.title, "interaction-title")}<div class="interaction-tags">${t.priority ? badge(t.priority) : ""}${t.workMode ? badge(t.workMode) : ""}${done ? badge(`Created · ${done.identifier ?? done.issueId}`) : skipped.includes(t.clientKey) ? badge("Skipped") : ""}</div>${text(t.description)}${field("Parent", parent?.title ?? t.parentId ?? p.defaultParentId)}${field("Assignee", names.get(t.assigneeAgentId) ?? t.assigneeAgentId ?? t.assigneeUserId)}${field("Project", t.projectId)}${list(t.labels).length ? field("Labels", t.labels.join(", ")) : ""}</section>`;
      })
      .join("") +
    `<div class="interaction-actions">${action("Create selected", false, true)}${action("Revise")}</div>`
  );
}
function connection(row: Row) {
  const p = row.payload ?? {};
  return (
    text(
      `Connect ${p.serviceName ?? p.serviceSlug ?? "an app"}`,
      "interaction-title",
    ) +
    text(
      `${p.requestingAgentName ?? "The agent"} needs this connection to continue.`,
    ) +
    field(
      "Purpose",
      p.purpose === "ai" ? "Agent runtime authentication" : undefined,
    ) +
    field("Setup state", p.phase) +
    `<div class="interaction-actions">${action(p.phase === "needs_retry" ? "Try again" : `Connect ${p.serviceName ?? "app"}`, false, true)}${action("Decline")}</div>`
  );
}

/** Pure HTML, no handlers, form submissions, embedded remote assets, or live task URLs. */
export function renderInteractionCard(
  row: Row,
  names: ReadonlyMap<string, string> = new Map(),
) {
  let content: string;
  switch (row.kind) {
    case "ask_user_questions":
      content = questions(row);
      break;
    case "request_confirmation":
      content = confirmation(row);
      break;
    case "request_checkbox_confirmation":
      content = checkboxes(row);
      break;
    case "request_item_verdicts":
      content = verdicts(row);
      break;
    case "suggest_tasks":
      content = tasks(row, names);
      break;
    case "connection_intent":
      content = connection(row);
      break;
    default:
      content =
        text(row.title ?? row.payload?.prompt, "interaction-title") +
        text(
          "No visual renderer is available for this card type. The complete retained payload is below.",
          "interaction-help",
        );
  }
  const r = row.result;
  const reason =
    r?.reason ??
    r?.rejectionReason ??
    r?.cancellationReason ??
    r?.expirationReason;
  const hasResolutionDetail =
    r &&
    (reason ||
      r.toolAction ||
      r.secretProposal ||
      r.cancelled ||
      (r.outcome && r.outcome !== row.status) ||
      r.complete != null);
  const resolution = hasResolutionDetail
    ? `<div class="interaction-resolution">${badge(r.outcome ?? (r.cancelled ? "cancelled" : row.status))}${text(reason)}${r.complete != null ? field("Review progress", `${rows(r.items).length}/${rows(row.payload?.items).length} items · ${r.complete ? "complete" : "incomplete"}`) : ""}${r.toolAction ? field("Tool execution", r.toolAction.status) + text(r.toolAction.resultSummary) + text(r.toolAction.errorMessage) : ""}${r.secretProposal ? field("Binding outcome", r.secretProposal.status) + text(r.secretProposal.errorCode) : ""}</div>`
    : "";
  return `<section class="report-interaction" aria-label="${html(interactionReportTitle(row))}"><div class="interaction-heading">${badge(row.status ?? "unknown")}<span>Read-only recording</span></div>${content}${resolution}${raw(row)}</section>`;
}
