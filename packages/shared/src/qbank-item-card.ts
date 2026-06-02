export const QBANK_ITEM_DOCUMENT_KEY = "qbank-item" as const;
export const QBANK_MEDIA_BRIEF_DOCUMENT_KEY = "qbank-media-brief" as const;

export interface QBankAnswer {
  id?: number | string | null;
  text?: string | null;
  raw_content?: string | null;
  correct?: boolean | null;
  rationale?: string | null;
  raw_rationale?: string | null;
}

export interface QBankProductAssociation {
  app_id?: number | null;
  category_id?: number | null;
  visibility?: boolean | null;
  deleted?: boolean | null;
}

export interface QBankCategory {
  id?: number | null;
  app_id?: number | null;
  name?: string | null;
  published?: boolean | null;
  deleted?: boolean | null;
}

export interface QBankDiscussionThread {
  id?: number | string | null;
  title?: string | null;
  subject?: string | null;
  body?: string | null;
  content?: string | null;
  comment?: string | null;
  comments_count?: number | null;
  posts_count?: number | null;
  created_at?: number | string | null;
  updated_at?: number | string | null;
}

export interface QBankPartnerItem {
  id: number | string;
  type?: string | null;
  question_type?: string | null;
  question?: string | null;
  rationale?: string | null;
  key_takeaway?: string | null;
  draft_question?: string | null;
  draft_rationale?: string | null;
  draft_key_takeaway?: string | null;
  difficulty?: string | null;
  state?: string | null;
  updated_at?: number | string | null;
  created_at?: number | string | null;
  first_published_at?: number | string | null;
  revised_at?: number | string | null;
  v2_flashcard_id?: number | string | null;
  answers?: QBankAnswer[] | null;
  product_associations?: QBankProductAssociation[] | null;
  categories?: QBankCategory[] | null;
  discussion_threads?: QBankDiscussionThread[] | null;
}

export interface QBankSourceRefInput {
  appId: number | string;
  questionId: number | string;
}

export interface QBankItemSummary {
  sourceRef: string;
  appId: number | string;
  questionId: number | string;
  title: string;
  questionText: string;
  questionType: string | null;
  difficulty: string | null;
  state: string | null;
  correctAnswers: string[];
  answers: Array<{ text: string; correct: boolean; rationale: string }>;
  rationale: string;
  keyTakeaway: string;
  draftRationale: string;
  draftKeyTakeaway: string;
  hasDraftRevision: boolean;
  discussions: Array<{ id: string; title: string; body: string; commentsCount: number | null }>;
  appIds: number[];
  categoryNames: string[];
  mediaCandidates: string[];
}

export interface FormatQBankItemCardInput {
  appId: number | string;
  item: QBankPartnerItem;
}

export interface FormattedQBankItemCard {
  documentKey: typeof QBANK_ITEM_DOCUMENT_KEY;
  title: string;
  markdown: string;
  summary: QBankItemSummary;
}

export interface FormattedQBankMediaBrief {
  documentKey: typeof QBANK_MEDIA_BRIEF_DOCUMENT_KEY;
  title: string;
  markdown: string;
  summary: QBankItemSummary;
}

export function getQBankSourceRef(input: QBankSourceRefInput): string {
  return `qbank:app-${input.appId}/question-${input.questionId}`;
}

