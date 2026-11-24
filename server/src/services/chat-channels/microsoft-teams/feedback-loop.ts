import { z } from "zod";

export const TEAMS_FEEDBACK_REASON_MAX_LENGTH = 1000;

const INSTALLED_HOOK = Symbol("paperclip.teams.feedback.hook");
const opaqueId = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\x00-\x20\x7f]+$/);

const feedbackActivitySchema = z.object({
  type: z.literal("invoke"),
  name: z.literal("message/submitAction"),
  channelId: z.literal("msteams"),
  id: opaqueId,
  serviceUrl: z.string().min(1).max(2048),
  replyToId: opaqueId,
  from: z.object({
    id: opaqueId,
    aadObjectId: z.string().max(256).optional(),
  }),
  recipient: z.object({ id: opaqueId }),
  conversation: z.object({
    id: opaqueId,
    conversationType: z.enum(["personal", "groupChat", "channel"]).optional(),
  }),
  value: z.object({
    actionName: z.literal("feedback"),
    actionValue: z.object({
      reaction: z.enum(["like", "dislike"]),
      feedback: z.unknown().optional(),
    }),
  }),
});

export interface TeamsFeedbackEvent {
  activityId: string;
  threadId: string;
  replyToId: string;
  userId: string;
  aadObjectId: string | null;
  vote: "up" | "down";
  reason: string | null;
}

export interface TeamsFeedbackThreadLocator {
  conversationId: string;
  conversationType?: "personal" | "groupChat" | "channel";
  serviceUrl: string;
}

export interface TeamsFeedbackApp {
  on(
    event: "message.submit.feedback",
    callback: (context: { activity: unknown }) => Promise<{ status: number }>,
  ): unknown;
}

export interface TeamsFeedbackHookOptions {
  botAppId: string;
  acceptsScope(activity: unknown): boolean;
  threadIdFor(locator: TeamsFeedbackThreadLocator): string;
  onFeedback(event: TeamsFeedbackEvent): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function feedbackReason(feedback: unknown): string | null {
  let form: unknown = feedback;
  if (typeof feedback === "string") {
    try {
      form = JSON.parse(feedback);
    } catch {
      return null;
    }
  }
  const text = isRecord(form) ? form.feedbackText : null;
  if (typeof text !== "string") return null;
  const trimmed = text.trim().slice(0, TEAMS_FEEDBACK_REASON_MAX_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseTeamsFeedbackInvoke(
  activity: unknown,
  options: Pick<TeamsFeedbackHookOptions, "botAppId" | "threadIdFor">,
): TeamsFeedbackEvent | null {
  const parsed = feedbackActivitySchema.safeParse(activity);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (a.recipient.id !== `28:${options.botAppId}`) return null;
  return {
    activityId: a.id,
    threadId: options.threadIdFor({
      conversationId: a.conversation.id,
      conversationType: a.conversation.conversationType,
      serviceUrl: a.serviceUrl,
    }),
    replyToId: a.replyToId,
    userId: a.from.id,
    aadObjectId: a.from.aadObjectId ?? null,
    vote: a.value.actionValue.reaction === "like" ? "up" : "down",
    reason: feedbackReason(a.value.actionValue.feedback),
  };
}

export function installTeamsFeedbackHook(
  app: TeamsFeedbackApp,
  options: TeamsFeedbackHookOptions,
): void {
  if (typeof app.on !== "function" || typeof options.onFeedback !== "function")
    throw new Error("Invalid Teams feedback hook configuration");
  if (Object.hasOwn(app, INSTALLED_HOOK))
    throw new Error("Teams feedback hook already installed");
  Object.defineProperty(app, INSTALLED_HOOK, { value: true });
  app.on("message.submit.feedback", async ({ activity }) => {
    const event = options.acceptsScope(activity)
      ? parseTeamsFeedbackInvoke(activity, options)
      : null;
    if (event) await options.onFeedback(event).catch(() => undefined);
    return { status: 200 };
  });
}

export function enableTeamsFeedbackLoop(activity: unknown): void {
  if (!isRecord(activity)) return;
  if (activity.type !== undefined && activity.type !== "message") return;
  activity.channelData = {
    ...(isRecord(activity.channelData) ? activity.channelData : {}),
    feedbackLoopEnabled: true,
  };
}

export function enableTeamsFeedbackLoopUpdates(api: unknown): void {
  const conversations = isRecord(api) ? api.conversations : null;
  if (!isRecord(conversations) || typeof conversations.activities !== "function")
    return;
  const activities = conversations.activities.bind(conversations) as (
    conversationId: string,
  ) => Record<string, unknown>;
  conversations.activities = (conversationId: string) => {
    const operations = activities(conversationId);
    const update = operations.update;
    if (typeof update !== "function") return operations;
    return {
      ...operations,
      update: (activityId: string, activity: unknown) => {
        enableTeamsFeedbackLoop(activity);
        return update(activityId, activity);
      },
    };
  };
}
