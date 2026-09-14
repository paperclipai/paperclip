import type { Announcement } from "@paperclipai/shared";

/** Design guide / Storybook only. Never a runtime feed fallback. */
export const announcementPreview: Announcement = {
  id: "preview-work-together",
  eyebrow: "New in Paperclip",
  title: "Give your next idea a team",
  description: "Bring agents, projects, and work together. Set the direction, then follow your team’s progress in Paperclip.",
  image: { path: `assets/${"0".repeat(64)}.png`, alt: "Paperclip — ideas become work" },
  secondaryLink: { kind: "external", label: "Learn more", url: "https://paperclip.ing" },
  primaryAction: { kind: "route", label: "Explore your projects", path: "/projects" },
};
