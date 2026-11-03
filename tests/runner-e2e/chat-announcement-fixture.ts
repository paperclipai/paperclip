import type { AnnouncementManifest } from "../../packages/shared/src/announcements.js";

// Public synthetic content, served through the normal HTTPS announcement feed.
// Publishing is an explicit staging operation; this module never uploads it.
export const CHAT_ANNOUNCEMENT_SCENARIO = "navigation-preferences.dismiss-announcement";
export const CHAT_ANNOUNCEMENT_STAGING_NAME = "chat-dismissal-eval-20261103-02e2ff4a9469";
export const CHAT_ANNOUNCEMENT_HOST_PREFIX = "storybook/branches/codex-announcements";
export const CHAT_ANNOUNCEMENT_FEED_URL = `https://d1p6rlowie26tp.cloudfront.net/${CHAT_ANNOUNCEMENT_HOST_PREFIX}/announcements/staging/${CHAT_ANNOUNCEMENT_STAGING_NAME}/v1/current.json`;
export const CHAT_ANNOUNCEMENT_MANIFEST = {
  schemaVersion: 1,
  announcement: {
    id: "chat-dismissal-eval-20261103-v1",
    eyebrow: "Evaluation staging notice",
    title: "Your next idea starts here",
    description: "This synthetic staging notice is used only to verify personal announcement dismissal in an isolated evaluation instance.",
    primaryAction: { kind: "route", label: "Explore your projects", path: "/projects" },
  },
} as const satisfies AnnouncementManifest;
