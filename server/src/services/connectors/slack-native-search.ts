import { forbidden } from "../../errors.js";
import type { SlackTaskAuthority } from "./slack-authority.js";
import {
  object,
  objects,
  nextCursor,
  slackClient,
  type SlackObject,
} from "./slack-client.js";

export const SLACK_NATIVE_SEARCH_LIMITATION =
  "Native Slack search requires a runtime qualified for transient results. Current runtimes retain tool transcripts, so this connection uses bounded channel history search.";

/** No production runtime is qualified yet. A future caller must provide transient
 * model delivery with no transcript, audit payload, replay, artifact or provider
 * retention of RTS results. In particular, do not route this return value through
 * the ordinary tool gateway. Recovery must re-fetch. This provider implementation
 * deliberately has no database/logging dependency. */
export async function fetchTransientSlackSearch(input: {
  authority: SlackTaskAuthority;
  args: SlackObject;
  authorizeChannel: (channel: string) => Promise<SlackObject>;
  personalSearchToken: () => Promise<{ token: string; scopes: string[] }>;
  assertCurrentAuthority: () => Promise<void>;
  fetchImpl?: typeof fetch;
}) {
  const { authority, args, authorizeChannel } = input;
  const channels = args.channels as string[];
  if (args.cursor && channels.length !== 1)
    throw forbidden("Continue native search one channel at a time");
  const results: SlackObject[] = [];
  const pages: SlackObject[] = [];
  for (const channelId of channels) {
    const channel = await authorizeChannel(channelId);
    // No MPIM or IM search grants: history tools cover the requester's bot DM.
    if (channel.is_im || channel.is_mpim)
      throw forbidden(
        "Use history for direct messages; native search does not request DM permissions",
      );
    const privateChannel = channel.is_private === true;
    let token = authority.botToken;
    if (privateChannel || !authority.searchActionToken) {
      const grant = await input.personalSearchToken();
      if (
        !grant.scopes.includes("search:read.public") ||
        (privateChannel && !grant.scopes.includes("search:read.private")) ||
        (args.contentType === "files" &&
          !grant.scopes.includes("search:read.files"))
      )
        throw forbidden(
          "Connect Slack search with the required channel and file permissions",
        );
      token = grant.token;
    }
    await input.assertCurrentAuthority();
    const api = slackClient(token, input.fetchImpl);
    // Query modifiers are never authority. Every hit is independently checked.
    const response = await api("assistant.search.context", {
      query: args.query,
      term_clauses: [
        `in:<#${channelId}>`,
        ...(args.author ? [`from:<@${args.author}>`] : []),
      ],
      channel_types: privateChannel ? ["private_channel"] : ["public_channel"],
      content_types: [args.contentType ?? "messages"],
      include_context_messages: false,
      context_channel_id: channelId,
      limit: args.limit ?? 20,
      ...(token === authority.botToken
        ? { action_token: authority.searchActionToken }
        : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.oldest ? { after: Math.floor(Number(args.oldest)) } : {}),
      ...(args.latest ? { before: Math.ceil(Number(args.latest)) } : {}),
    });
    // Slack may return hits outside model-authored filters, or access may change
    // while the request is in flight. Fail closed before exposing any content.
    await authorizeChannel(channelId);
    const found = object(response.results);
    for (const hit of objects(found.messages)) {
      if (
        hit.team_id !== authority.endpoint.providerAccountId ||
        hit.channel_id !== channelId ||
        typeof hit.message_ts !== "string" ||
        !/^\d+\.\d+$/.test(hit.message_ts)
      )
        continue;
      if (
        (args.author && hit.author_user_id !== args.author) ||
        (args.oldest && Number(hit.message_ts) < Number(args.oldest)) ||
        (args.latest && Number(hit.message_ts) > Number(args.latest))
      )
        continue;
      results.push({
        channel: channelId,
        ts: hit.message_ts,
        user: hit.author_user_id,
        text: hit.content,
        sourceUrl: sourceLink(
          authority.endpoint.providerAccountId!,
          channelId,
          hit.message_ts,
        ),
        sourceTrust: "untrusted",
      });
    }
    for (const hit of objects(found.files)) {
      if (
        hit.team_id !== authority.endpoint.providerAccountId ||
        typeof hit.file_id !== "string" ||
        !/^F[A-Z0-9]+$/.test(hit.file_id)
      )
        continue;
      // A user grant must never expand bot access. Resolve file shares with the
      // bot token, not the user's credential, and require this authorized channel.
      const file = object(
        (
          await slackClient(authority.botToken, input.fetchImpl)("files.info", {
            file: hit.file_id,
          })
        ).file,
      );
      const shares = object(file.shares);
      const destinations = [
        ...Object.keys(object(shares.public)),
        ...Object.keys(object(shares.private)),
      ];
      if (
        file.id !== hit.file_id ||
        !destinations.includes(channelId) ||
        (args.author && file.user !== args.author) ||
        ((args.oldest || args.latest) &&
          !Number.isFinite(Number(file.timestamp))) ||
        (args.oldest && Number(file.timestamp) < Number(args.oldest)) ||
        (args.latest && Number(file.timestamp) > Number(args.latest))
      )
        continue;
      await authorizeChannel(channelId);
      results.push({
        channel: channelId,
        file: hit.file_id,
        title: hit.title,
        content: hit.content,
        sourceUrl: `https://app.slack.com/client/${authority.endpoint.providerAccountId}/${channelId}/files/${hit.file_id}`,
        sourceTrust: "untrusted",
      });
    }
    pages.push({ channel: channelId, nextCursor: nextCursor(response) });
  }
  await input.assertCurrentAuthority();
  return {
    mode: "native",
    exhaustive: false,
    results,
    pages,
    coverage:
      "Slack-ranked results within verified bot/requester channels. Continue returned cursors; provider retention and search availability still apply.",
  };
}
function sourceLink(team: string, channel: string, timestamp: string) {
  return `https://app.slack.com/client/${team}/${channel}/thread/${channel}-${timestamp}`;
}
