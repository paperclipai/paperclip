import { authorizeSlackDocument } from "./slack-document.js";
import { slackMessage } from "./slack-message.js";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  assets,
  chatActions,
  chatEndpoints,
  chatEndpointResources,
  issueAttachments,
  toolInvocations,
  type Db,
} from "@paperclipai/db";
import { SLACK_TOOLS } from "@paperclipai/shared";
import { conflict, forbidden, HttpError, unprocessable } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import {
  resolveSlackTaskAuthority,
  type SlackTaskBinding,
} from "./slack-authority.js";
import {
  authorizeSlackWrite,
  slackPublicationAllowed,
  recordSlackOriginBoundary,
} from "./slack-access.js";
import {
  slackClient,
  object,
  objects,
  type SlackObject,
} from "./slack-client.js";
import { logActivity } from "../activity-log.js";

const richText = (text: unknown) => [
  {
    type: "rich_text",
    elements: [
      { type: "rich_text_section", elements: [{ type: "text", text }] },
    ],
  },
];
export async function executeSlackWrite(
  db: Db,
  binding: SlackTaskBinding,
  name: string,
  args: SlackObject,
  invocationId: string | undefined,
  fetchImpl = fetch,
) {
  const tool = SLACK_TOOLS.find((t) => t.name === name)!;
  let authority = await resolveSlackTaskAuthority(db, binding);
  if (authority.workMode !== "standard")
    throw forbidden("Slack writes require standard work mode");
  const [invocation] = invocationId
    ? await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.companyId, binding.companyId),
            eq(toolInvocations.id, invocationId),
            eq(toolInvocations.runId, binding.runId),
            eq(toolInvocations.agentId, binding.agentId),
            eq(toolInvocations.connectionId, authority.endpoint.connectionId),
          ),
        )
    : [];
  if (
    !invocation ||
    invocation.status !== "executing" ||
    (tool.risk === "approval" && invocation.approvalState !== "approved")
  )
    throw forbidden(
      "Slack writes require a governed invocation and any required approval",
    );
  const api = slackClient(authority.botToken, fetchImpl);
  await recordSlackOriginBoundary(db, authority, api);
  if (
    name === "slack_create_channel" &&
    !(await slackPublicationAllowed(
      db,
      binding.companyId,
      authority.endpoint.id,
      binding.issueId,
      "new-channel",
      null,
    ))
  )
    throw forbidden(
      "Create channels in a separate task before reading private research; its content cannot be published to a new destination",
    );
  if (name !== "slack_create_channel" && name !== "slack_open_dm")
    await authorizeSlackWrite(db, authority, api, String(args.channel));
  if (
    name === "slack_invite" &&
    (args.users as string[]).includes(authority.endpoint.botExternalId!)
  )
    throw forbidden("The bot cannot expand its own access");
  const hash = createHash("sha256")
    .update(JSON.stringify({ name, args }))
    .digest("hex");
  const key = `slack-tool:${binding.issueId}:${args.idempotencyKey}`;
  const [created] = await db
    .insert(chatActions)
    .values({
      companyId: binding.companyId,
      endpointId: authority.endpoint.id,
      conversationId: authority.conversation?.id ?? null,
      principalId: authority.principalId,
      kind: "slack_tool_write",
      providerActionId: key,
      status: "received",
      payload: {
        name,
        args,
        hash,
        binding,
        userId: authority.userId,
        revision: authority.revision,
        invocationId,
      },
    })
    .onConflictDoNothing()
    .returning();
  const action =
    created ??
    (
      await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, authority.endpoint.id),
            eq(chatActions.providerActionId, key),
          ),
        )
    )[0]!;
  if (
    action.payload.hash !== hash ||
    action.payload.userId !== authority.userId
  )
    throw conflict(
      "Idempotency key already belongs to a different Slack operation",
    );
  if (action.status === "processed")
    return { actionId: action.id, state: "delivered", ...action.result };
  if (action.status !== "received")
    return {
      actionId: action.id,
      state: action.status,
      instruction:
        "Do not retry with another key. Inspect delivery before reconciling an uncertain result.",
    };
  const [claimed] = await db
    .update(chatActions)
    .set({ status: "processing", updatedAt: new Date() })
    .where(
      and(eq(chatActions.id, action.id), eq(chatActions.status, "received")),
    )
    .returning();
  if (!claimed) return { actionId: action.id, state: "processing" };
  try {
    authority = await resolveSlackTaskAuthority(db, binding);
    if (authority.workMode !== "standard")
      throw forbidden("Slack writes require standard work mode");
    if (authority.revision !== action.payload.revision)
      throw forbidden(
        "Slack authorization changed after this operation was queued",
      );
    if (name !== "slack_create_channel" && name !== "slack_open_dm")
      await authorizeSlackWrite(db, authority, api, String(args.channel));
    if (name === "slack_update_message" || name === "slack_delete_message") {
      const message = await slackMessage(api, args);
      if (!message || message.user !== authority.endpoint.botExternalId)
        throw forbidden("Only this bot's own messages can be changed");
    }
    if (args.file) await authorizeSlackDocument(db, authority, api, args, true);
    let result: SlackObject;
    const { idempotencyKey: _key, thread_ts: _thread, ...parameters } = args;
    if (name === "slack_open_dm") {
      if (!authority.endpoint.allowDirectMessages)
        throw forbidden("Direct messages are disabled");
      const user = object(
        (await api("users.info", { user: authority.slackUserId })).user,
      );
      if (
        user.id !== authority.slackUserId ||
        user.deleted === true ||
        user.is_bot === true ||
        user.team_id !== authority.endpoint.providerAccountId
      )
        throw forbidden(
          "The linked Slack user is no longer an active workspace member",
        );
      result = await api(tool.method, { users: authority.slackUserId });
    } else if (name === "slack_upload_file") {
      const [attachment] = await db
        .select({ asset: assets })
        .from(issueAttachments)
        .innerJoin(
          assets,
          and(
            eq(assets.id, issueAttachments.assetId),
            eq(assets.companyId, binding.companyId),
          ),
        )
        .where(
          and(
            eq(issueAttachments.id, String(args.attachmentId)),
            eq(issueAttachments.companyId, binding.companyId),
            eq(issueAttachments.issueId, binding.issueId),
          ),
        );
      if (!attachment || attachment.asset.byteSize > 20 * 1024 * 1024)
        throw forbidden(
          "Upload requires an attachment on this task, at most 20 MB",
        );
      const stored = await getStorageService().getObject(
        binding.companyId,
        attachment.asset.objectKey,
      );
      const chunks: Buffer[] = [];
      let count = 0;
      try {
        for await (const chunk of stored.stream) {
          const bytes = Buffer.from(chunk);
          count += bytes.length;
          if (count > 20 * 1024 * 1024)
            throw forbidden("Attachment exceeds upload limit");
          chunks.push(bytes);
        }
      } finally {
        stored.stream.destroy();
      }
      const bytes = Buffer.concat(chunks);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        attachment.asset.sha256
      )
        throw forbidden("Attachment changed before upload");
      const upload = await api("files.getUploadURLExternal", {
        filename: attachment.asset.originalFilename ?? "attachment",
        length: bytes.length,
      });
      const url = new URL(String(upload.upload_url));
      if (
        url.protocol !== "https:" ||
        url.hostname !== "files.slack.com" ||
        url.username ||
        url.password ||
        url.port
      )
        throw forbidden("Slack returned an unsupported upload destination");
      // Store the provider receipt before transport. An uncertain finish is never blindly retried.
      await db
        .update(chatActions)
        .set({
          result: { fileId: upload.file_id, phase: "upload_allocated" },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, action.id));
      const uploaded = await fetchImpl(url, {
        method: "POST",
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/octet-stream" },
      });
      await uploaded.body?.cancel();
      if (!uploaded.ok) throw unprocessable("Slack upload did not complete");
      authority = await resolveSlackTaskAuthority(db, binding);
      if (
        authority.workMode !== "standard" ||
        authority.revision !== action.payload.revision
      )
        throw forbidden("Slack authorization changed during upload");
      await authorizeSlackWrite(db, authority, api, String(args.channel));
      result = await api("files.completeUploadExternal", {
        files: [
          {
            id: upload.file_id,
            title: args.title ?? attachment.asset.originalFilename,
          },
        ],
        channel_id: args.channel,
        thread_ts: args.thread_ts,
      });
    } else if (name === "slack_post_message")
      result = await api(tool.method, {
        ...parameters,
        client_msg_id: args.idempotencyKey,
        ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
    else if (
      [
        "slack_add_reaction",
        "slack_remove_reaction",
        "slack_add_pin",
        "slack_remove_pin",
      ].includes(name)
    ) {
      const { ts, ...rest } = parameters;
      result = await api(tool.method, { ...rest, timestamp: ts });
    } else if (
      name === "slack_add_bookmark" ||
      name === "slack_remove_bookmark"
    ) {
      const { channel, ...rest } = parameters;
      result = await api(tool.method, {
        ...rest,
        channel_id: channel,
        ...(name === "slack_add_bookmark" ? { type: "link" } : {}),
      });
    } else if (name === "slack_create_canvas")
      result = await api(tool.method, {
        channel_id: args.channel,
        title: args.title,
        document_content: { type: "markdown", markdown: args.markdown },
      });
    else if (name === "slack_edit_canvas")
      result = await api(tool.method, {
        canvas_id: args.file,
        changes: [
          {
            operation: "insert_at_end",
            document_content: { type: "markdown", markdown: args.markdown },
          },
        ],
      });
    else if (name === "slack_replace_canvas_section")
      result = await api(tool.method, {
        canvas_id: args.file,
        changes: [
          {
            operation: "replace",
            section_id: args.section_id,
            document_content: { type: "markdown", markdown: args.markdown },
          },
        ],
      });
    else if (name === "slack_share_list")
      result = await api(tool.method, {
        list_id: args.file,
        channel_ids: [args.channel],
        access_level: args.access_level,
      });
    else if (name === "slack_edit_list")
      result = await api(tool.method, { list_id: args.file, name: args.name });
    else if (name === "slack_create_list")
      result = await api(tool.method, { name: args.name });
    else if (name === "slack_create_list_item")
      result = await api(tool.method, {
        list_id: args.file,
        initial_fields: [
          { column_id: args.column_id, rich_text: richText(args.text) },
        ],
      });
    else if (name === "slack_update_list_item")
      result = await api(tool.method, {
        list_id: args.file,
        cells: [
          {
            row_id: args.row_id,
            column_id: args.column_id,
            rich_text: richText(args.text),
          },
        ],
      });
    else if (name === "slack_invite")
      result = await api(tool.method, {
        channel: args.channel,
        users: (args.users as string[]).join(","),
      });
    else if (name === "slack_create_channel") {
      result = await db.transaction(async (tx) => {
        // Membership callbacks and inbound admission use this same endpoint
        // lock. Persist the disabled choice before either can discover the new
        // channel: approval to create it is not approval for ongoing responses.
        await tx
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.id, authority.endpoint.id),
              eq(chatEndpoints.companyId, binding.companyId),
            ),
          )
          .for("update");
        const created = await api(tool.method, parameters);
        const channel = object(created.channel);
        if (typeof channel.id !== "string")
          throw conflict("Slack did not return the created channel ID");
        await tx
          .insert(chatEndpointResources)
          .values({
            companyId: binding.companyId,
            endpointId: authority.endpoint.id,
            type: "channel",
            providerResourceId: channel.id,
            label: `#${String(channel.name ?? args.name)}`,
            availability: "available",
            enabled: false,
            metadata: {
              source: "slack_tool_create_channel",
              private: args.is_private === true,
            },
          })
          .onConflictDoUpdate({
            target: [
              chatEndpointResources.endpointId,
              chatEndpointResources.type,
              chatEndpointResources.providerResourceId,
            ],
            set: { enabled: false, updatedAt: new Date() },
          });
        return created;
      });
    } else result = await api(tool.method, parameters);
    const receipt = {
      channel:
        typeof result.channel === "string"
          ? result.channel
          : object(result.channel).id,
      ts: result.ts,
      canvasId: result.canvas_id,
      listId: object(result.list).id ?? result.list_id,
      bookmarkId: object(result.bookmark).id,
      item: result.item,
      listSchema: object(result.list_metadata).schema,
      fileIds: objects(result.files).map((f) => f.id),
      ...(name === "slack_create_list"
        ? {
            note: "List created for the bot; sharing access requires a separate approved action.",
          }
        : {}),
    };
    await db
      .update(chatActions)
      .set({ status: "processed", result: receipt, updatedAt: new Date() })
      .where(eq(chatActions.id, action.id));
    await logActivity(db, {
      companyId: binding.companyId,
      actorType: "agent",
      actorId: binding.agentId,
      agentId: binding.agentId,
      runId: binding.runId,
      action: "chat.slack_tool.executed",
      entityType: "chat_endpoint",
      entityId: authority.endpoint.id,
      details: { actionId: action.id, tool: name },
    });
    return { actionId: action.id, state: "delivered", ...receipt };
  } catch (error) {
    const details = error instanceof HttpError ? object(error.details) : {};
    const definite =
      error instanceof HttpError &&
      (error.status === 403 ||
        error.status === 429 ||
        (typeof details.code === "string" &&
          ![
            "slack_transport_uncertain",
            "slack_http_error",
            "slack_internal_error",
            "slack_fatal_error",
            "slack_unknown_error",
            "slack_request_timeout",
            "slack_service_unavailable",
          ].includes(details.code)));
    await db
      .update(chatActions)
      .set({
        status: definite ? "failed" : "uncertain",
        result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || ${JSON.stringify({ code: details.code ?? "slack_delivery_uncertain", ...(error instanceof HttpError && error.status === 429 ? { retryAt: new Date(Date.now() + Number(details.retryAfterSeconds ?? 60) * 1000).toISOString() } : {}) })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.id, action.id),
          eq(chatActions.status, "processing"),
        ),
      );
    if (error instanceof HttpError)
      error.details = {
        ...details,
        actionId: action.id,
        state: definite ? "failed" : "uncertain",
      };
    throw error;
  }
}
