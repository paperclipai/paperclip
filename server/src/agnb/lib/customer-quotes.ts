import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rows } from "../helpers.js";

/**
 * Pull anonymized customer context from agnb.filled_assets to ground blog
 * claims — ported from agnb lib/agnb/customer-quotes.ts (supabase → drizzle).
 */

export interface CustomerQuote {
  customer: string;
  quote: string;
  asset_kind: string;
  source_fill_id: string;
}

/** Extract a representative quote from html_rendered (case studies, QBR decks). */
function extractQuote(html: string): string | null {
  const stripped = html.replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ").trim();
  const quoteMatch = stripped.match(/["“]([^"”]{40,400})["”]/);
  if (quoteMatch) return quoteMatch[1].trim();
  return null;
}

export async function loadCustomerQuotes(db: Db, topic: string, limit = 2): Promise<CustomerQuote[]> {
  try {
    const topicWords = topic.replace(/-/g, " ").split(/\s+/).filter((w) => w.length > 3);
    if (topicWords.length === 0) return [];

    const fills = rows<{ id: string; customer_name: string | null; html_rendered: string | null }>(
      await db.execute(sql`
        SELECT id, customer_name, html_rendered
        FROM agnb.filled_assets
        ORDER BY created_at DESC
        LIMIT 50
      `),
    );

    const quotes: CustomerQuote[] = [];
    for (const f of fills) {
      if (!f.html_rendered || !f.customer_name) continue;
      const q = extractQuote(f.html_rendered);
      if (!q) continue;
      const haystack = (q + " " + f.customer_name).toLowerCase();
      const matches = topicWords.some((w) => haystack.includes(w.toLowerCase()));
      if (!matches) continue;
      quotes.push({ customer: f.customer_name, quote: q, asset_kind: "filled_asset", source_fill_id: f.id });
      if (quotes.length >= limit) break;
    }
    return quotes;
  } catch {
    return [];
  }
}