export function summarizeQBankItem(input: FormatQBankItemCardInput): QBankItemSummary {
  const questionId = input.item.id;
  const sourceRef = getQBankSourceRef({ appId: input.appId, questionId });
  const questionText = cleanHtml(input.item.question ?? "");
  const answers = (input.item.answers ?? []).map((answer) => {
    const text = cleanHtml(answer.text ?? answer.raw_content ?? "");
    const rationale = cleanHtml(answer.rationale ?? answer.raw_rationale ?? "");
    return { text, correct: answer.correct === true, rationale };
  });
  const correctAnswers = answers.filter((answer) => answer.correct).map((answer) => answer.text).filter(Boolean);
  const appIds = uniqueNumbers([
    Number(input.appId),
    ...(input.item.product_associations ?? []).map((association) => association.app_id),
    ...(input.item.categories ?? []).map((category) => category.app_id),
  ]);
  const categoryNames = uniqueStrings(
    (input.item.categories ?? [])
      .filter((category) => category.deleted !== true)
      .map((category) => cleanHtml(category.name ?? "")),
  );
  const rationaleSource = input.item.rationale ?? "";
  const mediaCandidates = uniqueStrings(extractImageSources(rationaleSource));
  const draftRationale = cleanHtml(input.item.draft_rationale ?? "");
  const draftKeyTakeaway = cleanHtml(input.item.draft_key_takeaway ?? "");
  const discussions = (input.item.discussion_threads ?? []).map((discussion) => ({
    id: String(discussion.id ?? "unknown"),
    title: cleanHtml(discussion.title ?? discussion.subject ?? ""),
    body: cleanHtml(discussion.body ?? discussion.content ?? discussion.comment ?? ""),
    commentsCount: discussion.comments_count ?? discussion.posts_count ?? null,
  }));

  return {
    sourceRef,
    appId: input.appId,
    questionId,
    title: buildTitle(questionId, questionText),
    questionText,
    questionType: input.item.question_type ?? input.item.type ?? null,
    difficulty: input.item.difficulty ?? null,
    state: input.item.state ?? null,
    correctAnswers,
    answers,
    rationale: cleanHtml(input.item.rationale ?? ""),
    keyTakeaway: cleanHtml(input.item.key_takeaway ?? ""),
    draftRationale,
    draftKeyTakeaway,
    hasDraftRevision: Boolean(cleanHtml(input.item.draft_question ?? "") || draftRationale || draftKeyTakeaway),
    discussions,
    appIds,
    categoryNames,
    mediaCandidates,
  };
}

export function formatQBankItemCard(input: FormatQBankItemCardInput): FormattedQBankItemCard {
  const summary = summarizeQBankItem(input);
  const lines: string[] = [
    `# QBank item ${summary.questionId}`,
    "",
    `Source ref: \`${summary.sourceRef}\``,
    `State: ${summary.state ?? "unknown"}`,
    `Type: ${summary.questionType ?? "unknown"}`,
    `Difficulty: ${summary.difficulty ?? "unknown"}`,
    `Apps: ${summary.appIds.length ? summary.appIds.join(", ") : String(input.appId)}`,
  ];

  if (summary.categoryNames.length) {
    lines.push(`Categories: ${summary.categoryNames.join(", ")}`);
  }

  lines.push("", "## Question", "", summary.questionText || "No question text returned.", "");

  if (summary.answers.length) {
    lines.push("## Answers", "");
    for (const answer of summary.answers) {
      const marker = answer.correct ? "✓" : "✗";
      const rationale = answer.rationale ? ` — ${answer.rationale}` : "";
      lines.push(`- ${marker} ${answer.text || "Untitled answer"}${rationale}`);
    }
    lines.push("");
  }

  lines.push(`Correct answer: ${summary.correctAnswers.join(", ") || "not returned"}`, "");

  if (summary.rationale) {
    lines.push("## Published rationale", "", summary.rationale, "");
  }

  if (summary.keyTakeaway) {
    lines.push("## Key takeaway", "", summary.keyTakeaway, "");
  }

  lines.push(`Draft revision: ${summary.hasDraftRevision ? "present" : "none returned"}`, "");
  if (summary.hasDraftRevision) {
    if (summary.draftRationale) {
      lines.push("### Draft rationale", "", summary.draftRationale, "");
    }
    if (summary.draftKeyTakeaway) {
      lines.push("### Draft key takeaway", "", summary.draftKeyTakeaway, "");
    }
  }

  if (summary.mediaCandidates.length) {
    lines.push("## Media candidates", "");
    for (const src of summary.mediaCandidates) {
      lines.push(`- Media candidate: ${src}`);
    }
    lines.push("");
  }

  if (summary.discussions.length) {
    lines.push("## Discussions and comments", "");
    for (const discussion of summary.discussions) {
      const title = discussion.title || `Discussion ${discussion.id}`;
      const count = discussion.commentsCount == null ? "" : ` (${discussion.commentsCount} comments/posts)`;
      lines.push(`- ${title}${count}${discussion.body ? ` — ${discussion.body}` : ""}`);
    }
    lines.push("");
  }

  lines.push(
    "## Suggested next actions",
    "",
    "- Review clinically/editorially before any public derivative.",
    "- Compare published and draft rationale if a draft revision is present.",
    "- Create MMM2 visual rationale plan when the concept benefits from a diagram or image.",
    "- Turn into article/social/email only as a public-safe concept derivative, not a raw QBank dump.",
  );

  return {
    documentKey: QBANK_ITEM_DOCUMENT_KEY,
    title: summary.title,
    markdown: lines.join("\n").trimEnd(),
    summary,
  };
}

