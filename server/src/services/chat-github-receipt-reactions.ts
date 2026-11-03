/** Noncritical receipt work stays inside its caller's renewable credential
 * lease. Incomplete reads are never evidence that a reaction was removed. */
export const GITHUB_RECEIPT_TIMEOUT_MS = 2_000;
export const GITHUB_RECEIPT_MAX_PAGES = 10;

export interface GitHubReceiptIdentity {
  botUserId: string;
  reactionId: string | null;
}
export interface GitHubReceiptMutation {
  operation: "add" | "remove";
  threadId: string;
  messageId: string;
  reaction: "eyes";
  githubReceipt?: GitHubReceiptIdentity;
}
type Client = { auth(input: { type: "app" }): Promise<unknown> };
type Adapter = {
  octokit: Client;
  decodeThreadId(id: string): {
    owner: string;
    repo: string;
    reviewCommentId?: number;
    prNumber: number;
  };
};
const identities = new WeakMap<object, { appId: string; botUserId: string }>();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const numericId = (value: unknown): string | null => {
  const text =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  return /^[1-9][0-9]{0,15}$/.test(text) && Number.isSafeInteger(Number(text))
    ? text
    : null;
};
export function parseGitHubReceiptIdentity(
  value: unknown,
): GitHubReceiptIdentity | null {
  const row = record(value);
  const botUserId = numericId(row.botUserId);
  const reactionId = numericId(row.reactionId);
  return botUserId && (reactionId || row.reactionId === null)
    ? { botUserId, reactionId }
    : null;
}
function unavailable(code = "unconfirmed") {
  return Object.assign(
    new Error(`GitHub receipt reaction could not be confirmed (${code})`),
    {
      name: "NetworkError",
      code: "chat_github_receipt_unconfirmed",
    },
  );
}

/** Uses the pinned adapter's offline App signer and canonical thread decoder.
 * Bot identity comes from that exact App's /app and
 * bot-user responses, never GITHUB_BOT_USER_ID, an App ID, or caller metadata. */
