// Map a slide (+ client answers) to a real product screenshot snap,
// and define per-snap crop (scale + vertical offset) so the meaningful
// region fills the visual frame instead of showing whitespace.

const BASE = {
  solution: "voice-loop",
  demo: "transcript-pca",
  dashboard: "dashboard-performance",
  integrations: "integration-grid",
  compliance: "security-ledger",
  how_it_works: "workflow-editor",
  results: "dashboard-performance",
  objections: "evals-board",   // reliability/quality board answers objections
  market: "multi-agent"        // concurrent orchestration = scale story
};

const DEMO_BY_USECASE = {
  inbound_support: "live-transfer",
  receptionist: "caller-id-card",
  outbound_sales: "transcript-pca",
  collections: "sms-thread",
  scheduling: "calendar-book",
  qualification: "csv-audience",
  renewals: "transcript-pca",
  surveys: "knowledge-base"
};

// Snaps are responsive widgets. Rendered at FRAME_W they fill the width and
// reflow; we size the frame height to the measured render height (at 600px).
export const FRAME_W = 600;          // visual frame width in deck px

const SNAP_H = {
  "calendar-book": 370, "csv-audience": 420, "dashboard-performance": 336,
  "data-residency": 335, "evals-board": 463, "integration-grid": 438,
  "knowledge-base": 358, "live-transfer": 373, "multi-agent": 343,
  "security-ledger": 320, "transcript-pca": 380, "voice-library": 284,
  "voice-loop": 332, "workflow-editor": 367,
  "caller-id-card": 466, "compliance-badges": 323, "function-call": 434,
  "sms-thread": 420, "webhook-flow": 325
};

export const ALL_SNAPS = Object.keys(SNAP_H);

export function cropFor(file) {
  const key = file.replace(/\.html$/, "");
  const h = SNAP_H[key] || 380;
  return { frameW: FRAME_W, frameH: h };
}

export function snapFor(slideId, answers = {}) {
  // explicit override from UI picker
  const ov = answers.snapOverrides && answers.snapOverrides[slideId];
  if (ov) return ov === "none" ? null : ov;

  if (slideId === "demo") return (DEMO_BY_USECASE[answers.useCase] || BASE.demo) + ".html";
  if (slideId === "compliance" && answers.region === "india") return "data-residency.html";
  return BASE[slideId] ? BASE[slideId] + ".html" : null;
}
