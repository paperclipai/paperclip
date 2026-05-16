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

type PushoverBody = { status?: number; errors?: string[]; request?: string };

async function parsePushoverBody(res: Response): Promise<PushoverBody | null> {
  try {
    return (await res.json()) as PushoverBody;
  } catch {
    return null;
  }
}

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
  const parsed = await parsePushoverBody(res);
  if (parsed && parsed.status !== 1) {
    ctx.logger.warn("pushover_send_rejected", {
      status: res.status,
      bodyStatus: parsed.status ?? null,
      errors: parsed.errors ?? [],
      request: parsed.request ?? null,
      title: params.title,
    });
    return { ok: false, status: res.status };
  }
  ctx.logger.info("pushover_send_ok", { status: res.status, title: params.title });
  return { ok: true, status: res.status };
}

export type GlanceParams = {
  userKey: string;
  appToken: string;
  title: string;
  text?: string;
  subtext?: string;
};

const GLANCE_FIELD_LIMIT = 100;

export async function sendGlance(
  ctx: PluginContext,
  params: GlanceParams,
): Promise<SendResult> {
  const body = new URLSearchParams({
    token: params.appToken,
    user: params.userKey,
    title: params.title.slice(0, GLANCE_FIELD_LIMIT),
  });
  if (params.text) body.set("text", params.text.slice(0, GLANCE_FIELD_LIMIT));
  if (params.subtext) body.set("subtext", params.subtext.slice(0, GLANCE_FIELD_LIMIT));

  const res = await ctx.http.fetch("https://api.pushover.net/1/glances.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    ctx.logger.warn("pushover_glance_failed", {
      status: res.status,
      body: responseBody.slice(0, 500),
    });
    return { ok: false, status: res.status };
  }
  const parsed = await parsePushoverBody(res);
  if (parsed && parsed.status !== 1) {
    ctx.logger.warn("pushover_glance_rejected", {
      status: res.status,
      bodyStatus: parsed.status ?? null,
      errors: parsed.errors ?? [],
      request: parsed.request ?? null,
      title: params.title,
    });
    return { ok: false, status: res.status };
  }
  ctx.logger.info("pushover_glance_ok", { status: res.status, title: params.title });
  return { ok: true, status: res.status };
}
