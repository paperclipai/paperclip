import type { LabArtifact, LabGroup, LabKind, LabRun } from "./kit";
import * as docs from "./fixture-documents";
import sheetFirstDraft from "./assets/contact-sheet-first-draft.svg";
import sheetInterfaceCraft from "./assets/contact-sheet-interface-craft.svg";
import sheetRevised from "./assets/contact-sheet-revised.svg";
import shotForest from "./assets/cap-shot-forest.svg";
import shotCobalt from "./assets/cap-shot-cobalt.svg";
import shotBlack from "./assets/cap-shot-black.svg";
import logoLockup from "./assets/acmehats-logo-lockup.svg";
import reelPoster from "./assets/cap-reel-poster.svg";
import reelVideo from "./assets/cap-reel.webm";
import storefrontPreview from "./assets/storefront-preview.svg";
import avatarCeo from "./assets/avatar-ceo.svg";
import avatarDesigner from "./assets/avatar-designer.svg";

/**
 * The acmehats fixture world: the three stacks in the reference screenshots
 * (ACM-1 = 7 artifacts, ACM-3 = 21, ACM-2 = 1) and three more in the same
 * company so the gallery has six and every `LabKind` appears at least once.
 */

export const COMPANY = { id: "company-acmehats", name: "acmehats", issuePrefix: "ACM" };
export const DESIGNER = "Brand and Presentation Designer";
export const CEO = "CEO";
export const AVATARS: Record<string, string> = { [DESIGNER]: avatarDesigner, [CEO]: avatarCeo };

export const TASKS = {
  "ACM-1": "Paperclip onboarding",
  "ACM-2": "Develop acmehats brand strategy and designer brief",
  "ACM-3": "Create visual directions and first acmehats brand deck",
  "ACM-4": "Write the launch email sequence",
  "ACM-5": "Shoot cap product photos for the storefront",
  "ACM-6": "Build the wholesale pricing model",
} as const;
type TaskId = keyof typeof TASKS;

const MIME = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  md: "text/markdown",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  webm: "video/webm",
  otf: "font/otf",
} as const;
type Ext = keyof typeof MIME;