export function formatQBankMediaBrief(input: FormatQBankItemCardInput): FormattedQBankMediaBrief {
  const summary = summarizeQBankItem(input);
  const correct = summary.correctAnswers.join(", ") || "the correct answer";
  const answerGrounding = summary.answers.map((answer) => answer.text).filter(Boolean).join(", ") || "not returned";
  const categoryHint = summary.categoryNames.join(", ") || summary.questionType || "clinical reasoning";
  const visualDirection = inferVisualDirection(summary);
  const lines: string[] = [
    "# QBank visual brief",
    "",
    `Source ref: \`${summary.sourceRef}\``,
    `Review mode: plan only — no image generation or publishing approved.`,
    `Document source: QBank item ${summary.questionId}`,
    `Apps: ${summary.appIds.length ? summary.appIds.join(", ") : String(input.appId)}`,
    `Category/context: ${categoryHint}`,
    "",
    "## Teaching objective",
    "",
    `Teaching objective: Explain why the correct answer is ${correct} using the item rationale and key takeaway.`,
    "",
    "## Grounding to preserve",
    "",
    `- Source question: ${summary.questionText || "No question text returned."}`,
    `- Preserve answer grounding: ${answerGrounding}`,
    `- Correct answer: ${correct}`,
  ];

  if (summary.rationale) {
    lines.push(`- Published rationale: ${summary.rationale}`);
  }
  if (summary.keyTakeaway) {
    lines.push(`- Key takeaway: ${summary.keyTakeaway}`);
  }
  if (summary.hasDraftRevision) {
    lines.push(`- Draft revision present: use for reviewer context only, not public copy by default.`);
  }

  lines.push("", "## Visual plan", "", `Visual direction: ${visualDirection}`);
  lines.push("- Recommended artifact: MMM2 visual rationale brief / diagram plan.");
  lines.push("- Public-safety boundary: teach the concept without publishing raw proprietary QBank wording unless explicitly approved.");
  lines.push("- Preserve clinical accuracy and answer-choice grounding for reviewer validation.");

  if (summary.mediaCandidates.length) {
    lines.push("", "## Source media candidates", "");
    for (const src of summary.mediaCandidates) {
      lines.push(`- ${src}`);
    }
  }

  lines.push(
    "",
    "## Next action",
    "",
    "Send this brief to MMM2 in review-only/planning mode. Stop before Cloudinary upload, image generation, publishing, or public reuse until an approver explicitly chooses that next step.",
  );

  return {
    documentKey: QBANK_MEDIA_BRIEF_DOCUMENT_KEY,
    title: `Visual brief for QBank item ${summary.questionId}`,
    markdown: lines.join("\n").trimEnd(),
    summary,
  };
}

function buildTitle(questionId: number | string, questionText: string): string {
  const cleaned = questionText.toLowerCase();
  if (cleaned.includes("ovarian cancer") && cleaned.includes("spread")) {
    return `QBank item ${questionId}: ovarian cancer has spread`;
  }
  const words = questionText
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  return `QBank item ${questionId}${words ? `: ${words}` : ""}`;
}

function inferVisualDirection(summary: QBankItemSummary): string {
  const text = [summary.questionText, summary.rationale, summary.keyTakeaway, summary.categoryNames.join(" ")].join(" ").toLowerCase();
  if (text.includes("bilirubin") || text.includes("jaundice") || text.includes("liver")) {
    return "liver/bilirubin pathway or organ-metastasis map";
  }
  if (text.includes("dose") || text.includes("dosage") || text.includes("calculate") || text.includes("calculation")) {
    return "step-by-step dosage calculation scaffold";
  }
  if (summary.mediaCandidates.length) {
    return "source-image anchored visual rationale with labeled teaching callouts";
  }
  return "concept map that shows the clinical cue, reasoning path, correct answer, and common wrong-answer trap";
}

function cleanHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<\/li>/gi, "; ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s*;\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;?/gi, " ")
    .replace(/&amp;?/gi, "&")
    .replace(/&quot;?/gi, '"')
    .replace(/&#39;?/gi, "'")
    .replace(/&lt;?/gi, "<")
    .replace(/&gt;?/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractImageSources(value: string): string[] {
  const sources: string[] = [];
  const imageSourcePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const match of value.matchAll(imageSourcePattern)) {
    sources.push(decodeHtmlEntities(match[1] ?? ""));
  }
  return sources.filter(Boolean);
}

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)))].sort(
    (a, b) => a - b,
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
