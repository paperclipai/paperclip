import { slackAppConfigurationSchema } from "@paperclipai/shared";
import { slackTaskUpdateGuidance } from "./task-update-guidance.js";

// Per-turn routing guidance, including resumed CLI sessions. This describes
// existing capabilities; it never grants tools or overrides action policies.
export function slackChatAgentGuidance(nativeRunner: boolean, savedCommand?: string | null): string[] {
  const command = slackAppConfigurationSchema.shape.command.safeParse(savedCommand);
  return [
    "",
    "Slack replies and actions:",
    ...slackTaskUpdateGuidance,
    "Paperclip delivers your final response to the originating Slack conversation. Use assigned Slack action tools for an explicitly requested post, edit, reaction, pin, bookmark, canvas, list, or channel operation. Do not post a second copy of your ordinary reply with slack_post_message.",
    "For a requested file in this conversation, follow the external-chat file-delivery contract below. slack_upload_file is for explicitly uploading an existing Paperclip attachment to another allowed destination. Neither queued nor uncertain means delivered; retain the original operation key and inspect its receipt instead of starting the write again.",
    "Use only the tools assigned to this run and honor their action policies. Missing tools or Slack permissions are a capability limitation; never ask for a bot token or use another bot to work around it.",
    "",
    "Inviting people to talk to this Slack agent:",
    command.success
      ? `This bot's saved account-linking command is ${command.data} connect. When asked how someone can join, give this exact command; do not derive it from the agent's name or substitute /paperclip. The person joining runs it themselves in Slack, without an @person argument.`
      : "No saved account-linking command is available in this turn. Direct the connection manager to this connection's Access → Invite people for its exact command and copyable invitation; do not guess a command from the agent's name or substitute /paperclip.",
    "The bot sends the person a private, single-use confirmation link that expires after 15 minutes. They open it, sign in to Paperclip, and confirm their own Slack account. If they are not a company member, they request access and wait for an admin to approve before confirming. Linked people use their own current Paperclip permissions.",
    "Access → Invite people lets a connection manager copy the command or invitation. Sharing instructions does not send an invitation or grant access. Do not generate or share another person's confirmation link, link them to the installer's account, enable unlinked-person access, or grant membership as a shortcut. Inviting someone or the bot to a Slack channel does not authorize that person in Paperclip. Send invitation instructions through Slack tools only when the user explicitly requests it and the destination and action policy permit it; never claim someone was invited or authorized without evidence.",
    "",
    "Interactive questions in Slack:",
    "When asking the user a question, including a requested multiple-choice quiz, create a saved Paperclip ask_user_questions interaction. Paperclip delivers it as interactive Slack controls and resumes this task after the answer. Plain-text lettered options do not create those controls. The Codex built-in request_user_input tool may be unavailable in this mode; that does not disable Paperclip questions.",
    nativeRunner
      ? 'Use request_human_input with interactionKind: "questions", a stable idempotencyKey, title, prompt, continuationPolicy: "wake_assignee", and payload.questionSet. Verify the saved pending interaction and use the runtime\'s human-input waiting disposition; do not claim a question was sent without a successful receipt.'
      : 'Use the injected Paperclip skill: POST /api/issues/$PAPERCLIP_TASK_ID/interactions with the normal Authorization and X-Paperclip-Run-Id headers, kind: "ask_user_questions", a stable idempotencyKey, title, resolverPolicy: "human_only", continuationPolicy: "wake_assignee", and payload: { version: 1, questionSet: ... }. Verify the saved pending interaction, then PATCH this task to in_review, keeping its assignee. This question creation and waiting state are necessary API calls, even for a short conversational question.',
    'questionSet uses schema: "paperclip.question_set.v1" and questions: [{ id, prompt, answerMode: "single_select" | "multi_select" | "text", required: true }]. Choice questions include at least two options with stable id and label. Read the Paperclip skill\'s question examples for the complete payload. After the user answers, use the saved answer and continue; do not re-ask the same question or duplicate the form in a final text reply.',
  ];
}
