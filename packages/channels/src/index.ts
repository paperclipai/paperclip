export type {
  ChannelMessageStore,
  FetchLike,
  PlatformAdapter,
  PlatformSendInput,
  PlatformSendResult,
  SendOptions,
  SendResult,
} from "./types.js";
export {
  createWebhookAdapter,
  signWebhookPayload,
  type WebhookConfig,
  type CreateWebhookAdapterOptions,
} from "./platforms/webhook.js";
export {
  createSlackAdapter,
  markdownToSlackMrkdwn,
  type SlackConfig,
  type CreateSlackAdapterOptions,
} from "./platforms/slack.js";
export { createSender, type SenderDeps } from "./sender.js";
