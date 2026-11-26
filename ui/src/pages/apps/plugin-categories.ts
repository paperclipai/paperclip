import type { AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";
import type { PluginCategoryId } from "./PluginMarketplace";

/** Arcade's own category names, mapped onto the Plugins categories. */
const PROVIDER_CATEGORY: Record<string, PluginCategoryId> = {
  productivity: "productivity",
  sales: "productivity",
  development: "developer",
  databases: "data",
  search: "data",
  "customer-support": "communication",
  social: "communication",
  entertainment: "content",
  payments: "commerce",
};

/**
 * Name keywords for apps whose catalog states no category (all of Composio's).
 * The first category with a matching word wins, so the more specific lists come
 * first. This is a best guess from the name alone; anything unmatched is "other".
 */
const KEYWORDS: [PluginCategoryId, RegExp][] = [
  ["ai", /\b(ai|gpt|llm|openai|anthropic|cohere|deepseek|mistral|gemini|perplexity|replicate|elevenlabs|assemblyai|deepgram|groq|ollama|chatbot\w*|bot\w*|agent\w*)\b/],
  ["commerce", /\b(shop\w*|pay\w*|stripe|commerce|store|cart|invoic\w*|billing|checkout|square|order\w*|subscription\w*|bank\w*|accounting|quickbooks|xero|coin\w*|crypto\w*|wallet|btc\w*|brex|ecommerce|woocommerce)\b/],
  ["analytics", /\b(analytics|amplitude|mixpanel|posthog|segment|metrics|insight\w*|seo|ahrefs|semrush|chart\w*|report\w*|track\w*|baremetrics|databox|hotjar|plausible)\b/],
  ["data", /\b(database|sql|postgres\w*|mysql|mongo\w*|redis|snowflake|bigquery|databricks|clickhouse|airtable|baserow|sheets?|csv\w*|data\w*|warehouse|elastic\w*|algolia|pinecone|supabase|scrap\w*|crawl\w*|search)\b/],
  ["developer", /\b(github|gitlab|bitbucket|circleci|buildkite|sentry|datadog|vercel|netlify|cloudflare|aws|azure|gcp|docker|kubernetes|api\w*|sdk|browser\w*|code\w*|dev\w*|deploy\w*|bug\w*|test\w*|terraform|heroku|firebase|npm|webhook\w*|server|cloud\w*|monitor\w*)\b/],
  ["communication", /\b(e?mail\w*|sms|slack|discord|teams|telegram|whatsapp|chat\w*|messag\w*|twilio|zoom|meet\w*|call\w*|voice|intercom|crisp|inbox|phone|texter|newsletter|webinar)\b/],
  ["content", /\b(cms|content\w*|pdf\w*|docs?|image\w*|video\w*|photo\w*|media|design\w*|canva|figma|wordpress|blog\w*|webflow|youtube|podcast\w*|audio\w*|transcri\w*|translat\w*|caption\w*|screenshot\w*)\b/],
  ["productivity", /\b(calendar\w*|tasks?|todo\w*|projects?|notion|asana|trello|jira|clickup|crm|forms?|survey\w*|schedul\w*|notes?|hr|time\w*|booking\w*|sign|workflow\w*|automation|zapier|proposal\w*|recruit\w*|appointment\w*)\b/],
];

/** Which Plugins category an aggregator app belongs in. */
export function aggregatorPluginCategory(app: Pick<AggregatorAppCatalogEntry, "name" | "category">): PluginCategoryId {
  const stated = app.category ? PROVIDER_CATEGORY[app.category] : undefined;
  if (stated) return stated;
  const name = app.name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return KEYWORDS.find(([, words]) => words.test(name))?.[0] ?? "other";
}

/**
 * Splits catalog rows into category blocks in one pass, classifying each row once.
 * `total` counts every row in the category; `rows` holds the first `blockSize` that are not already on a shelf.
 */
export function groupPluginsByCategory<T>(
  items: readonly T[],
  order: readonly PluginCategoryId[],
  categoryOf: (item: T) => PluginCategoryId,
  isShelved: (item: T) => boolean,
  blockSize: number,
): { id: PluginCategoryId; total: number; rows: T[] }[] {
  const groups = new Map<PluginCategoryId, { id: PluginCategoryId; total: number; rows: T[] }>();
  for (const id of order) groups.set(id, { id, total: 0, rows: [] });
  for (const item of items) {
    const group = groups.get(categoryOf(item));
    if (!group) continue;
    group.total += 1;
    if (group.rows.length < blockSize && !isShelved(item)) group.rows.push(item);
  }
  return [...groups.values()].filter((group) => group.total > 0);
}
