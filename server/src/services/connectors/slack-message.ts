import { objects, type SlackObject, type slackClient } from "./slack-client.js";

/** A reply timestamp is not a history root; use its parent thread when supplied. */
export async function slackMessage(
  api: ReturnType<typeof slackClient>,
  args: SlackObject,
) {
  const response = args.thread_ts
    ? await api("conversations.replies", {
        channel: args.channel,
        ts: args.thread_ts,
        oldest: args.ts,
        latest: args.ts,
        inclusive: true,
        limit: 2,
      })
    : await api("conversations.history", {
        channel: args.channel,
        latest: args.ts,
        inclusive: true,
        limit: 1,
      });
  return (
    objects(response.messages).find((message) => message.ts === args.ts) ?? null
  );
}
