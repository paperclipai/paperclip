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
    if (attempt < 2) await new Promise((r) => setTimeout(r, 30_000));
  }
  throw new Error("Telegram send failed after 3 retries");
}
