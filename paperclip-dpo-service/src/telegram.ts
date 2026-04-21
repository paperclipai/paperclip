export interface TelegramMessage {
  botToken: string;
  chatId: string;
  text: string;
}

export async function postTelegram(
  msg: TelegramMessage,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchFn(`https://api.telegram.org/bot${msg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chatId,
        text: msg.text,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    // alerts must never crash the service
  }
}
