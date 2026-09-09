const SUPPORTED_LOCALES = ["es", "zh-Hans", "tl"] as const;
type SupportedLocale = typeof SUPPORTED_LOCALES[number];

const LOCALE_NAMES: Record<SupportedLocale, string> = {
  es: "Spanish",
  "zh-Hans": "Simplified Mandarin Chinese",
  tl: "Tagalog",
};

// In-memory translation cache: key → { text, expiresAt }
const translationCache = new Map<string, { text: string; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheKey(alertId: string, locale: string): string {
  return `alert-translation:${alertId}:${locale}`;
}

function getCached(alertId: string, locale: string): string | null {
  const entry = translationCache.get(cacheKey(alertId, locale));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    translationCache.delete(cacheKey(alertId, locale));
    return null;
  }
  return entry.text;
}

function setCached(alertId: string, locale: string, text: string): void {
  translationCache.set(cacheKey(alertId, locale), { text, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function callAnthropicTranslation(body: string, localeName: string): Promise<string> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const prompt = `You are an emergency alert translator. Translate the following CAP alert text to ${localeName}.
Preserve all proper nouns (place names, organization names, equipment names) in their original language.
Use formal, clear emergency management language.
Do not add or remove information.

Alert text:
${body}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text content in Anthropic response");
  return textBlock.text.trim();
}

export async function translateAlertBody(
  alertId: string,
  body: string,
  locale: string,
): Promise<string | null> {
  if (!SUPPORTED_LOCALES.includes(locale as SupportedLocale)) return null;
  const typedLocale = locale as SupportedLocale;

  const cached = getCached(alertId, locale);
  if (cached) return cached;

  const localeName = LOCALE_NAMES[typedLocale];
  const translated = await callAnthropicTranslation(body, localeName);
  setCached(alertId, locale, translated);
  return translated;
}

export async function translateAlertForAllLocales(
  alertId: string,
  body: string,
  targetLocales: SupportedLocale[],
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  await Promise.allSettled(
    targetLocales.map(async (locale) => {
      try {
        const translated = await translateAlertBody(alertId, body, locale);
        if (translated) results[locale] = translated;
      } catch (err) {
        console.error(`Translation failed for locale ${locale} alert ${alertId}:`, err);
      }
    }),
  );
  return results;
}

export { SUPPORTED_LOCALES, type SupportedLocale };
