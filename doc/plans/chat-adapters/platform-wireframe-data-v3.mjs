import { providerScreens as v2Screens } from "./platform-wireframe-data.mjs";

const interactionAnnotations = {
  "15": [
    "Ari starts in a Slack channel with a root @maya mention; unrelated root messages do not start work.",
    "Maya acknowledges inside a Slack thread, making the thread—not the channel—the visible conversation boundary.",
    "Paperclip creates exactly one assigned issue and shows its Slack source, external participant, and publication state.",
    "Ari continues by replying in the same thread without another mention; files and actions remain in that context.",
    "Maya's safe progress and final answer publish in the thread; failures offer retry or a Paperclip link."
  ],
  "18": [
    "Ari mentions the bot in an existing GitHub issue, PR conversation, or inline review thread.",
    "Maya acknowledges with a reaction and one GitHub-Flavored Markdown comment rather than opening another thread.",
    "Paperclip binds that exact GitHub object or review thread to one assigned issue; PR conversation and inline review stay distinct.",
    "Later comments continue the same issue, while bot-authored comments and duplicate deliveries are ignored.",
    "Progress edits the existing comment; files and governed actions use authenticated Paperclip links."
  ],
  "21": [
    "Ari mentions Maya in a new Teams channel post; that post and its replies are the native thread.",
    "Maya acknowledges under the post. If the installed permissions cannot deliver unmentioned replies, the bot says to mention Maya again.",
    "Paperclip creates one assigned issue and records tenant, team/channel, thread, and external participant attribution.",
    "Replies, files, and Adaptive Card or task-module actions continue only when current Teams delivery and Paperclip permissions allow.",
    "DMs may stream natively; channel and group output buffers or edits, with targeted-message, DM, or text-link fallback."
  ],
  "24": [
    "In a DM, Ari's first message creates the active issue; New task or /new deliberately starts another.",
    "In a privacy-on group, @maya starts work and replying to Maya continues; unrelated group traffic is not consumed.",
    "A forum topic can bind one issue through message_thread_id when the bot is present and allowed.",
    "Paperclip shows the active issue and makes the linear-chat boundary explicit instead of implying a Slack-style native thread.",
    "Maya uses throttled post/edit and inline buttons; unsupported or governed actions return text or DM with a Paperclip link."
  ]
};

const interactionTitles = {
  "15": "How Slack conversations work",
  "18": "How GitHub conversations work",
  "21": "How Microsoft Teams conversations work",
  "24": "How Telegram conversations work"
};

const interactionSubtitles = {
  "15": "What Ari sees in Slack and the single Paperclip issue created behind the thread.",
  "18": "What Ari sees in GitHub and how the existing object becomes one Paperclip issue.",
  "21": "What Ari sees in a channel thread, with separate DM and group-chat behavior.",
  "24": "How DMs, privacy-on groups, and forum topics establish an explicit active issue."
};

export const providerScreens = v2Screens.map((screen) => {
  if (screen.kind !== "providerInteractions") return { ...screen };
  return {
    ...screen,
    title: interactionTitles[screen.id],
    subtitle: interactionSubtitles[screen.id],
    annotations: interactionAnnotations[screen.id],
    rationale: "This is a product-behavior walkthrough: the external conversation people see beside the Paperclip issue it creates."
  };
});
