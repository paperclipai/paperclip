import { serve } from "std/http/server.ts";
import type { TelegramUpdate } from "./types.ts";
import { sendTelegram, isBotConfigured } from "./lib/telegram.ts";
import { isPaperclipConfigured } from "./lib/api.ts";
import { escapeHtml } from "./lib/html.ts";
import { formatNotification, isAiConfigured, aiProvider } from "./lib/llm.ts";
import { routeQuery, routeVenue, routeLocation } from "./router.ts";
import { CHASE_TELEGRAM_BUILD_SHA, CHASE_TELEGRAM_BUILD_TIME } from "./build.ts";

// ─── Build Information ────────────────────────────────────────────────
console.log(`CHASE_TELEGRAM_BUILD_SHA=${CHASE_TELEGRAM_BUILD_SHA}`);
console.log(`CHASE_TELEGRAM_BUILD_TIME=${CHASE_TELEGRAM_BUILD_TIME}`);

// ─── Environment ──────────────────────────────────────────────────────

const ALLOWED_IDS = (Deno.env.get("ALLOWED_TELEGRAM_USER_IDS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => !isNaN(n));
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SETUP_SECRET") ?? "";
const CHASE_API_KEY = Deno.env.get("CHASE_PAPERCLIP_API_KEY") ?? "";

// ─── HTTP Helpers ─────────────────────────────────────────────────────

export function respondJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Webhook Handler ──────────────────────────────────────────────────

export async function handleWebhook(update: TelegramUpdate): Promise<Response> {
  const msg = update.message;
  if (!msg?.from) {
    return respondJson({ ok: true, reason: "non-message update ignored" });
  }

  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(msg.from.id)) {
    console.warn(`Rejected message from unauthorized user: ${msg.from.id}`);
    return respondJson({ ok: true, reason: "unauthorized" });
  }

  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name;

  // Handle venue messages (shared place with location)
  if (msg.venue) {
    const { location, title, address } = msg.venue;
    const { latitude, longitude } = location;
    const handler = routeVenue(chatId, latitude, longitude, title, address, firstName);
    const result = await handler();
    await sendTelegram(chatId, result.text);
    return respondJson({ ok: true });
  }

  // Handle location messages (user shared their location)
  if (msg.location) {
    const { latitude, longitude } = msg.location;
    const handler = routeLocation(chatId, latitude, longitude, msg.text, firstName);
    const result = await handler();
    if (result.text) {
      await sendTelegram(chatId, result.text);
    }
    return respondJson({ ok: true });
  }

  if (!msg.text) {
    return respondJson({ ok: true, reason: "non-text message ignored" });
  }

  const text = msg.text;

  const { handler, requiresAi } = routeQuery(text, firstName, chatId);

  if (requiresAi) {
    await sendTelegram(chatId, "One moment, looking that up...");
  }

  try {
    const result = await handler();
    await sendTelegram(chatId, result.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const snippet = text.length > 80 ? text.slice(0, 80) + "..." : text;
    console.error(`Query failed [chatId=${chatId}, query="${snippet}"]: ${message}`);
    await sendTelegram(
      chatId,
      "Sorry, I ran into an issue looking that up. Please try again shortly.",
    );
  }

  return respondJson({ ok: true });
}

// ─── Notification Endpoint (Paperclip → Telegram alerts) ──────────────

export async function handleNotify(request: Request): Promise<Response> {
  try {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== CHASE_API_KEY) {
      return respondJson({ error: "Unauthorized" }, 401);
    }

    const body = await request.json() as {
      chatId?: number;
      text: string;
      title?: string;
    };

    if (!body.text) {
      return respondJson({ error: "text is required" }, 400);
    }

    const chatId = body.chatId ??
      (ALLOWED_IDS.length > 0 ? ALLOWED_IDS[0] : null);
    if (!chatId) {
      return respondJson({ error: "No target chatId" }, 400);
    }

    let formattedText = body.title
      ? `<b>${escapeHtml(body.title)}</b>\n\n${body.text}`
      : body.text;

    let aiEnhanced = false;
    if (isAiConfigured()) {
      try {
        const aiText = await formatNotification(body.text, body.title);
        if (aiText) {
          formattedText = aiText;
          aiEnhanced = true;
        }
      } catch (err) {
        console.error(`AI notification formatting failed, using raw: ${err}`);
      }
    }

    const sent = await sendTelegram(chatId, formattedText);
    return respondJson({ ok: sent, aiEnhanced, fallback: !aiEnhanced });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Notification failed: ${message}`);
    return respondJson({ error: message }, 500);
  }
}

// ─── Webhook Setup Endpoint ───────────────────────────────────────────

export async function handleSetupWebhook(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || auth.slice(7) !== WEBHOOK_SECRET) {
    return respondJson({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const webhookUrl = body.url as string | undefined;
    if (!webhookUrl) {
      return respondJson({ error: "url is required" }, 400);
    }

    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ["message"],
          drop_pending_updates: body.dropPending ?? true,
        }),
      },
    );
    const result = await res.json();
    return respondJson(result, res.ok ? 200 : 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return respondJson({ error: message }, 500);
  }
}

// ─── Health Check ─────────────────────────────────────────────────────

export function handleHealth(): Response {
  const ok = isBotConfigured() && isPaperclipConfigured();
  return respondJson({
    status: ok ? "healthy" : "unhealthy",
    botConfigured: isBotConfigured(),
    paperclipConfigured: isPaperclipConfigured(),
    aiConfigured: isAiConfigured(),
    aiProvider: aiProvider(),
    build: {
      sha: CHASE_TELEGRAM_BUILD_SHA,
      time: CHASE_TELEGRAM_BUILD_TIME,
    },
  }, ok ? 200 : 503);
}

// ─── Server ───────────────────────────────────────────────────────────

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname
    .replace(/^\/functions\/v1\/chase-telegram(?:\/)?/, "/")
    .replace(/^\/chase-telegram(?:\/)?/, "/");
  const method = request.method;

  if (method === "GET" && (path === "/" || path === "/health")) {
    return handleHealth();
  }

  if (method === "POST" && path === "/setup-webhook") {
    return handleSetupWebhook(request);
  }

  if (method === "POST" && path === "/notify") {
    return handleNotify(request);
  }

  if (method === "POST" && path === "/") {
    const update: TelegramUpdate = await request.json();
    return handleWebhook(update);
  }

  return respondJson({ error: "Not found", pathname: url.pathname, path, method }, 404);
}

if (import.meta.main) {
  serve(handleRequest);
}
