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
  if (!created) {
    if (!args.ts)
      throw forbidden("Supply the message that links this document");
    const message = await slackMessage(api, args);
    if (
      !message ||
      !objects(message.files).some((file) => file.id === args.file)
    )
      throw forbidden("Document must be linked from the authorized message");
  }
  const file = object((await api("files.info", { file: args.file })).file);
  if (file.id !== args.file)
    throw forbidden("Slack did not verify the requested document");
  if (write) {
    const [privateSource] = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, authority.endpoint.companyId),
          eq(chatActions.endpointId, authority.endpoint.id),
          eq(chatActions.kind, "slack_private_source"),
          sql`${chatActions.payload}->>'issueId' = ${authority.issueId}`,
        ),
      )
      .limit(1);
    if (privateSource)
      throw forbidden(
        "Slack does not expose a complete document sharing audience. Deliver private research as a message or upload in its source channel or your DM instead.",
      );
    const shares = object(file.shares);
    const destinations = [
      ...Object.keys(object(shares.public)),
      ...Object.keys(object(shares.private)),
    ];
    if (!created && !destinations.includes(String(args.channel)))
      throw forbidden("Slack did not provide verifiable document destinations");
    for (const channel of destinations)
      await authorizeSlackWrite(db, authority, api, channel);
  }
  return file;
}
