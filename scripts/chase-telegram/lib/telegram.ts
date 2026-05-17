function getBotToken(): string {
  return Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
}

function telegramUrl(method: string): string {
  return `https://api.telegram.org/bot${getBotToken()}/${method}`;
}

export async function sendTelegram(
  chatId: number,
  text: string,
  parseMode: "HTML" = "HTML",
): Promise<boolean> {
  try {
    const res = await fetch(telegramUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Telegram API error: ${res.status} ${body}`);
    }
    return res.ok;
  } catch (err) {
    console.error(`Telegram send failed: ${err}`);
    return false;
  }
}

export function isBotConfigured(): boolean {
  return !!getBotToken();
}
