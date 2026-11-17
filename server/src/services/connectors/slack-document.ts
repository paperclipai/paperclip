import { and, eq, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import type { SlackTaskAuthority } from "./slack-authority.js";
import {
  object,
  objects,
  type slackClient,
  type SlackObject,
} from "./slack-client.js";
import { slackMessage } from "./slack-message.js";
import { authorizeSlackWrite } from "./slack-access.js";
import { SLACK_OTHER_USER_DM_OPTIONS } from "./slack-opt-ins.js";

function sharedThreadTs(file: SlackObject, channel: unknown, ts: unknown) {
  const shares = object(file.shares);
  for (const audience of [shares.public, shares.private])
    for (const share of objects(object(audience)[String(channel)]))
      if (share.ts === ts && typeof share.thread_ts === "string")
        return share.thread_ts;
  return undefined;
}

export async function authorizeSlackDocument(
  db: Db,
  authority: SlackTaskAuthority,
  api: ReturnType<typeof slackClient>,
  args: SlackObject,
  write: boolean,
) {
  const [created] = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, authority.endpoint.companyId),
        eq(chatActions.endpointId, authority.endpoint.id),
        eq(chatActions.kind, "slack_tool_write"),
        eq(chatActions.status, "processed"),
        sql`${chatActions.payload}->'binding'->>'issueId' = ${authority.issueId}`,
        sql`${chatActions.payload}->>'userId' = ${authority.userId}`,
        sql`${chatActions.payload}->'args'->>'channel' = ${args.channel}`,
        sql`(${chatActions.result}->>'canvasId' = ${args.file} or ${chatActions.result}->>'listId' = ${args.file})`,
      ),
    );
  let verified: SlackObject | undefined;
  const filesInfo = async () => {
    verified ??= object((await api("files.info", { file: args.file })).file);
    return verified;
  };
  if (!created) {
    if (!args.ts)
      throw forbidden("Supply the message that links this document");
    const links = (message: SlackObject | null) =>
      objects(message?.files).some((file) => file.id === args.file);
    let message = await slackMessage(api, args);
    // A reply is not in channel history. Slack records the thread of each
    // share on the file itself; use it to find the message, then verify the
    // message exactly as above rather than trusting the share entry.
    if (!links(message) && !args.thread_ts) {
      const threadTs = sharedThreadTs(await filesInfo(), args.channel, args.ts);
      if (threadTs) message = await slackMessage(api, { ...args, thread_ts: threadTs });
    }
    if (!links(message))
      throw forbidden(
        "Document must be linked from the authorized message. For a file attached in a thread reply, pass that reply's ts and the thread's parent ts as thread_ts.",
      );
  }
  const file = await filesInfo();
  if (file.id !== args.file)
    throw forbidden("Slack did not verify the requested document");
  if (write) {
    const shares = object(file.shares);
    const destinations = [
      ...Object.keys(object(shares.public)),
      ...Object.keys(object(shares.private)),
    ];
    if (!created && !destinations.includes(String(args.channel)))
      throw forbidden("Slack did not provide verifiable document destinations");
    for (const channel of destinations)
      await authorizeSlackWrite(db, authority, api, channel, SLACK_OTHER_USER_DM_OPTIONS);
  }
  return file;
}
