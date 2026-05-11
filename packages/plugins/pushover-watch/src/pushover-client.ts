import type { PluginContext } from "@paperclipai/plugin-sdk";

export type SendParams = {
  userKey: string;
  appToken: string;
  title: string;
  message: string;
  url: string;
  urlTitle: string;
  priority: 0 | 1;
};

export type SendResult = { ok: boolean; status?: number };

export async function sendPushover(
  ctx: PluginContext,
  params: SendParams,
): Promise<SendResult> {
  const body = new URLSearchParams({
    token: params.appToken,
    user: params.userKey,
    title: params.title,
    message: params.message,
    url: params.url,
    url_title: params.urlTitle,
    priority: String(params.priority),
  });

  const res = await ctx.http.fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    ctx.logger.warn("pushover_send_failed", { status: res.status, body: body.slice(0, 500) });
    return { ok: false, status: res.status };
  }
  ctx.logger.info("pushover_send_ok", { status: res.status, title: params.title });
  return { ok: true, status: res.status };
}
