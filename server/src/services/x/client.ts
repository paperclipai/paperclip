import { unprocessable } from "../../errors.js";
import { xId, xPost, xParent, type XPost, type XEvent } from "./protocol.js";
export class XApiError extends Error {
  constructor(
    public status: number,
    public retryAfter: number | null = null,
  ) {
    super(
      status === 401
        ? "X authorization expired; reconnect the bot account"
        : status === 402
          ? "X API credits are exhausted; check spending controls"
          : status === 429
            ? "X rate limit reached; try after the reset"
            : `X rejected the request (HTTP ${status})`,
    );
  }
}
export async function xRequest(
  token: string,
  path: string,
  body?: unknown,
  fetchImpl = fetch,
) {
  const response = await fetchImpl(`https://api.x.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new XApiError(
      response.status,
      Number(response.headers.get("retry-after")) || null,
    );
  }
  return (await response.json()) as {
    data?: Record<string, unknown>;
    includes?: { users?: unknown[] };
  };
}
export async function xIdentity(token: string, fetchImpl = fetch) {
  const result = await xRequest(
    token,
    "/2/users/me?user.fields=username,name",
    undefined,
    fetchImpl,
  );
  if (
    !xId.safeParse(result.data?.id).success ||
    typeof result.data?.id !== "string" ||
    typeof result.data.username !== "string"
  )
    throw unprocessable("X did not return a stable account identity");
  return {
    id: result.data.id,
    username: result.data.username,
    name: String(result.data.name ?? result.data.username),
  };
}
export async function xExchange(
  clientId: string,
  clientSecret: string,
  values: Record<string, string>,
  fetchImpl = fetch,
) {
  const response = await fetchImpl("https://api.x.com/2/oauth2/token", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: clientId, ...values }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new XApiError(response.status);
  }
  const value = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
  };
  if (
    typeof value.access_token !== "string" ||
    !value.access_token ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (value.refresh_token !== undefined &&
      typeof value.refresh_token !== "string")
  )
    throw unprocessable(
      "X returned an incomplete authorization; connect again",
    );
  return value;
}
export async function xAncestors(
  event: XEvent,
  token: () => Promise<string>,
  fetchImpl = fetch,
) {
  const ancestors: XPost[] = [];
  let parent = xParent(event.payload);
  let missing: string | null = null;
  const visited = new Set([event.payload.id]);
  for (let i = 0; parent && i < 10; i++) {
    if (visited.has(parent)) {
      missing = "An ancestor cycle was omitted";
      break;
    }
    visited.add(parent);
    let post = event.includes?.tweets?.find(
      (candidate) => candidate.id === parent,
    );
    if (!post) {
      try {
        const result = await xRequest(
          await token(),
          `/2/tweets/${parent}?tweet.fields=author_id,conversation_id,created_at,referenced_tweets`,
          undefined,
          fetchImpl,
        );
        post = xPost.parse(result.data);
      } catch {
        missing = `Parent ${parent} is unavailable (deleted, protected, or inaccessible)`;
        break;
      }
    }
    ancestors.push(post);
    parent = xParent(post);
  }
  if (parent && ancestors.length === 10)
    missing = "Context is limited to ten ancestors";
  return { ancestors, missing };
}