export async function applyGitHubReceiptReaction(
  adapterValue: unknown,
  appId: string,
  installationId: number,
  input: GitHubReceiptMutation,
  assertCurrent: () => Promise<void>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<GitHubReceiptIdentity> {
  const adapter = adapterValue as Adapter;
  if (
    !adapter ||
    typeof adapter.decodeThreadId !== "function" ||
    !numericId(appId) ||
    !numericId(installationId) ||
    !numericId(input.messageId) ||
    input.reaction !== "eyes" ||
    !["add", "remove"].includes(input.operation) ||
    !/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:(?:issue:)?[1-9][0-9]*(?::rc:[1-9][0-9]*)?$/.test(
      input.threadId,
    )
  ) {
    throw Object.assign(new Error("Invalid GitHub receipt destination"), {
      code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
    });
  }
  const destination = adapter.decodeThreadId(input.threadId);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(destination.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(destination.repo) ||
    [".", ".."].includes(destination.repo) ||
    !numericId(destination.prNumber) ||
    (destination.reviewCommentId !== undefined &&
      !numericId(destination.reviewCommentId))
  ) {
    throw Object.assign(new Error("Invalid GitHub receipt destination"), {
      code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
    });
  }
  const client = adapter.octokit;
  if (typeof client?.auth !== "function") throw unavailable("adapter_contract");
  const expected =
    input.githubReceipt === undefined
      ? null
      : parseGitHubReceiptIdentity(input.githubReceipt);
  if (input.githubReceipt !== undefined && !expected)
    throw unavailable("receipt_identity");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_RECEIPT_TIMEOUT_MS);
  let appToken = "";
  let installationToken = "";
  const request = async (
    route: string,
    parameters: Record<string, unknown> = {},
  ) => {
    controller.signal.throwIfAborted();
    await assertCurrent();
    controller.signal.throwIfAborted();
    const [method, template] = route.split(" ");
    const query: Record<string, unknown> = { ...parameters };
    const path = template!.replace(/\{([a-z_]+)\}/g, (_match, key: string) => {
      const value = query[key];
      delete query[key];
      return encodeURIComponent(String(value));
    });
    const url = new URL(path, "https://api.github.com");
    if (method === "GET")
      for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, String(value));
    // Octokit's internal token request drops the outer AbortSignal. Sign the
    // App JWT offline, but keep both token exchange and reaction HTTP here so
    // timeout awaits actual fetch/body abort instead of racing local I/O.
    const response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${path === "/app" || path.startsWith("/app/installations/") ? appToken : installationToken}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify(query) } : {}),
    });
    const httpFailure = () =>
      Object.assign(unavailable("http"), {
        status: response.status,
        response: {
          headers: { "retry-after": response.headers.get("retry-after") },
        },
      });
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (reader)
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 524_288) {
              controller.abort();
              await reader.cancel();
              throw unavailable("response_limit");
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
      controller.signal.throwIfAborted();
      await assertCurrent();
      controller.signal.throwIfAborted();
      if (!response.ok) throw httpFailure();
      let data: unknown = null;
      if (bytes)
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw unavailable("response_body");
        }
      return {
        status: response.status,
        data,
        headers: { link: response.headers.get("link") },
      };
    } catch (error) {
      // Once headers arrive, retain only safe status/backoff even when an
      // error body is malformed, truncated, oversized or locally aborted.
      // A failed body read never turns a provider rejection into a fast retry.
      if (!response.ok) throw httpFailure();
      throw error;
    }
  };
  try {
    await assertCurrent();
    const authentication = record(await client.auth({ type: "app" }));
    if (
      typeof authentication.token !== "string" ||
      !authentication.token ||
      authentication.token.length > 8192 ||
      /[\r\n]/.test(authentication.token)
    )
      throw unavailable("app_authentication");
    appToken = authentication.token;
    const tokenResponse = await request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: installationId },
    );
    const installation = record(tokenResponse.data);
    if (
      tokenResponse.status !== 201 ||
      typeof installation.token !== "string" ||
      !installation.token ||
      installation.token.length > 8192 ||
      /[\r\n]/.test(installation.token)
    )
      throw unavailable("installation_authentication");
    installationToken = installation.token;
    let identity = identities.get(adapter as object);
    if (!identity || identity.appId !== appId) {
      const appResponse = await request("GET /app");
      const app = record(appResponse.data);
      if (
        appResponse.status !== 200 ||
        numericId(app.id) !== appId ||
        typeof app.slug !== "string" ||
        !/^[A-Za-z0-9-]{1,100}$/.test(app.slug)
      )
        throw unavailable("app_identity");
      const login = `${app.slug}[bot]`;
      const botResponse = await request("GET /users/{username}", {
        username: login,
      });
      const bot = record(botResponse.data);
      const botUserId = numericId(bot.id);
      if (
        botResponse.status !== 200 ||
        !botUserId ||
        bot.type !== "Bot" ||
        bot.login !== login
      )
        throw unavailable("bot_identity");
      identity = { appId, botUserId };
      identities.set(adapter as object, identity);
    }
    if (expected && expected.botUserId !== identity.botUserId)
      throw unavailable("owner_changed");
    const route = destination.reviewCommentId
      ? "/repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions"
      : "/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions";
    const parameters = {
      owner: destination.owner,
      repo: destination.repo,
      comment_id: Number(input.messageId),
    };
    if (input.operation === "add") {
      const response = await request(`POST ${route}`, {
        ...parameters,
        content: "eyes",
      });
      const reaction = record(response.data);
      const reactionId = numericId(reaction.id);
      if (
        ![200, 201].includes(response.status) ||
        !reactionId ||
        reaction.content !== "eyes" ||
        numericId(record(reaction.user).id) !== identity.botUserId ||
        (expected?.reactionId && expected.reactionId !== reactionId)
      )
        throw unavailable("add_receipt");
      return { botUserId: identity.botUserId, reactionId };
    }
    // Fetch every bounded page before deletion. A partial page set must not
    // accidentally delete a replacement or report absence as success.
    let found: string | null = null;
    const seen = new Set<string>();
    for (let page = 1; page <= GITHUB_RECEIPT_MAX_PAGES; page++) {
      const response = await request(`GET ${route}`, {
        ...parameters,
        content: "eyes",
        per_page: 100,
        page,
      });
      if (
        response.status !== 200 ||
        !Array.isArray(response.data) ||
        response.data.length > 100
      )
        throw unavailable("reaction_page");
      for (const raw of response.data) {
        const row = record(raw);
        const id = numericId(row.id);
        const user = numericId(record(row.user).id);
        if (!id || !user || row.content !== "eyes" || seen.has(id))
          throw unavailable("reaction_page");
        seen.add(id);
        if (user === identity.botUserId) {
          if (found || (expected?.reactionId && expected.reactionId !== id))
            throw unavailable("reaction_changed");
          found = id;
        }
      }
      const hasNext =
        typeof response.headers.link === "string" &&
        /rel="next"/.test(response.headers.link);
      if (response.data.length === 100 || hasNext) {
        if (page === GITHUB_RECEIPT_MAX_PAGES)
          throw unavailable("pagination_limit");
        continue;
      }
      if (found) {
        const deleted = await request(`DELETE ${route}/{reaction_id}`, {
          ...parameters,
          reaction_id: Number(found),
        });
        if (deleted.status !== 204) throw unavailable("delete_receipt");
      }
      return {
        botUserId: identity.botUserId,
        reactionId: expected?.reactionId ?? found,
      };
    }
    throw unavailable("pagination_limit");
  } catch (error) {
    // Keep only status/backoff, not provider bodies, URLs or authentication.
    const data = record(error);
    const status = typeof data.status === "number" ? data.status : undefined;
    const retryAfter = record(record(data.response).headers)["retry-after"];
    throw Object.assign(unavailable(), {
      ...(status ? { status } : {}),
      ...(typeof retryAfter === "string" && /^\d{1,10}$/.test(retryAfter)
        ? { response: { headers: { "retry-after": retryAfter } } }
        : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}
