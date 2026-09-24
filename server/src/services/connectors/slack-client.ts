import { SLACK_TOOLS } from "@paperclipai/shared";
import { forbidden, tooManyRequests, unprocessable } from "../../errors.js";

const METHODS = new Set([
  ...SLACK_TOOLS.map((t) => t.method),
  "auth.test",
  "users.info",
  "files.getUploadURLExternal",
  "conversations.members",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
]);
export type SlackObject = Record<string, unknown>;
export const object = (value: unknown): SlackObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SlackObject)
    : {};
export const objects = (value: unknown): SlackObject[] =>
  Array.isArray(value) ? value.map(object) : [];
export const nextCursor = (value: SlackObject) =>
  String(
    object(value.response_metadata).next_cursor ?? value.next_cursor ?? "",
  );

/** Fixed origin and closed method set; never surface provider response bodies in errors. */
export function slackClient(token: string, fetchImpl = fetch) {
  return async (
    method: string,
    args: SlackObject = {},
  ): Promise<SlackObject> => {
    if (!METHODS.has(method) || Object.hasOwn(args, "token"))
      throw forbidden("Unsupported Slack method");
    let response: Response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        // Match Slack's official WebClient encoding, including nested JSON
        // arguments. Some Web API methods reject a JSON request body.
        body: new URLSearchParams(Object.entries(args)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, typeof value === "object"
            ? JSON.stringify(value) : String(value)])).toString(),
      });
    } catch {
      throw unprocessable(
        "Slack request did not complete; delivery may be uncertain",
        { code: "slack_transport_uncertain" },
      );
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw tooManyRequests(
        "Slack rate limit reached. Retry after the indicated delay.",
        {
          code: "slack_rate_limited",
          retryAfterSeconds: Math.max(
            1,
            Math.min(3600, Number(response.headers.get("retry-after")) || 60),
          ),
        },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unprocessable("Slack request failed", {
        code: "slack_http_error",
        status: response.status,
      });
    }
    const reader = response.body?.getReader();
    if (!reader) throw unprocessable("Slack returned an empty response");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4 * 1024 * 1024)
          throw unprocessable(
            "Slack response too large; request a smaller page",
          );
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let result: SlackObject;
    try {
      result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw unprocessable("Slack returned an invalid response");
    }
    if (result.ok !== true) {
      const code =
        typeof result.error === "string" && /^[a-z_]+$/.test(result.error)
          ? result.error
          : "unknown_error";
      const scopes =
        typeof result.needed === "string" && /^[a-z_:,.]+$/.test(result.needed)
          ? result.needed
          : undefined;
      throw unprocessable(
        `Slack could not perform this operation: ${code}${scopes ? `. Reinstall the app with ${scopes}.` : code === "invalid_arguments" ? ". Check the tool arguments; installing another connector will not fix this request." : ". Check app permissions and Slack feature availability."}`,
        { code: `slack_${code}`, missingScopes: scopes },
      );
    }
    const scopes = response.headers.get("x-oauth-scopes");
    if (scopes !== null)
      result.grantedScopes = scopes.split(",").map((scope) => scope.trim());
    return result;
  };
}
