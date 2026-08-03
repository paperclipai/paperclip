// Static option data for the onboarding flow, ported from the prototype
// (paperclip-onboard/src/data.js). Connectors + models are presentational in
// the first cut; wiring them to real integrations is a later refinement.
import {
  DEFAULT_TASK_DESCRIPTION,
  DEFAULT_TASK_TITLE,
} from "@/lib/onboarding-constants";

export const MISSION_CHIPS = [
  "Build a SaaS product",
  "Launch a marketplace",
  "Scale a content business",
];

export const ROLE_OPTIONS = [
  "Chief of Staff",
  "Chief Technical Officer",
  "Head of Marketing",
  "Researcher",
  "Coder",
  "Designer",
  "Other",
];

export const ROLE_ACRONYMS: Record<string, string> = {
  "Chief of Staff": "COS",
  "Chief Technical Officer": "CTO",
  "Head of Marketing": "HOM",
  Researcher: "RES",
  Coder: "CDR",
  Designer: "DES",
  Other: "OTH",
};

export interface ConnectorOption {
  name: string;
  description: string;
  /** Glyph background color. */
  color: string;
  /** Whether the glyph needs a border (for near-black glyphs). */
  border?: boolean;
  /** Short glyph text. */
  glyph: string;
}

export const CONNECTORS: ConnectorOption[] = [
  { name: "GitHub", description: "Code, PRs, issues", color: "#0a0a0a", border: true, glyph: "GH" },
  { name: "Google", description: "Gmail, Drive, Calendar", color: "#4285f4", glyph: "G" },
  { name: "Notion", description: "Docs and databases", color: "#0a0a0a", border: true, glyph: "N" },
  { name: "Linear", description: "Issues and projects", color: "#5e6ad2", glyph: "L" },
  { name: "Supabase", description: "Database and auth", color: "#3ecf8e", glyph: "S" },
  { name: "Slack", description: "Team messaging", color: "#611f69", glyph: "#" },
  { name: "Stripe", description: "Payments and billing", color: "#635bff", glyph: "$" },
  { name: "Vercel", description: "Deploys and hosting", color: "#0a0a0a", border: true, glyph: "▲" },
];

export type FirstTaskChoice = "hiring" | "strategy" | "custom";

/** Build the first-task title/description from the chosen option (shared by both flows). */
export function firstTaskPayload(
  choice: FirstTaskChoice,
  custom: string,
): { title: string; description: string } {
  switch (choice) {
    case "hiring":
      return { title: DEFAULT_TASK_TITLE, description: DEFAULT_TASK_DESCRIPTION };
    case "strategy":
      return {
        title: "Write a one-page team strategy",
        description:
          "You are the CEO. Turn the company mission into a one-page strategy: the goals, the bets you're making, and how you'll measure progress.",
      };
    case "custom":
      return {
        title: custom.trim() || "First task",
        description: custom.trim(),
      };
  }
}
