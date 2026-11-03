import { defineLab } from "./define-lab";

export const registry = defineLab({
  slug: "needs-you",
  title: "Needs You",
  storyId: "design-needs-you-directions",
  group: "Patterns",
  capabilities: ["inbox-search/triage", "inbox-search/decisions"],
  publicUrl: "https://paperclip-needs-you-directions.vercel.app",
  surfaces: [
    { id: "landing", label: "Landing", width: 1040, nav: "other" },
    { id: "card", label: "Card", width: 640, nav: "other" },
    { id: "panel", label: "Review-panel", width: 434, nav: "other" },
  ],
  directions: [
    { id: "d1-focus", key: "1", name: "1.Focus", tagline: "Direction 1", stage: "proposed" },
    { id: "d2-workspace", key: "2", name: "2.Workspace", tagline: "Direction 2", stage: "proposed" },
    { id: "today", key: "0", name: "0.Today", tagline: "What ships now", baseline: true, stage: "shipped" },
  ],
  baselinePosition: "last",
  landing: { direction: "all", view: "landing" },
  today: { flags: {} },
  shell: {
    company: { id: "company-acmehats", name: "acmehats", issuePrefix: "ACM" },
    tasks: [
      { identifier: "ACM-1", title: "Paperclip onboarding" },
      { identifier: "ACM-2", title: "Develop acmehats brand strategy and designer brief" },
      { identifier: "ACM-3", title: "Create visual directions and first acmehats brand deck" },
    ],
  },
  provenance: { runtimeCommit: "634b5966e", skillVersion: "1", createdAt: "2026-11-03" },
  allow: [],
});
