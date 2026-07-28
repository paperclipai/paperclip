export const DECK_PRODUCT_FLOW_VERSION = "deck-product-flow.v1";
export const DECK_PRODUCT_FLOW_SEED = "paperclip:looa-767:deck-lab:2026-07-24";
export const DECK_PRODUCT_FLOW_FIXTURE_SOURCE = "ui/src/deck-product-flow/fixtures.ts";

export interface DeckProductFlowAgent {
  id: string;
  name: string;
  role: string;
  status: "idle" | "running";
  gradient: number;
}

export interface DeckProductFlowStage {
  id: string;
  label: string;
  detail: string;
}

export interface DeckProductFlowArtifact {
  name: string;
  kind: "story" | "image-sequence" | "iframe";
  state: "queued" | "active" | "frozen";
}

export interface DeckProductFlowFrame {
  id: string;
  label: string;
  eyebrow: string;
  headline: string;
  body: string;
  issueStatus: "todo" | "in_progress" | "in_review" | "done";
  activeAgentId: string;
  activeStageId: string;
  focus: string[];
  artifacts: DeckProductFlowArtifact[];
}

export interface DeckProductFlowFixture {
  version: string;
  seed: string;
  fixtureSource: string;
  companyName: string;
  projectName: string;
  issue: {
    identifier: string;
    title: string;
  };
  agents: DeckProductFlowAgent[];
  stages: DeckProductFlowStage[];
  frames: DeckProductFlowFrame[];
}

export const deckProductFlowFixture: DeckProductFlowFixture = {
  version: DECK_PRODUCT_FLOW_VERSION,
  seed: DECK_PRODUCT_FLOW_SEED,
  fixtureSource: DECK_PRODUCT_FLOW_FIXTURE_SOURCE,
  companyName: "Deck Lab",
  projectName: "Agent-Native Talks",
  issue: {
    identifier: "DECK-101",
    title: "Build a deck companion surface from product components",
  },
  agents: [
    { id: "strategist", name: "Strategist", role: "Narrative", status: "idle", gradient: 3 },
    { id: "forge", name: "Forge", role: "Production", status: "running", gradient: 5 },
    { id: "rook", name: "Rook", role: "Harness", status: "idle", gradient: 8 },
  ],
  stages: [
    {
      id: "seed",
      label: "Seed fixture",
      detail: "A synthetic company state is loaded outside production data.",
    },
    {
      id: "story",
      label: "Story surface",
      detail: "The same React surface renders in Storybook for capture.",
    },
    {
      id: "capture",
      label: "Capture frames",
      detail: "Playwright drives exact frame URLs for deterministic stills.",
    },
    {
      id: "embed",
      label: "Sandbox embed",
      detail: "A frozen static build can be iframed beside the deck.",
    },
  ],
  frames: [
    {
      id: "seeded-state",
      label: "01 Seed",
      eyebrow: "Synthetic instance",
      headline: "A product flow starts from a named fixture, not a live account.",
      body: "The deck sees a focused surface built from the UI package and the same token layer as the app.",
      issueStatus: "todo",
      activeAgentId: "strategist",
      activeStageId: "seed",
      focus: ["Fixture source pinned", "Production data excluded", "Chrome removed"],
      artifacts: [
        { name: "deck-product-flow.story", kind: "story", state: "queued" },
        { name: "frame-sequence", kind: "image-sequence", state: "queued" },
        { name: "sandbox-iframe", kind: "iframe", state: "queued" },
      ],
    },
    {
      id: "storybook-surface",
      label: "02 Story",
      eyebrow: "Captured product motion",
      headline: "Storybook owns the focused product surface for capture.",
      body: "Args select the frame; Playwright does the crop, viewport, and readiness checks.",
      issueStatus: "in_progress",
      activeAgentId: "forge",
      activeStageId: "story",
      focus: ["Story args are deterministic", "Real components only", "Keyboard focus visible"],
      artifacts: [
        { name: "deck-product-flow.story", kind: "story", state: "active" },
        { name: "frame-sequence", kind: "image-sequence", state: "queued" },
        { name: "sandbox-iframe", kind: "iframe", state: "queued" },
      ],
    },
    {
      id: "captured-sequence",
      label: "03 Capture",
      eyebrow: "Playwright sequence",
      headline: "Each frame is an addressable URL with a fixed viewport.",
      body: "The capture script writes exact-dimension PNGs and a manifest that records clips:false.",
      issueStatus: "in_review",
      activeAgentId: "rook",
      activeStageId: "capture",
      focus: ["Viewport fixed", "Fonts settled", "clips:false required"],
      artifacts: [
        { name: "deck-product-flow.story", kind: "story", state: "frozen" },
        { name: "frame-sequence", kind: "image-sequence", state: "active" },
        { name: "sandbox-iframe", kind: "iframe", state: "queued" },
      ],
    },
    {
      id: "frozen-embed",
      label: "04 Embed",
      eyebrow: "Sandbox companion",
      headline: "The deck embeds a frozen static artifact, never the app tree.",
      body: "Slidev receives an iframe, screenshots, or video. It never imports Paperclip React components into Vue.",
      issueStatus: "done",
      activeAgentId: "forge",
      activeStageId: "embed",
      focus: ["Static build versioned", "Iframe sandbox-ready", "React/Vue boundary clean"],
      artifacts: [
        { name: "deck-product-flow.story", kind: "story", state: "frozen" },
        { name: "frame-sequence", kind: "image-sequence", state: "frozen" },
        { name: "sandbox-iframe", kind: "iframe", state: "active" },
      ],
    },
  ],
};

export function clampDeckProductFlowFrame(index: number, frameCount = deckProductFlowFixture.frames.length) {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), Math.max(frameCount - 1, 0));
}
