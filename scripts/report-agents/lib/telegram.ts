const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegram(
  html: string,
  opts?: { botToken?: string; chatId?: string; threadId?: number }
): Promise<void> {
  const token = opts?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts?.chatId ?? process.env.TELEGRAM_CHAT_ID;
  const threadId = opts?.threadId ?? (process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined);

  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  // Clean HTML for Telegram — only allows: b, i, u, s, a, code, pre
  const allowedTags = /^\/?(b|i|u|s|a|code|pre)\b/i;
  const cleanHtml = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(em)>/gi, (m) => m.includes("/") ? "</i>" : "<i>")
    .replace(/<\/?strong>/gi, (m) => m.includes("/") ? "</b>" : "<b>")
    // Remove unsupported tags but keep content
    .replace(/<\/?[^>]+>/g, (match) => {
      const inner = match.replace(/^<\/?/, "").replace(/>$/, "");
      return allowedTags.test(inner) ? match : "";
    })
    // Escape remaining < > that aren't valid tags (like <$10K>)
    .replace(/<(?!\/?(?:b|i|u|s|a|code|pre)\b[^>]*>)/g, "&lt;")
    .replace(/(?<!<\/?(?:b|i|u|s|a|code|pre)\b[^>]*)>/g, "&gt;")
    .replace(/\n{3,}/g, "\n\n");

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: cleanHtml,
    parse_mode: "HTML",
  };
  if (threadId) body.message_thread_id = threadId;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    const err = await res.text();
    console.error(`Telegram attempt ${attempt + 1} failed: ${res.status} ${err}`);

    // If HTML parse error → fallback to plain text (no parse_mode)
    if (err.includes("can't parse entities")) {
      console.log("  Falling back to plain text...");
      const plainBody = { ...body, parse_mode: undefined, text: cleanHtml.replace(/<[^>]+>/g, "") };
      const plainRes = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plainBody),
      });
      if (plainRes.ok) return;
    }

    if (attempt < 2) await new Promise((r) => setTimeout(r, 30_000));
  }
  throw new Error("Telegram send failed after 3 retries");
}

export async function sendPhoto(
  photo: Buffer,
  caption?: string,
  opts?: { botToken?: string; chatId?: string; threadId?: number }
): Promise<void> {
  const token = opts?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts?.chatId ?? process.env.TELEGRAM_CHAT_ID;
  const threadId = opts?.threadId ?? (process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined);

  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([new Uint8Array(photo)], { type: "image/png" }), "chart.png");
  if (caption) form.append("caption", caption);
  if (threadId) form.append("message_thread_id", String(threadId));

  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram sendPhoto failed: ${res.status} ${err}`);
  }
}

export async function sendDocument(
  filePath: string,
  caption?: string,
  opts?: { botToken?: string; chatId?: string; threadId?: number }
): Promise<void> {
  const token = opts?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts?.chatId ?? process.env.TELEGRAM_CHAT_ID;
  const threadId = opts?.threadId ?? (process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined);

  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const fs = await import("fs");
  const path = await import("path");
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", new Blob([new Uint8Array(fileBuffer)]), fileName);
  if (caption) form.append("caption", caption);
  if (threadId) form.append("message_thread_id", String(threadId));

  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram sendDocument failed: ${res.status} ${err}`);
  }
}

export async function sendMessageWithKeyboard(
  text: string,
  buttons: Array<{ text: string; callback_data: string }>,
  opts?: { botToken?: string; chatId?: string; threadId?: number }
): Promise<number> {
  const token = opts?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts?.chatId ?? process.env.TELEGRAM_CHAT_ID;
  const threadId = opts?.threadId ?? (process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined);

  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [buttons],
    },
  };
  if (threadId) body.message_thread_id = threadId;

  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram sendMessageWithKeyboard failed: ${res.status} ${err}`);
  }
  const data = await res.json() as any;
  return data.result?.message_id ?? 0;
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  opts?: { botToken?: string }
): Promise<void> {
  const token = opts?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text ?? "",
    }),
  });
}