// Same wording the product's cards produce (`formatDateTime`, `formatDate`).
const dateTimeLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Markdown to the plain text a preview can set in any face; paragraph breaks survive. */
function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/[*_`]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const run = (id: string, agent: string, startedAt: string): LabRun => ({
  id,
  agent,
  startedAt,
  startedLabel: dateTimeLabel(startedAt),
});

interface Seed extends Partial<Omit<LabArtifact, "updatedAt" | "kind" | "title" | "id">> {
  at: string;
  task: TaskId;
}

function artifact(id: string, kind: LabKind, title: string, seed: Seed): LabArtifact {
  const { at, task, ...rest } = seed;
  const ext = rest.ext ?? rest.filename?.split(".").pop();
  return {
    author: DESIGNER,
    ...rest,
    id,
    kind,
    title,
    ext,
    contentType: rest.contentType ?? (ext && ext in MIME ? MIME[ext as Ext] : undefined),
    sizeLabel: rest.byteSize != null ? sizeLabel(rest.byteSize) : undefined,
    excerpt: rest.excerpt ?? (rest.body ? plain(rest.body) : undefined),
    updatedAt: at,
    updatedLabel: dateTimeLabel(at),
    dayLabel: dayLabel(at),
    taskIdentifier: task,
    taskTitle: TASKS[task],
  };
}

const taskDocument = (id: string, title: string, key: string, revision: number, body: string, seed: Seed) =>
  artifact(id, "document", title, { filename: `${key}.md`, revision, body, ...seed });

// ---------------------------------------------------------------------------
// ACM-3 — Create visual directions and first acmehats brand deck (21)
// ---------------------------------------------------------------------------

const RUN_IC = run("run-interface-craft", DESIGNER, "2026-09-28T10:52:00");
const RUN_REVISED = run("run-revised", DESIGNER, "2026-09-26T15:40:00");
const RUN_DRAFT = run("run-first-draft", DESIGNER, "2026-09-25T13:20:00");
const T3 = { task: "ACM-3" } as const;

const docCritique = taskDocument("doc-critique", "Interface Craft critique and implemented changes", "interface-craft-critique", 1, docs.DOC_CRITIQUE, { ...T3, at: "2026-09-28T11:07:00" });
const docGuideVerification = taskDocument("doc-guide-verification", "Interface Craft deck guide and verification", "interface-craft-deck-guide", 3, docs.DOC_GUIDE_VERIFICATION, { ...T3, at: "2026-09-28T11:06:00" });
const docSuppliedSource = taskDocument("doc-supplied-source", "Interface Craft — supplied source", "interface-craft-source", 1, docs.DOC_SUPPLIED_SOURCE, { ...T3, at: "2026-09-28T10:58:00" });
const docRevisionBrief = taskDocument("doc-revision-brief", "Approved consolidated deck revision brief", "approved-revision-brief", 1, docs.DOC_REVISION_BRIEF, { ...T3, at: "2026-09-26T15:32:00", author: CEO });
const docRevisionNotes = taskDocument("doc-revision-notes", "Consolidated revision notes", "consolidated-revision-notes", 2, docs.DOC_REVISION_NOTES, { ...T3, at: "2026-09-26T16:48:00" });
const docDraftVerification = taskDocument("doc-draft-verification", "First-draft deck guide and verification", "first-draft-deck-guide", 2, docs.DOC_FIRST_DRAFT_VERIFICATION, { ...T3, at: "2026-09-25T13:26:00" });
const docVisualStrategy = taskDocument("doc-visual-strategy", "Visual direction strategy", "visual-direction-strategy", 1, docs.DOC_VISUAL_STRATEGY, { ...T3, at: "2026-09-25T11:42:00" });

const IC = { ...T3, run: RUN_IC, review: "needs_review" } as const;
const icZip = artifact("ic-zip", "archive", "Interface Craft revision — editable source", { ...IC, at: "2026-09-28T11:07:50", filename: "editing-source.zip", byteSize: 189030, summary: "Layout source, fonts list and build notes" });
const icGuide = artifact("ic-guide", "document", "Interface Craft revision — deck guide", { ...IC, at: "2026-09-28T11:07:10", filename: "deck-guide.md", byteSize: 6042, summary: "Sources, assumptions, editing notes and verification", body: docs.MD_INTERFACE_CRAFT_GUIDE, commentCount: 0 });
const icImage = artifact("ic-image", "image", "Interface Craft revision — slide overview", { ...IC, at: "2026-09-28T11:07:00", filename: "contact-sheet.png", byteSize: 433050, summary: "All 12 revised slides", thumbnailUrl: sheetInterfaceCraft, aspect: 4 / 3 });
const icPdf = artifact("ic-pdf", "pdf", "Interface Craft revision — PDF", { ...IC, at: "2026-09-28T11:07:00", filename: "acmehats-interface-craft.pdf", byteSize: 59085, summary: "Inspected 12-page visual reference", pageCount: 12 });
const icPptx = artifact("ic-pptx", "slides", "Interface Craft revision — editable PowerPoint", { ...IC, at: "2026-09-28T11:07:20", filename: "acmehats-interface-craft.pptx", byteSize: 92262, summary: "12 editable slides, native text and shapes", pageCount: 12 });

const REVISED = { ...T3, run: RUN_REVISED } as const;
const revPptx = artifact("rev-pptx", "slides", "Revised editable brand deck", { ...REVISED, at: "2026-09-28T11:07:15", filename: "acmehats-revised.pptx", byteSize: 84173, pageCount: 12 });
const revPdf = artifact("rev-pdf", "pdf", "Revised brand deck — PDF", { ...REVISED, at: "2026-09-28T11:07:05", filename: "acmehats-revised.pdf", byteSize: 66970, summary: "Inspected 12-page visual reference", pageCount: 12 });
const revImage = artifact("rev-image", "image", "Revised slide overview", { ...REVISED, at: "2026-09-28T11:06:40", filename: "contact-sheet.png", byteSize: 401818, summary: "Contact sheet of the consolidated revision", thumbnailUrl: sheetRevised, aspect: 4 / 3 });
const revGuide = artifact("rev-guide", "document", "Revised deck guide", { ...REVISED, at: "2026-09-28T11:06:30", filename: "deck-guide.md", byteSize: 5325, summary: "What changed against the approved brief", body: docs.MD_REVISED_GUIDE, commentCount: 2 });
const revZip = artifact("rev-zip", "archive", "Revised editing source", { ...REVISED, at: "2026-09-28T11:06:20", filename: "editing-source.zip", byteSize: 176435 });

const DRAFT = { ...T3, run: RUN_DRAFT, review: "needs_review" } as const;
const draftPptx = artifact("draft-pptx", "slides", "acmehats first draft — editable deck", { ...DRAFT, at: "2026-09-28T11:07:45", filename: "acmehats-first-draft.pptx", byteSize: 71987, pageCount: 12 });
const draftImage = artifact("draft-image", "image", "First-draft slide overview", { ...DRAFT, at: "2026-09-28T11:07:40", filename: "contact-sheet.png", byteSize: 388403, summary: "Contact sheet of all 12 inspected final pages", thumbnailUrl: sheetFirstDraft, aspect: 4 / 3 });
const draftPdf = artifact("draft-pdf", "pdf", "acmehats first draft — PDF", { ...DRAFT, at: "2026-09-28T11:07:30", filename: "acmehats-first-draft.pdf", byteSize: 81613, pageCount: 12 });
const draftGuide = artifact("draft-guide", "document", "acmehats first-draft deck guide", { ...DRAFT, at: "2026-09-28T11:06:10", filename: "deck-guide.md", byteSize: 6554, summary: "Recommendation, sources and assumptions", body: docs.MD_FIRST_DRAFT_GUIDE, commentCount: 0 });

/** ACM-3 as the Artifacts page lists it: newest edit first. */
const ACM3_GALLERY: LabArtifact[] = [
  icZip, draftPptx, draftImage, draftPdf, icPptx, revPptx, icGuide, revPdf, icImage,
  icPdf, docCritique, revImage, docGuideVerification, revGuide, revZip, draftGuide,
  docSuppliedSource, docRevisionNotes, docRevisionBrief, docDraftVerification, docVisualStrategy,
];

/**
 * ACM-3 as the task's Artifacts tab lists it: the ungrouped task documents
 * first, then each producing run, newest run first.
 */
export const PANEL_ARTIFACTS: LabArtifact[] = [
  docCritique, docSuppliedSource, docGuideVerification, docRevisionNotes, docRevisionBrief, docDraftVerification, docVisualStrategy,
  icZip, icGuide, icImage, icPdf, icPptx,
  revPptx, revPdf, revImage, revGuide, revZip,
  draftImage, draftGuide, draftPdf, draftPptx,
];

/** Under the agent's message: one image and four files (pptx, pdf, md, zip). */
export const THREAD_ATTACHMENTS: LabArtifact[] = [icImage, icPptx, icPdf, icGuide, icZip];

/** Between turns, in thread order. */
export const THREAD_WORK_PRODUCTS: LabArtifact[] = [docCritique, docGuideVerification, icPptx, icPdf, icImage, docSuppliedSource];

// ---------------------------------------------------------------------------
// ACM-1 — Paperclip onboarding (7)
// ---------------------------------------------------------------------------

const T1 = { task: "ACM-1", author: CEO } as const;
const ACM1: LabArtifact[] = [
  taskDocument("a1-ceo-review", "Interface Craft pass — CEO review", "interface-craft-ceo-review", 1, docs.DOC_CEO_REVIEW, { ...T1, at: "2026-09-28T11:18:00" }),
  artifact("a1-packet", "pdf", "Founder review packet", { ...T1, at: "2026-09-28T11:16:00", filename: "founder-review-packet.pdf", byteSize: 148480, summary: "Deck, strategy and open decisions in one file", pageCount: 18, review: "needs_review" }),
  artifact("a1-storefront", "link", "Storefront preview", { ...T1, at: "2026-09-27T16:05:00", url: "https://preview.acmehats.example/storefront", summary: "Homepage and cap configurator, first pass", thumbnailUrl: storefrontPreview, aspect: 16 / 9 }),
  taskDocument("a1-founder-questions", "Founder questions and decisions", "founder-questions", 4, docs.DOC_FOUNDER_QUESTIONS, { ...T1, at: "2026-09-27T09:30:00" }),
  taskDocument("a1-first-draft-review", "First draft — CEO review", "first-draft-ceo-review", 1, docs.DOC_FIRST_DRAFT_REVIEW, { ...T1, at: "2026-09-25T14:02:00" }),
  artifact("a1-logo", "image", "Supplied logo lockup", { ...T1, at: "2026-09-24T10:12:00", filename: "acmehats-logo-supplied.png", byteSize: 96461, summary: "As supplied by the founder; raster only", thumbnailUrl: logoLockup, aspect: 2 }),
  taskDocument("a1-onboarding-plan", "acmehats onboarding plan", "onboarding-plan", 2, docs.DOC_ONBOARDING_PLAN, { ...T1, at: "2026-09-24T09:48:00" }),
];

// ---------------------------------------------------------------------------
// ACM-2 — Develop acmehats brand strategy and designer brief (1)
// ---------------------------------------------------------------------------

const ACM2: LabArtifact[] = [
  taskDocument("a2-brief", "acmehats — brand strategy and designer brief", "brand-strategy-brief", 1, docs.DOC_BRAND_STRATEGY, { task: "ACM-2", author: "Brand Strategist", at: "2026-09-25T10:14:00" }),
];

// ---------------------------------------------------------------------------
// ACM-4 — Write the launch email sequence (5)
// ---------------------------------------------------------------------------

const T4 = { task: "ACM-4", author: "Lifecycle Marketer" } as const;
const RUN_EMAIL = run("run-email", "Lifecycle Marketer", "2026-09-26T09:10:00");
const a4Csv = artifact("a4-segments", "sheet", "Launch audience segments", { ...T4, run: RUN_EMAIL, at: "2026-09-26T10:22:00", filename: "launch-audience-segments.csv", byteSize: 2380, summary: "4 segments · 3,825 contacts", excerpt: docs.CSV_AUDIENCE_SEGMENTS });
const a4Html = artifact("a4-template", "code", "Email template", { ...T4, run: RUN_EMAIL, at: "2026-09-26T10:05:00", filename: "email-template.html", byteSize: 4310, summary: "Table layout, tested at 600px", excerpt: docs.HTML_EMAIL_TEMPLATE });
const ACM4: LabArtifact[] = [
  taskDocument("a4-sequence", "Launch sequence — five emails", "launch-sequence", 2, docs.DOC_LAUNCH_SEQUENCE, { ...T4, at: "2026-09-26T10:40:00" }),
  a4Csv,
  a4Html,
  taskDocument("a4-subject-lines", "Subject line variants", "subject-line-variants", 1, docs.DOC_SUBJECT_LINES, { ...T4, at: "2026-09-26T09:52:00" }),
  taskDocument("a4-welcome", "Welcome email — draft", "welcome-email", 3, docs.DOC_WELCOME_EMAIL, { ...T4, at: "2026-09-26T09:31:00" }),
];

// ---------------------------------------------------------------------------
// ACM-5 — Shoot cap product photos for the storefront (6)
// ---------------------------------------------------------------------------

const T5 = { task: "ACM-5", author: "Product Photographer", run: run("run-shoot", "Product Photographer", "2026-09-27T13:05:00") } as const;
const a5Reel = artifact("a5-reel", "video", "Signal orange — 360° turntable", { ...T5, at: "2026-09-27T14:44:00", filename: "signal-orange-360.webm", byteSize: 3565158, summary: "Six-second loop for the product page", thumbnailUrl: reelPoster, videoUrl: reelVideo, aspect: 16 / 9, durationLabel: "0:06" });
const a5Font = artifact("a5-font", "file", "Label typeface for retouching", { ...T5, at: "2026-09-27T13:20:00", filename: "AcmeGrotesk-Medium.otf", byteSize: 118580, summary: "Licensed for mockups only" });
const ACM5: LabArtifact[] = [
  artifact("a5-forest", "image", "Forest green — studio hero", { ...T5, at: "2026-09-27T15:12:00", filename: "cap-forest-hero.jpg", byteSize: 1289748, summary: "Warm paper sweep, soft key light", thumbnailUrl: shotForest, aspect: 3 / 2, review: "needs_review" }),
  artifact("a5-cobalt", "image", "Cobalt — square crop for the grid", { ...T5, at: "2026-09-27T15:04:00", filename: "cap-cobalt-square.jpg", byteSize: 912384, thumbnailUrl: shotCobalt, aspect: 1 }),
  artifact("a5-black", "image", "Black and cream — stacked, portrait", { ...T5, at: "2026-09-27T14:58:00", filename: "cap-black-portrait.jpg", byteSize: 1048576, summary: "For the mobile product page", thumbnailUrl: shotBlack, aspect: 4 / 5, review: "changes_requested" }),
  a5Reel,
  // Audio: media the gallery cannot preview.
  artifact("a5-sting", "file", "Brand sting — 12 second loop", { ...T5, at: "2026-09-27T14:40:00", filename: "acmehats-sting.mp3", byteSize: 412_672, summary: "For the product page loop" }),
  artifact("a5-selects", "archive", "Full-resolution selects", { ...T5, at: "2026-09-27T14:30:00", filename: "cap-shoot-selects.zip", byteSize: 48234496, summary: "14 retouched frames" }),
  a5Font,
];

// ---------------------------------------------------------------------------
// ACM-6 — Build the wholesale pricing model (3)
// ---------------------------------------------------------------------------

const T6 = { task: "ACM-6", author: "Finance Analyst" } as const;
const a6Model = artifact("a6-model", "sheet", "Wholesale pricing model", { ...T6, run: run("run-pricing", "Finance Analyst", "2026-09-24T14:10:00"), at: "2026-09-24T15:36:00", filename: "wholesale-pricing-model.xlsx", byteSize: 38912, summary: "4 tiers · margin by order size", excerpt: docs.CSV_PRICING_TIERS, review: "needs_review" });
const ACM6: LabArtifact[] = [
  a6Model,
  artifact("a6-summary", "pdf", "Pricing summary for the founder", { ...T6, at: "2026-09-24T15:30:00", filename: "pricing-summary.pdf", byteSize: 44237, summary: "One page: tiers, margins, break-even", pageCount: 1 }),
  taskDocument("a6-assumptions", "Pricing assumptions and sources", "pricing-assumptions", 1, docs.DOC_PRICING_ASSUMPTIONS, { ...T6, at: "2026-09-24T14:52:00" }),
];

// ---------------------------------------------------------------------------

function group(task: TaskId, artifacts: LabArtifact[]): LabGroup {
  return {
    id: `task:${task}`,
    taskIdentifier: task,
    title: TASKS[task],
    count: artifacts.length,
    updatedLabel: dateLabel(artifacts[0].updatedAt),
    artifacts,
  };
}

const G1 = group("ACM-1", ACM1);
const G2 = group("ACM-2", ACM2);
const G3 = group("ACM-3", ACM3_GALLERY);
const G4 = group("ACM-4", ACM4);
const G5 = group("ACM-5", ACM5);
const G6 = group("ACM-6", ACM6);

/** Stacks, most recently updated first. */
export const GROUPS: LabGroup[] = [G1, G3, G5, G4, G2, G6];
export const OPEN_GROUP: LabGroup = G3;

/** One specimen of every `LabKind`, in `LAB_KINDS` order, for the vocabulary sheet. */
export const KIND_SPECIMENS: LabArtifact[] = [
  docCritique,
  icImage,
  a5Reel,
  icPdf,
  icPptx,
  a6Model,
  icZip,
  { ...a4Html },
  a5Font,
  ACM1[2],
  // A Markdown file is a `document` too, but the product treats it as a file.
  icGuide,
  // The non-default review state.
  ACM5[2],
];

export const BRAND_TOKENS_SPECIMEN: LabArtifact = artifact("specimen-tokens", "code", "Brand tokens", {
  task: "ACM-3",
  at: "2026-09-28T11:05:00",
  filename: "brand-tokens.json",
  byteSize: 412,
  excerpt: docs.JSON_BRAND_TOKENS,
});

/** A single-artifact, a three-artifact and a 21-artifact stack. */
export const STACK_SPECIMENS: LabGroup[] = [G2, G6, G3];

export function findArtifact(id: string): LabArtifact | undefined {
  for (const g of GROUPS) {
    const hit = g.artifacts.find((a) => a.id === id);
    if (hit) return hit;
  }
  return undefined;
}
